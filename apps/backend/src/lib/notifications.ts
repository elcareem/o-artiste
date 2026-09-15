/**
 * Notification dispatch — the seam #38 fills in.
 *
 * #22 needs to send a check-in code by SMS before #38 exists, so the transport
 * lives behind this module from the start. Every caller is written against the
 * final interface; #38 replaces the body of `sendSms` with a Termii call and
 * nothing else changes.
 *
 * IT LOGS AND SUCCEEDS RATHER THAN THROWING. A stub that threw would make every
 * scheduled job fail and dead-letter, which would bury the real behaviour under
 * noise and make #22's job log — the thing its acceptance criterion asks to be
 * verified in — unreadable.
 *
 * `delivered: false` is returned so a caller can tell a stubbed send from a real
 * one, and so #38's own tests have something to assert against.
 */

const SMS_ENABLED: boolean = process.env.SMS_API_KEY ? true : false;

/**
 * Sends an SMS.
 */
async function sendSms({ to, message, reference }: SmsRequest): Promise<SmsResult> {
  if (!to) throw new Error('sendSms requires a destination number');
  if (!message) throw new Error('sendSms requires a message');

  if (!SMS_ENABLED) {
    // The number is masked even here. Logs get shipped to third parties, and a
    // phone number is personal data under the NDPR whether or not it is
    // convenient to have in full.
    console.log(
      `[notifications] SMS (stubbed, #38 not yet implemented) → ${maskPhone(to)}` +
        `${reference ? ` [${reference}]` : ''}: ${message}`
    );
    return { delivered: false, stubbed: true, to: maskPhone(to), segments: segmentsFor(message) };
  }

  // #38 replaces this with the provider call.
  throw new Error('SMS_API_KEY is set but no SMS provider is implemented yet (#38).');
}

/** `+2348012345678` → `+234801***5678`. */
function maskPhone(phone: string): string {
  const value = String(phone);
  if (value.length <= 8) return '***';
  return `${value.slice(0, 7)}***${value.slice(-4)}`;
}

/** Segment count at the GSM-7 boundary, so cost is visible in the log. */
function segmentsFor(message: string): number {
  return Math.ceil(message.length / 160) || 1;
}

module.exports = { sendSms, maskPhone, segmentsFor, SMS_ENABLED };
