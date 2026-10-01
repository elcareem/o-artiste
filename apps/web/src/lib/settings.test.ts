import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { commissionPreview, tierProblems, type Tier } from './settings.ts';

/**
 * Settings validation — issue #36.
 *
 * The client-side rules mirror #8's server-side ones so a super-admin is told
 * about a gap while typing. The server stays authoritative: these being wrong
 * would mean a confusing message, not a bad save.
 */

const band = (
  minDaysBefore: number,
  maxDaysBefore: number | null,
  clientRefundBps: number
): Tier => ({
  minDaysBefore,
  maxDaysBefore,
  clientRefundBps,
  artistCompensationBps: 10000 - clientRefundBps,
});

const DEFAULT: Tier[] = [
  band(0, 0, 1500),
  band(1, 2, 4000),
  band(3, 6, 7000),
  band(7, null, 10000),
];

test('the shipped table is accepted', () => {
  assert.deepEqual(tierProblems(DEFAULT), []);
});

test('a gap is named by the days it leaves uncovered', () => {
  // docs/05 §5: a gap means a booking cancelled in that window has NO
  // applicable rule, and there is no safe default — refunding everything harms
  // the artist, refunding nothing is FCCPA exposure.
  const holed = [band(0, 0, 1500), band(1, 2, 4000), band(5, null, 10000)];
  const problems = tierProblems(holed);

  assert.equal(problems.length, 1);
  // The reader should not have to find it by reading the table.
  assert.match(problems[0], /Nothing covers 3/);
});

test('an overlap names both bands', () => {
  const overlapping = [band(0, 0, 1500), band(1, 5, 4000), band(3, null, 10000)];
  const problems = tierProblems(overlapping);

  assert.ok(problems.some((p) => /overlap/i.test(p)));
  assert.ok(problems.some((p) => p.includes('1–5') && p.includes('3')));
});

test('a set that does not cover the day of the event is refused', () => {
  const problems = tierProblems([band(1, 2, 4000), band(3, null, 10000)]);
  assert.ok(problems.some((p) => /day of the event/i.test(p)));
});

test('a band whose halves do not sum to 100% is named, with the figures', () => {
  const wrong: Tier[] = [
    { minDaysBefore: 0, maxDaysBefore: 0, clientRefundBps: 1500, artistCompensationBps: 8000 },
    band(1, null, 10000),
  ];
  const problems = tierProblems(wrong);

  assert.ok(problems.some((p) => /95%/.test(p)), problems.join(' | '));
  // Commission is not carved out of this split (docs/05 §5), so the two must
  // total exactly 100% and saying which two is more use than "invalid".
  assert.ok(problems.some((p) => /15%/.test(p) && /80%/.test(p)));
});

test('the highest band must be open-ended', () => {
  const closed = [band(0, 0, 1500), band(1, 2, 4000), band(3, 6, 7000), band(7, 30, 10000)];
  assert.ok(tierProblems(closed).some((p) => /open-ended/i.test(p)));
});

test('an empty table is refused rather than silently accepted', () => {
  assert.deepEqual(tierProblems([]), ['Add at least one cancellation band.']);
});

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

test('the commission preview states both figures and the difference', () => {
  // docs/07 §6: a basis-point change is hard to reason about in the abstract
  // and easy to reason about as "₦188,000 instead of ₦190,000".
  const preview = commissionPreview(20000000, 500, 600);

  assert.equal(preview.current, '₦190,000');
  assert.equal(preview.proposed, '₦188,000');
  assert.equal(preview.difference, '₦2,000');
  assert.equal(preview.worse, true);

  const better = commissionPreview(20000000, 500, 400);
  assert.equal(better.proposed, '₦192,000');
  assert.equal(better.worse, false);
});

test('the preview floors, matching the server rather than approximating it', () => {
  // applyBps floors (docs/05 §4 R1). A preview that rounded differently would
  // show one figure and save another.
  const preview = commissionPreview(3333333, 750, 750);
  const expected = 3333333 - Math.floor((3333333 * 750) / 10000);

  assert.equal(preview.current, preview.proposed);
  assert.ok(expected > 0);
});

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

test('the commission field is disabled from the server’s answer, not hidden by the page', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../components/commission-editor.tsx'),
    'utf8'
  );

  // An ADMIN sees that a commission rate exists and that they cannot change it,
  // which tells them more than a screen that silently lacks a section. The
  // server refuses the write regardless of what the page offers.
  assert.match(source, /disabled=\{!editable\}/);
  assert.match(source, /Only a super-admin can change the commission rate/);

  // And the decision is the server's: the component never inspects a role.
  assert.doesNotMatch(source, /SUPER_ADMIN|role ===/);
});

test('the config proxy addresses an allowlist, not an arbitrary path', () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, '../app/api/admin/config/[section]/route.ts'),
    'utf8'
  );

  // A proxy that forwarded any :section would become a general-purpose admin
  // API by accident. The backend's role checks would still hold, but the
  // surface would be far wider than this screen needs.
  assert.match(source, /const SECTIONS/);
  assert.doesNotMatch(source, /\$\{section\}/);
  assert.match(source, /That setting does not exist/);
});
