/**
 * Check-in code generation — docs/04-CONFIRMATION-AND-DISPUTES.md §1, issue #22.
 *
 * THE DIRECTION IS THE WHOLE MECHANISM. The code is issued to the CLIENT, and
 * the artist must obtain it from them in person. A code the artist could
 * retrieve from their own portal would prove nothing about attendance — they
 * could redeem it from home. The artist holding the code is only possible if the
 * client handed it over, and the client is only there to hand it over at the
 * event.
 *
 * Everything else here follows from that: there is no API path that returns the
 * code to an artist, `publicBooking()` never carries it, and the reader for it
 * is restricted to the booking's own client.
 */

const crypto = require('node:crypto');
const QRCode = require('qrcode');

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');

/**
 * The code alphabet — Crockford base32 without the ambiguous characters.
 *
 * `0`/`O`, `1`/`I`/`L` and `U` are excluded. This gets read aloud across a noisy
 * room and typed by someone holding a phone in one hand; a code that is secure
 * but mis-transcribed produces an artist who cannot check in, which is a worse
 * failure than the one the entropy was protecting against.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Eight characters, shown as two groups of four.
 *
 * 30^8 ≈ 6.6e11. Six characters (6.6e8) would also resist a live attacker, but
 * the cost of the extra two is one more syllable group to read aloud and the
 * benefit is that the code stays safe even if redemption attempts are never
 * rate-limited. Cheap insurance on the side that matters.
 */
const CODE_LENGTH = 8;

/** Hours before the event start that the code becomes redeemable. */
const WINDOW_BEFORE_HOURS: number = numberFromEnv('CHECKIN_WINDOW_BEFORE_HOURS', 2);

/** Hours after the event end that it stops being redeemable. */
const WINDOW_AFTER_HOURS: number = numberFromEnv('CHECKIN_WINDOW_AFTER_HOURS', 12);

/** How long before the event the SMS goes out. */
const SMS_LEAD_HOURS: number = numberFromEnv('CHECKIN_CODE_SMS_LEAD_HOURS', 24);

/**
 * A cryptographically random code.
 *
 * `crypto.randomInt` rather than `randomBytes` and a modulo: 256 is not a
 * multiple of 30, so `randomBytes()[i] % 30` would make the first sixteen
 * characters of the alphabet measurably more likely than the rest. The bias is
 * small and it is also completely avoidable.
 */
function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return code;
}

/** `K7QXM2F9` → `K7QX-M2F9`. Storage keeps the bare form; display adds the dash. */
function formatCode(code: string | null | undefined): string | null {
  if (!code || code.length !== CODE_LENGTH) return code ?? null;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Accepts either form, and is forgiving about case and spacing. */
function normaliseCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

/** The validity window around an event — docs/04 §1. */
function windowFor({ eventDate, eventEndAt }: CheckInWindowInput): CheckInWindow {
  const start = new Date(eventDate);
  const end = new Date(eventEndAt ?? eventDate);

  return {
    validFrom: new Date(start.getTime() - WINDOW_BEFORE_HOURS * 3600_000),
    validTo: new Date(end.getTime() + WINDOW_AFTER_HOURS * 3600_000),
  };
}

/**
 * Issues the code for a booking, inside the caller's transaction.
 *
 * Called when funding lands (#20), which is the first moment the event is
 * certain enough to be worth telling anyone about. Idempotent: a booking that
 * already has a code keeps it, so a webhook retry cannot invalidate a code the
 * client has already been sent.
 */
async function issueForBooking(tx: PrismaTx, booking: BookingRow): Promise<IssuedCheckInCode> {
  if (booking.checkInCode) {
    return {
      code: booking.checkInCode,
      validFrom: booking.checkInCodeValidFrom,
      validTo: booking.checkInCodeValidTo,
      issued: false,
    };
  }

  const code = generateCode();
  const { validFrom, validTo } = windowFor(booking);

  await tx.booking.update({
    where: { id: booking.id },
    data: { checkInCode: code, checkInCodeValidFrom: validFrom, checkInCodeValidTo: validTo },
  });

  return { code, validFrom, validTo, issued: true };
}

/**
 * The code, for the booking's own client.
 *
 * A request from anyone else — the artist included — gets 404 rather than 403.
 * A 403 confirms the resource exists, and "this booking has a check-in code and
 * you may not see it" is itself worth nothing to a client and something to an
 * artist probing for one.
 */
async function codeForClient({ bookingId, userId }: CheckInCodeRequest): Promise<CheckInCodeView> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { client: true, checkIn: true },
  });

  if (!booking || booking.client.userId !== userId) {
    throw new AppError(404, 'Booking not found.');
  }

  if (!booking.checkInCode) {
    throw new AppError(
      409,
      'Your check-in code will appear here once your payment has been received.'
    );
  }

  const status = validityOf(booking);

  return {
    bookingId: booking.id,
    code: formatCode(booking.checkInCode) as string,
    qrDataUrl: await qrDataUrlFor(booking.checkInCode),
    validFrom: booking.checkInCodeValidFrom,
    validTo: booking.checkInCodeValidTo,
    ...status,
  };
}

/**
 * Whether the code may be redeemed right now, and why not if it may not.
 *
 * Returned to the client as well as used by #23, so the portal can say "this
 * becomes active two hours before your event" rather than showing a code that
 * silently fails at the door.
 */
function validityOf(booking: RedeemableBooking, now: Date = new Date()): CheckInValidity {
  if (booking.checkIn) {
    return { valid: false, reason: 'already_redeemed', message: 'This code has already been used.' };
  }
  if (booking.checkInCodeValidFrom && now < booking.checkInCodeValidFrom) {
    return {
      valid: false,
      reason: 'too_early',
      message: 'This code becomes active shortly before your event starts.',
    };
  }
  if (booking.checkInCodeValidTo && now > booking.checkInCodeValidTo) {
    return {
      valid: false,
      reason: 'expired',
      message: 'This code has expired.',
    };
  }
  return { valid: true, reason: null, message: null };
}

/**
 * The string a QR encodes.
 *
 * The bare code, not a URL. A URL would make the QR scannable by any camera app
 * into something that looks actionable, and would leak the code into browser
 * history, referrer headers and any scanner's telemetry. The artist's app reads
 * it and submits it to #23; nothing else should be able to do anything with it.
 */
function qrPayloadFor(code: string): string {
  return normaliseCode(code);
}

/**
 * The QR as a data URL, rendered server-side.
 *
 * Rendered here rather than in the browser so the code never has to be handed
 * to a third-party script or a QR web service. `errorCorrectionLevel: 'M'`
 * tolerates a scuffed phone screen at a badly lit venue; 'H' would survive more
 * but makes the symbol denser, which is the wrong trade on a small display.
 */
async function qrDataUrlFor(code: string): Promise<string> {
  return QRCode.toDataURL(qrPayloadFor(code), {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  });
}

/** The SMS body. One segment, so it costs one message. */
function smsBodyFor({ code, artistName }: { code: string; artistName?: string | null }): string {
  return (
    `Your o-artiste check-in code is ${formatCode(code)}. ` +
    `Give it to ${artistName || 'your artist'} when they arrive. Do not share it before then.`
  );
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of hours, received: ${raw}`);
  }
  return value;
}

module.exports = {
  generateCode,
  formatCode,
  normaliseCode,
  windowFor,
  issueForBooking,
  codeForClient,
  validityOf,
  qrPayloadFor,
  qrDataUrlFor,
  smsBodyFor,
  ALPHABET,
  CODE_LENGTH,
  WINDOW_BEFORE_HOURS,
  WINDOW_AFTER_HOURS,
  SMS_LEAD_HOURS,
};
