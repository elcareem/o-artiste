/**
 * Notification transport — issue #38.
 *
 * Two providers, one rule each about failure, and the distinction between them
 * is the whole design:
 *
 *   NOT CONFIGURED → log, return `stubbed: true`, SUCCEED. A deployment without
 *   an SMS key is degraded, not broken, and the alternative is every scheduled
 *   job failing and dead-lettering until someone adds a key — which buries the
 *   real failures under noise. This is the same reasoning as the DEGRADED banner
 *   in `requiredEnv.ts`.
 *
 *   CONFIGURED AND FAILING → THROW. The job queue retries it and a permanently
 *   failed send lands in the dead-letter queue where it can be seen. Swallowing
 *   this would mean a client never receives a check-in code and nothing anywhere
 *   records that.
 *
 * Neither case is ever allowed to reach a money path. Callers go through
 * `notificationService`, which enqueues; nothing here is called inside a
 * transaction.
 */

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Termii, named in DEPLOYMENT-CHECKLIST. The base URL is configurable so a
 * different provider accepting the same shape can be pointed at it without a
 * code change — but the SHAPE is Termii's, and swapping to a provider with a
 * different body means editing this file, not just an env var.
 */
const SMS_BASE_URL = process.env.SMS_BASE_URL || 'https://api.ng.termii.com';
const EMAIL_BASE_URL = process.env.EMAIL_BASE_URL || 'https://api.resend.com';

/**
 * Whether each channel can actually send.
 *
 * Read through functions rather than captured at module load, because the test
 * suite sets and unsets these around individual cases, and a constant evaluated
 * at require time would make the configured path untestable.
 */
function smsEnabled(): boolean {
  return Boolean(process.env.SMS_API_KEY && process.env.SMS_SENDER_ID);
}

function emailEnabled(): boolean {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

/**
 * An SMS key without a sender id is worth saying out loud.
 *
 * Termii rejects every message sent from an unregistered sender, so this
 * combination is not "partly configured" — it is a channel that will fail on
 * every send while looking configured. Reported rather than silently treated as
 * disabled.
 */
function configProblems(): string[] {
  const problems: string[] = [];
  if (process.env.SMS_API_KEY && !process.env.SMS_SENDER_ID) {
    problems.push('SMS_API_KEY is set but SMS_SENDER_ID is not — every message would be rejected.');
  }
  if (process.env.SMS_SENDER_ID && !process.env.SMS_API_KEY) {
    problems.push('SMS_SENDER_ID is set but SMS_API_KEY is not — no messages can be sent.');
  }
  if (process.env.EMAIL_API_KEY && !process.env.EMAIL_FROM) {
    problems.push('EMAIL_API_KEY is set but EMAIL_FROM is not — every email would be rejected.');
  }
  return problems;
}

/**
 * Normalises a Nigerian number to the international form the provider wants.
 *
 * `08012345678` and `+2348012345678` are the same number, and which one is
 * stored depends on what a user typed at registration. Sending the local form to
 * Termii is a silent non-delivery.
 */
function normalisePhone(phone: string): string {
  const digits = String(phone).replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('234')) return `+${digits}`;
  // A leading zero is the national trunk prefix; it is replaced by the country
  // code, not prepended to it.
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  return `+234${digits}`;
}

/** `+2348012345678` → `+234801***5678`. */
function maskPhone(phone: string): string {
  const value = String(phone);
  if (value.length <= 8) return '***';
  return `${value.slice(0, 7)}***${value.slice(-4)}`;
}

/** `ada@example.com` → `a***@example.com`. */
function maskEmail(email: string): string {
  const value = String(email);
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

/** Segment count at the GSM-7 boundary, so cost is visible in the log. */
function segmentsFor(message: string): number {
  return Math.ceil(message.length / 160) || 1;
}

/**
 * Whether a failed send is worth retrying.
 *
 * A 4xx from the provider is our mistake — a malformed number, an unregistered
 * sender, an invalid key — and retrying it produces the same rejection three
 * more times before dead-lettering. A 5xx or a network failure is theirs and
 * will likely succeed later.
 */
function isRetryable(status: number | null): boolean {
  if (status === null) return true;
  // 429 is the exception among 4xx: we are being told to slow down, not that
  // the request is wrong.
  if (status === 429) return true;
  return status >= 500;
}

class NotificationError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
    this.retryable = isRetryable(status);
  }
}

/**
 * Sends an SMS.
 *
 * The message body is NEVER logged on the configured path. A check-in code in an
 * application log is a check-in code available to anyone with log access, which
 * defeats the mechanic it exists to protect (docs/04 §2).
 */
async function sendSms({ to, message, reference }: SmsRequest): Promise<SmsResult> {
  if (!to) throw new Error('sendSms requires a destination number');
  if (!message) throw new Error('sendSms requires a message');

  const destination = normalisePhone(to);
  const masked = maskPhone(destination);
  const segments = segmentsFor(message);

  if (!smsEnabled()) {
    for (const problem of configProblems()) console.warn(`[notifications] ${problem}`);
    // The body IS logged here, because there is no other way to see what would
    // have been sent on a deployment with no provider — and on such a
    // deployment nothing real is being protected.
    console.log(
      `[notifications] SMS not configured, would have sent → ${masked}` +
        `${reference ? ` [${reference}]` : ''}: ${message}`
    );
    return { delivered: false, stubbed: true, to: masked, segments };
  }

  let response;
  try {
    response = await axios.post(
      `${SMS_BASE_URL}/api/sms/send`,
      {
        api_key: process.env.SMS_API_KEY,
        to: destination,
        from: process.env.SMS_SENDER_ID,
        sms: message,
        type: 'plain',
        channel: 'generic',
      },
      { timeout: Number(process.env.SMS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        validateStatus: () => true }
    );
  } catch (err) {
    // No response at all. Retryable, and the key is never in the message.
    throw new NotificationError(
      `SMS provider unreachable: ${(err as Error).message}`,
      null
    );
  }

  if (response.status >= 400) {
    throw new NotificationError(
      `SMS provider rejected the message for ${masked} with ${response.status}: ` +
        `${describeProviderError(response.data)}`,
      response.status
    );
  }

  console.log(`[notifications] SMS sent → ${masked}${reference ? ` [${reference}]` : ''}, ${segments} segment(s)`);

  return {
    delivered: true,
    stubbed: false,
    to: masked,
    segments,
    providerId: response.data?.message_id ?? response.data?.id ?? null,
  };
}

/**
 * Sends an email.
 *
 * Same two-case failure rule as SMS. The body is not logged either way — these
 * carry money figures and names.
 */
async function sendEmail({
  to,
  subject,
  body,
  reference,
}: {
  to: string;
  subject: string;
  body: string;
  reference?: string;
}): Promise<EmailResult> {
  if (!to) throw new Error('sendEmail requires a destination address');
  if (!subject) throw new Error('sendEmail requires a subject');
  if (!body) throw new Error('sendEmail requires a body');

  const masked = maskEmail(to);

  if (!emailEnabled()) {
    for (const problem of configProblems()) console.warn(`[notifications] ${problem}`);
    console.log(
      `[notifications] email not configured, would have sent → ${masked}` +
        `${reference ? ` [${reference}]` : ''}: ${subject}`
    );
    return { delivered: false, stubbed: true, to: masked };
  }

  let response;
  try {
    response = await axios.post(
      `${EMAIL_BASE_URL}/emails`,
      { from: process.env.EMAIL_FROM, to: [to], subject, text: body },
      {
        timeout: Number(process.env.EMAIL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${process.env.EMAIL_API_KEY}` },
        validateStatus: () => true,
      }
    );
  } catch (err) {
    throw new NotificationError(`Email provider unreachable: ${(err as Error).message}`, null);
  }

  if (response.status >= 400) {
    throw new NotificationError(
      `Email provider rejected the message for ${masked} with ${response.status}: ` +
        `${describeProviderError(response.data)}`,
      response.status
    );
  }

  console.log(`[notifications] email sent → ${masked}${reference ? ` [${reference}]` : ''}: ${subject}`);

  return { delivered: true, stubbed: false, to: masked, providerId: response.data?.id ?? null };
}

/**
 * The provider's own complaint, without leaking our credentials.
 *
 * Termii echoes the request back in some error bodies, and that request contains
 * `api_key`. Stringifying the whole body into a log is how a key ends up in a
 * log aggregator.
 */
function describeProviderError(data: unknown): string {
  if (data === null || data === undefined) return 'no detail';
  if (typeof data === 'string') return redactKeys(data);

  const record = data as Record<string, unknown>;
  const message = record.message ?? record.error ?? record.detail;
  if (typeof message === 'string') return redactKeys(message);

  return 'no usable detail';
}

function redactKeys(text: string): string {
  return String(text)
    .replace(/(api_?key"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
}

module.exports = {
  sendSms,
  sendEmail,
  smsEnabled,
  emailEnabled,
  configProblems,
  normalisePhone,
  maskPhone,
  maskEmail,
  segmentsFor,
  isRetryable,
  NotificationError,
  // Kept for the callers written against the stub in #22. `SMS_ENABLED` was a
  // constant there; it is a function now, because the value can change within a
  // process and a constant made the configured path untestable.
  SMS_ENABLED: smsEnabled,
};
