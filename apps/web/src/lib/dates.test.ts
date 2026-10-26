/** Lagos time, whatever the machine — issue #45. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { formatLagos } from './dates.ts';

// 18:00 UTC is 7pm in Lagos (UTC+1, no daylight saving).
const INSTANT = '2026-10-03T18:00:00.000Z';

test('an evening event reads as Lagos time', () => {
  assert.match(formatLagos(INSTANT, 'dateTime') as string, /Saturday 3 October.*7:00 pm/);
  assert.match(formatLagos(INSTANT, 'time') as string, /^7:00 pm$/);
});

test('the same instant renders identically on machines in different timezones', () => {
  // Run in child processes, because TZ is read once at startup: setting it
  // inside this process would prove nothing. Render runs in UTC; a developer
  // or a browser may be anywhere.
  const script = `import('${path.resolve(import.meta.dirname, 'dates.ts')}').then(m => console.log(m.formatLagos('${INSTANT}', 'dateTime')))`;
  const outputs = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Africa/Lagos'].map((tz) =>
    execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim()
  );
  assert.equal(new Set(outputs).size, 1, `rendered differently: ${outputs.join(' | ')}`);
  assert.match(outputs[0], /7:00 pm/);
});

test('the date rolls over at Lagos midnight, not UTC midnight', () => {
  // 23:30 UTC on the 3rd is 00:30 on the 4th in Lagos.
  assert.match(formatLagos('2026-10-03T23:30:00.000Z', 'date') as string, /Sunday 4 October/);
});

test('a missing or unreadable value is null, never "Invalid Date"', () => {
  for (const v of [null, undefined, '', 'not a date']) assert.equal(formatLagos(v as string, 'date'), null);
});

test('one spelling of am and pm', () => {
  assert.doesNotMatch(formatLagos(INSTANT, 'time') as string, /PM/);
});
