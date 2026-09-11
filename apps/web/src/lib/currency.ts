/**
 * Currency display — docs/00-OVERVIEW.md §6.
 *
 * All money in this system is integer kobo: in the database, in service code,
 * and in every API payload. Naira exists in exactly one place — here, at the
 * moment a number is shown to a person.
 *
 * This module is deliberately one-way. There is no naira-to-kobo helper, and
 * one must not be added: parsing a user-entered amount is a backend concern,
 * and putting a parser here would create a second place where money changes
 * representation. Every such place is somewhere a rounding bug can live.
 */

const KOBO_PER_NAIRA = 100;

// Grouping only — no `style: 'currency'`. The currency style emits
// "₦200,000.00", and trailing ".00" on every price is noise on a rate card.
// The symbol is prefixed manually so the output is exactly what we intend.
const WHOLE = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const WITH_KOBO = new Intl.NumberFormat('en-NG', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats an integer kobo amount as a Naira display string.
 *
 *   formatNaira(20000000) === '₦200,000'
 *   formatNaira(0)        === '₦0'
 *   formatNaira(123456)   === '₦1,234.56'
 *   formatNaira(-50000)   === '-₦500'
 *
 * Whole Naira amounts render without decimals; an amount carrying kobo renders
 * to two places, so a figure is never silently rounded away from what the
 * ledger holds.
 *
 * @param kobo Integer kobo. 1 NGN = 100 kobo.
 * @throws TypeError if given a non-integer, NaN, or Infinity.
 */
export function formatNaira(kobo: number): string {
  if (!Number.isInteger(kobo)) {
    // Loud on purpose. Every amount reaching this function comes from our own
    // API, which guarantees kobo integers. A float or NaN arriving here is a
    // contract violation somewhere upstream, and rendering "₦0" or "₦NaN" for
    // a real amount would hide a money bug behind something that looks fine.
    throw new TypeError(
      `formatNaira expects an integer number of kobo, received: ${String(kobo)}`
    );
  }

  const negative = kobo < 0;
  const absolute = Math.abs(kobo);

  const naira = Math.trunc(absolute / KOBO_PER_NAIRA);
  const remainder = absolute % KOBO_PER_NAIRA;

  const formatted =
    remainder === 0
      ? WHOLE.format(naira)
      : WITH_KOBO.format(naira + remainder / KOBO_PER_NAIRA);

  return `${negative ? '-' : ''}₦${formatted}`;
}
