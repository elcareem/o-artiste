/**
 * Naira typed by a person, into exact kobo — issue #44.
 *
 * THE ONE PLACE money moves from a person's notation into the system's. #3
 * deliberately shipped no naira→kobo helper, because the obvious one —
 * `Math.round(parseFloat(x) * 100)` — runs money through a float, and
 * `0.29 * 100` is `28.999999999999996`. An artist typing a rate needs one, so
 * this is that helper done the only safe way: the text is split at the decimal
 * point and each half is read as an integer. No float ever holds the amount.
 *
 * It is strict on purpose. A third decimal place is refused rather than
 * rounded — it is a typo, and rounding it silently changes a figure someone
 * meant precisely.
 */

export type ParsedNaira = { ok: true; kobo: number } | { ok: false; problem: string };

export function parseNairaToKobo(raw: string, label = 'The amount'): ParsedNaira {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(₦|NGN|N)\s*/i, '')
    .replace(/\s/g, '');

  if (text.length === 0) return { ok: false, problem: `${label} is needed.` };
  if (text.startsWith('-')) return { ok: false, problem: `${label} cannot be negative.` };

  // Digits, optionally grouped in threes by commas, then up to two decimals.
  const match = text.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    if (/\.\d{3,}$/.test(text)) {
      return { ok: false, problem: `${label} can have at most two decimal places — kobo.` };
    }
    return { ok: false, problem: `Enter ${label.toLowerCase()} in naira, like 200,000.` };
  }

  const whole = match[1].replace(/,/g, '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const kobo = Number(whole) * 100 + Number(fraction);

  if (!Number.isSafeInteger(kobo)) return { ok: false, problem: `${label} is too large.` };
  return { ok: true, kobo };
}

/**
 * Kobo back into the form a person would type, to pre-fill a field:
 * 20000050 → "200000.50", 20000000 → "200000". Integer arithmetic, like above.
 */
export function koboToNairaInput(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined || !Number.isInteger(kobo) || kobo < 0) return '';
  const whole = Math.trunc(kobo / 100);
  const remainder = kobo % 100;
  return remainder === 0 ? String(whole) : `${whole}.${String(remainder).padStart(2, '0')}`;
}
