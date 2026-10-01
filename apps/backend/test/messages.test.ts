/**
 * Notification copy — issue #38.
 *
 * The copy is where #38's requirements actually live: "the confirmation prompt
 * must state the auto-release deadline" is a claim about a sentence. Pure
 * functions, so no provider, queue or database is involved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const messages = require('../src/lib/messages.ts');

const N = (naira: number) => naira * 100;

// ---------------------------------------------------------------------------
// Criterion: the confirmation prompt names the exact auto-release deadline
// ---------------------------------------------------------------------------

test('the confirmation prompt names the exact deadline', () => {
  // 2026-10-03T13:00:00Z is 2pm in Lagos (UTC+1, no DST).
  const message = messages.confirmationPromptSms({
    artistName: 'Burna Boy',
    autoReleaseAt: '2026-10-03T13:00:00.000Z',
  });

  assert.match(message, /Saturday 3 October/);
  assert.match(message, /2:00 pm/);

  // And it says what happens if they do nothing. A deadline with no stated
  // consequence is a date, not a warning.
  assert.match(message, /released automatically/i);
  assert.match(message, /Burna Boy/);
});

test('the deadline is rendered in Lagos time, not the server\'s', () => {
  // THE SAME INSTANT, and it must read as Lagos time whatever TZ the process
  // runs in. A client told "13:00" when their phone says 14:00 has been told the
  // wrong time, and a deadline that moves when we change hosts is worse.
  const saved = process.env.TZ;
  const instant = '2026-10-03T13:00:00.000Z';

  try {
    const rendered: string[] = [];
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      rendered.push(messages.formatDeadline(instant));
    }
    assert.equal(new Set(rendered).size, 1, `rendered differently per TZ: ${rendered.join(' | ')}`);
    assert.match(rendered[0], /2:00 pm/);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('the deadline includes the weekday', () => {
  // "3 October at 2:00 pm" makes the reader work out whether that is tomorrow.
  // A deadline they have to calculate is a deadline they will miss.
  assert.match(messages.formatDeadline('2026-10-03T13:00:00.000Z'), /^Saturday/);
});

test('an unusable deadline throws rather than rendering a plausible wrong one', () => {
  // `new Date(null)` is the EPOCH, not an error — so a missing deadline would
  // render as "Thursday 1 January, 1:00 am" with complete confidence. Absence
  // and unparseable are rejected separately so the message says which.
  for (const missing of ['', null, undefined]) {
    assert.throws(() => messages.formatDeadline(missing), /received no date/);
  }
  for (const unparseable of ['not a date', 'tomorrow', {}]) {
    assert.throws(() => messages.formatDeadline(unparseable), /unusable date/);
  }
});

test('midnight and noon do not come out as 0:00 or 12:00 am wrongly', () => {
  // 23:00Z is midnight in Lagos — the date must roll forward with it.
  assert.match(messages.formatDeadline('2026-10-03T23:00:00.000Z'), /Sunday 4 October, 12:00 am/);
  assert.match(messages.formatDeadline('2026-10-03T11:00:00.000Z'), /12:00 pm/);
});

// ---------------------------------------------------------------------------
// The figures, which are read next to a bank statement
// ---------------------------------------------------------------------------

test('a cancellation email states the exact figures', () => {
  const { subject, body } = messages.cancellationOutcomeEmail({
    recipient: 'CLIENT',
    clientName: 'Ada',
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    clientRefundKobo: N(80000),
    artistCompensationKobo: N(120000),
    cancelledBy: 'CLIENT',
  });

  assert.match(subject, /cancelled/i);
  assert.match(body, /₦200,000/);
  assert.match(body, /₦80,000/);
  assert.match(body, /₦120,000/);
  assert.match(body, /You cancelled/);
});

test('the same cancellation reads correctly from the artist\'s side', () => {
  const { body } = messages.cancellationOutcomeEmail({
    recipient: 'ARTIST',
    clientName: 'Ada',
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    clientRefundKobo: N(80000),
    artistCompensationKobo: N(120000),
    cancelledBy: 'CLIENT',
  });

  // "You cancelled this booking" to the artist, when the client cancelled,
  // would be telling them they did something they did not do.
  assert.match(body, /Ada cancelled/);
  assert.doesNotMatch(body, /You cancelled/);
  assert.match(body, /Paid to you: ₦120,000/);
});

test('a zero artist share says "nothing" rather than ₦0', () => {
  const { body } = messages.cancellationOutcomeEmail({
    recipient: 'ARTIST',
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    clientRefundKobo: N(200000),
    artistCompensationKobo: 0,
    cancelledBy: 'ARTIST',
  });
  assert.match(body, /Paid to you: nothing/);
});

test('a reclassified cancellation explains the unexpected credit', () => {
  const { body } = messages.cancellationOutcomeEmail({
    recipient: 'CLIENT',
    clientName: 'Ada',
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    clientRefundKobo: N(202000),
    artistCompensationKobo: 0,
    cancelledBy: 'ARTIST',
    reclassified: true,
  });

  // The client is receiving money they were told they would not get back. An
  // unexplained credit is as confusing as an unexplained charge.
  assert.match(body, /reversed in full/i);
  assert.match(body, /₦202,000/);
});

test('the payout email shows the commission as its own line', () => {
  const { subject, body } = messages.payoutConfirmedEmail({
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    commissionKobo: N(10000),
    netKobo: N(190000),
    accountHint: '4321',
  });

  assert.match(subject, /₦190,000/);
  // The artist agreed to a percentage. A single net figure asks them to take our
  // word for it.
  assert.match(body, /Booking value: ₦200,000/);
  assert.match(body, /commission: −₦10,000/);
  assert.match(body, /Paid to you: ₦190,000/);
  assert.match(body, /ending 4321/);
});

test('a payout with no knowable commission omits the line rather than guessing', () => {
  const { body } = messages.payoutConfirmedEmail({
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    commissionKobo: null,
    netKobo: N(90000),
  });

  // A dispute split: the artist's share was decided by a ruling, not a
  // percentage. Subtracting it from the booking value would present the client's
  // refund as our commission.
  assert.match(body, /Paid to you: ₦90,000/);
  assert.doesNotMatch(body, /commission/i);
  assert.match(body, /support decision/i);
});

test('the booking confirmation says who holds the money', () => {
  const { body } = messages.bookingConfirmedEmail({
    clientName: 'Ada',
    artistName: 'Burna Boy',
    amountKobo: N(200000),
    eventDate: '2026-10-03T18:00:00.000Z',
    eventLocation: 'Eko Hotel',
    checkInCodeHint: true,
  });

  // The question a client has after transferring ₦202,000 to an account they
  // have never seen before.
  assert.match(body, /licensed bank/i);
  assert.match(body, /not by us/i);
  assert.match(body, /Eko Hotel/);
  assert.match(body, /Saturday 3 October/);
  assert.match(body, /check-in code/i);
});

test('no message leaks an internal term or an enum', () => {
  const all = [
    messages.eventDaySms({ artistName: 'Burna Boy' }),
    messages.confirmationPromptSms({ artistName: 'Burna Boy', autoReleaseAt: new Date() }),
    messages.bookingConfirmedEmail({ amountKobo: N(1), eventDate: new Date() }).body,
    messages.cancellationOutcomeEmail({
      recipient: 'CLIENT',
      amountKobo: N(1),
      clientRefundKobo: 0,
      artistCompensationKobo: 0,
      cancelledBy: 'CLIENT',
    }).body,
    messages.disputeUpdateEmail({ recipient: 'CLIENT', stage: 'OPENED' }).body,
    messages.payoutConfirmedEmail({ amountKobo: N(1), commissionKobo: 0, netKobo: N(1) }).body,
  ];

  for (const text of all) {
    assert.doesNotMatch(text, /FUNDED_HELD|AWAITING_CONFIRMATION|PENDING_PAYMENT|RESOLVED_/, text);
    assert.doesNotMatch(text, /kobo|basis point|\bbps\b|escrowpay|webhook/i, text);
    // "escrow" is our word, not a client's.
    assert.doesNotMatch(text, /\bescrow\b/i, text);
  }
});

test('the event-day prompt does not repeat the code', () => {
  const message = messages.eventDaySms({ artistName: 'Burna Boy' });
  // A code resent on the day is a code in two messages, and the second is the
  // one that gets screenshotted and forwarded.
  assert.match(message, /have your/i);
  assert.doesNotMatch(message, /\b[A-Z0-9]{6}\b/);
});

test('a missing artist name degrades to something sayable', () => {
  // Never "undefined performs today".
  for (const name of [null, undefined, '']) {
    const sms = messages.eventDaySms({ artistName: name });
    assert.doesNotMatch(sms, /undefined|null/);
    assert.match(sms, /Your artist performs today/);
  }
});
