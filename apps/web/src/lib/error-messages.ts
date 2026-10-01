/**
 * Failure copy, in one place — issue #39.
 *
 * THE BACKEND OWNS MOST OF IT. Every API error is `{ "error": "..." }` and that
 * string is written for a person (docs/02 §2); the UI renders it unaltered.
 * Rewording it here would produce two divergent sets of copy for one condition,
 * and the backend's version is the one that knows what actually happened.
 *
 * So this module owns the three cases the backend cannot speak to:
 *
 *   1. The request never arrived. There is no `error` string because there was
 *      no response.
 *   2. A response arrived with nothing usable in it — a proxy error page, a
 *      truncated body, an unhandled 500.
 *   3. Client-side validation, which exists so a user is told at the point of
 *      typing rather than by a rejected submission that loses the form.
 *
 * And it owns one guarantee that has to hold everywhere: NOTHING RENDERED HERE
 * IS A STACK TRACE, AN EXCEPTION OBJECT OR AN HTTP STATUS CODE. A user who sees
 * `500` on a payment screen does not think "transient bug", they think their
 * money is gone.
 */

/**
 * What happened to the money.
 *
 * REQUIRED, not optional, and that is the whole design of this function. Every
 * failure on a money screen has to say what state the money is in, and making
 * the caller pass it means a new call site cannot quietly omit the reassurance —
 * it will not compile.
 *
 * "Could not reach the server" alone is the message that makes someone phone
 * their bank.
 */
export function unreachable(reassurance: string): string {
  return `Could not reach the server. ${reassurance}`;
}

/**
 * What to say when nothing was being changed in the first place.
 *
 * A failed READ has no money consequence to report, so the reassurance is an
 * instruction instead. It still goes through `unreachable` so there is one
 * source for the first half of the sentence.
 */
export const RETRY = 'Check your connection and try again.';

/** The reassurances in use, so the wording does not drift between screens. */
export const NOTHING = {
  changed: 'Nothing has changed.',
  charged: 'You have not been charged.',
  cancelled: 'Nothing has been cancelled.',
  decided: 'Nothing has been decided.',
  saved: 'Nothing has been saved.',
  sent: 'Nothing has been sent.',
  moved: 'No money has moved.',
  recorded: 'The check-in was not recorded.',
} as const;

/**
 * Anything that must never reach a screen.
 *
 * A backend that is working correctly never produces these — the unified error
 * shape is deliberate and every message is hand-written. But an unhandled
 * exception escaping a route, a reverse proxy's own error page, or a provider
 * SDK's message arriving unwrapped all would, and each is a path nobody tested
 * precisely because it is the path where something already went wrong.
 */
const LEAKS = [
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/,          // a stack frame
  /\b(?:Error|TypeError|ReferenceError|PrismaClient\w*)\b:/,
  // A status code, matched by CONTEXT rather than by its digits. `[45]\d\d`
  // alone would also reject "₦404 is below the minimum" and "500 kobo short of
  // the amount held", which are things real copy says — and a guard that eats
  // legitimate messages pushes callers back to inlining their own.
  /\b(?:HTTP|status(?:\s+code)?|code|returned|responded\s+with|failed\s+with)\s*:?\s*[45]\d\d\b/i,
  /^\s*[45]\d\d\b/,
  /\b[45]\d\d\s+(?:Forbidden|Unauthorized|Not\s+Found|Bad\s+(?:Gateway|Request)|Internal\s+Server\s+Error|Service\s+Unavailable|Conflict|Gateway\s+Timeout)\b/i,
  /\bundefined\b|\bnull\b|\[object Object\]/,
  /\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE)\b/,
  /\bprisma\b|\bsequelize\b|\bselect .* from \b/i,
  /\/(?:home|usr|var|app)\/\S+/,            // a filesystem path
];

/** Whether a string is safe to show someone. */
export function isPresentable(message: unknown): message is string {
  if (typeof message !== 'string') return false;

  const text = message.trim();
  if (text.length === 0) return false;
  // A message longer than this is not a sentence written for a person.
  if (text.length > 400) return false;

  return !LEAKS.some((pattern) => pattern.test(text));
}

/**
 * The message to show for a failed request.
 *
 * The backend's own words where they are usable, and the caller's fallback where
 * they are not. The fallback is required for the same reason `unreachable`'s
 * reassurance is: a screen with no fallback renders whatever arrives.
 */
export function failureMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: unknown } | null)?.error;
  return isPresentable(error) ? error : fallback;
}

/**
 * Turns a thrown value into something sayable.
 *
 * Used in the catch around a fetch. A `TypeError: Failed to fetch` means the
 * request never left, which is a different thing from a server that answered
 * badly — and the user can act on the first (check your connection) in a way
 * they cannot act on the second.
 */
export function thrownMessage(err: unknown, reassurance: string): string {
  void err; // Deliberately unread — see the module note on leaks.
  return unreachable(reassurance);
}

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

/**
 * Inline messages for empty required fields.
 *
 * Per field, not one summary. #39's first criterion is that an empty form shows
 * inline messages rather than a generic alert, and the difference is whether the
 * user has to work out WHICH field they missed.
 */
export function missingFields(
  fields: Record<string, { value: unknown; label: string }>
): Record<string, string> {
  const problems: Record<string, string> = {};

  for (const [name, { value, label }] of Object.entries(fields)) {
    const empty =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim().length === 0);

    // Named after the field as the label says it, so the message reads as part
    // of the form rather than as a system complaint.
    if (empty) problems[name] = `${label} is needed.`;
  }

  return problems;
}

/**
 * A whole number of kobo from a form field.
 *
 * `Number('')` is 0 and `Number(true)` is 1, so emptiness is checked first — a
 * blank field becoming ₦0 is the bug that turned a blank delay into "run now"
 * in #36.
 */
export function koboProblem(raw: string, label = 'Amount'): string | null {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return `${label} is needed.`;
  if (!/^\d+$/.test(text)) return `${label} must be a whole number of kobo, digits only.`;
  if (!Number.isSafeInteger(Number(text))) return `${label} is too large.`;
  return null;
}

export function emailProblem(raw: string): string | null {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return 'Your email is needed.';
  // Deliberately loose. A strict pattern rejects valid addresses, and the only
  // real test of an address is whether mail reaches it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'That does not look like an email address.';
  return null;
}

/**
 * Whether a reason is long enough to be a reason.
 *
 * Mirrors the backend's bar so someone is told while typing rather than by a
 * rejected submission. The backend stays authoritative.
 */
export function reasonProblem(raw: string, minimum = 10): string | null {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return 'A written reason is needed.';
  if (text.length < minimum) {
    return 'A little more detail — someone reading this in six months needs to understand it.';
  }
  return null;
}
