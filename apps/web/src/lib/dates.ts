/**
 * Dates and times, always in Lagos time — issue #45.
 *
 * Every page used to format with the RUNNING MACHINE's timezone. Server
 * components run on Render, in UTC, so an event at 7pm in Lagos rendered as
 * 6pm — on the check-in page an artist reads at the door, and in the check-in
 * timestamp an admin weighs when deciding a dispute. A client component then
 * re-rendered it in the browser's timezone, so one page could show two times.
 *
 * Pinned here, once, with no configuration: the platform operates in Nigeria,
 * and a time that changes with the host is a time nobody can rely on. The SMS
 * deadline (#38) is pinned the same way, so the two always agree.
 */

const ZONE = 'Africa/Lagos';

/**
 * Assembled from parts rather than taken from `Intl.format()`, which writes
 * "Saturday, 3 October at 7:00 pm" in one runtime and something else in the
 * next. Built by hand it reads the same everywhere — and the same as the SMS
 * deadline the backend sends (#38): "Saturday 3 October, 7:00 pm".
 */
export type DatePreset = 'date' | 'shortDate' | 'dateTime' | 'shortDateTime' | 'time';

/** `null` for a missing or unreadable value — callers decide what to show. */
export function formatLagos(value: Date | string | number | null | undefined, preset: DatePreset): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-NG', {
    timeZone: ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  const day = get('day');
  const month = get('month');
  const year = get('year');
  const time = `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase().replace(/\s/g, '')}`;

  switch (preset) {
    case 'date':
      return `${weekday} ${day} ${month} ${year}`;
    case 'shortDate':
      return `${day} ${month.slice(0, 3)} ${year}`;
    case 'dateTime':
      return `${weekday} ${day} ${month}, ${time}`;
    case 'shortDateTime':
      return `${day} ${month.slice(0, 3)} ${year}, ${time}`;
    case 'time':
      return time;
  }
}
