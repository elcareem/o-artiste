/**
 * Money helpers for the BACKEND.
 *
 * Money is kobo everywhere: database, services, API payloads. Naira exists only
 * for humans — and on the backend, only inside error copy that a person reads.
 *
 * This is NOT a general currency formatter and must not become one. The web
 * app's `formatNaira()` owns display; duplicating it here would create a second
 * place where money changes representation, and every such place is somewhere a
 * rounding bug can live. The one legitimate case is an error message that has
 * to name a limit, because "your rate must be between 2000000 and 300000000"
 * is not a sentence anyone can act on.
 */

const KOBO_PER_NAIRA = 100;

/**
 * Formats kobo as Naira for inclusion in an error message.
 *
 * @param {number} kobo Integer kobo.
 */
function formatNairaForMessage(kobo) {
  if (!Number.isInteger(kobo)) {
    throw new TypeError(`formatNairaForMessage expects integer kobo, received: ${String(kobo)}`);
  }

  const negative = kobo < 0;
  const absolute = Math.abs(kobo);
  const naira = Math.trunc(absolute / KOBO_PER_NAIRA);
  const remainder = absolute % KOBO_PER_NAIRA;

  const whole = naira.toLocaleString('en-NG');
  const body = remainder === 0 ? whole : `${whole}.${String(remainder).padStart(2, '0')}`;

  return `${negative ? '-' : ''}₦${body}`;
}

module.exports = { formatNairaForMessage, KOBO_PER_NAIRA };
