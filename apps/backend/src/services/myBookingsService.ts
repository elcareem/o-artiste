/**
 * A signed-in person's own bookings — issue #45.
 *
 * WHAT NEEDS THEIR ATTENTION IS DECIDED HERE, not by the page. "Is this booking
 * waiting on me?" depends on the state, the clock, the check-in window, both
 * confirmations and the terms acknowledgement — the same facts the backend uses
 * to accept or refuse each action. A page inferring it would be a second copy
 * of those rules, and the one that disagrees is the one a person acts on.
 *
 * `nextActionFor` and `groupFor` are pure, so they are tested without a
 * database.
 */

const prisma = require('../lib/prisma.ts');

type Role = 'CLIENT' | 'ARTIST';

type ActionFacts = {
  state: string;
  eventDate: Date | string;
  eventEndAt: Date | string | null;
  checkInCodeValidFrom?: Date | string | null;
  checkInCodeValidTo?: Date | string | null;
  clientConfirmedAt?: Date | string | null;
  artistConfirmedAt?: Date | string | null;
  autoReleaseAt?: Date | string | null;
  acknowledged: boolean;
};

export type NextAction = {
  code: 'ACCEPT_TERMS' | 'PAY' | 'CHECK_IN' | 'CONFIRM' | 'DISPUTE_OPEN';
  /** What the person should do, in their terms. */
  label: string;
  /** When silence decides it, where that applies — the client's confirmation. */
  deadline?: string | null;
};

const at = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : null);

/** The one thing waiting on this person, or null. */
function nextActionFor(b: ActionFacts, role: Role, now: Date = new Date()): NextAction | null {
  const t = now.getTime();
  const ended = (at(b.eventEndAt) ?? at(b.eventDate) ?? Infinity) <= t;

  if (b.state === 'DISPUTED') {
    // Both parties: the dispute is decided on what each of them says.
    return { code: 'DISPUTE_OPEN', label: 'Under dispute — add anything that helps explain what happened.' };
  }

  if (role === 'CLIENT') {
    if (b.state === 'PENDING_PAYMENT') {
      return b.acknowledged
        ? { code: 'PAY', label: 'Transfer the payment to confirm this booking.' }
        : { code: 'ACCEPT_TERMS', label: 'Review and accept the cancellation terms, then pay.' };
    }
    // After the event, until the client has said how it went. Not offered on a
    // booking that has settled: there is nothing left to confirm.
    if (ended && !b.clientConfirmedAt && ['FUNDED_HELD', 'CHECKED_IN', 'AWAITING_CONFIRMATION'].includes(b.state)) {
      return {
        code: 'CONFIRM',
        label: 'Tell us how the event went.',
        deadline: b.autoReleaseAt ? new Date(b.autoReleaseAt).toISOString() : null,
      };
    }
    return null;
  }

  // ARTIST
  if (b.state === 'FUNDED_HELD') {
    const opens = at(b.checkInCodeValidFrom);
    const closes = at(b.checkInCodeValidTo);
    if (opens !== null && closes !== null && t >= opens && t <= closes) {
      return { code: 'CHECK_IN', label: "Check in when you arrive — ask the client for their code." };
    }
  }
  if (ended && !b.artistConfirmedAt && ['CHECKED_IN', 'AWAITING_CONFIRMATION'].includes(b.state)) {
    return { code: 'CONFIRM', label: 'Confirm the event went ahead.' };
  }
  return null;
}

const SETTLED = ['RELEASED', 'REFUNDED', 'CANCELLED', 'RESOLVED'];

/** Which part of the list a booking belongs in. */
function groupFor(b: ActionFacts, action: NextAction | null, now: Date = new Date()): 'attention' | 'upcoming' | 'past' {
  if (action) return 'attention';
  if (SETTLED.includes(b.state)) return 'past';
  return (at(b.eventEndAt) ?? at(b.eventDate) ?? 0) > now.getTime() ? 'upcoming' : 'past';
}

const GROUP_ORDER = { attention: 0, upcoming: 1, past: 2 } as const;

async function listMyBookings({ userId, role }: { userId: string; role: Role }, now: Date = new Date()) {
  const bookings = await prisma.booking.findMany({
    // OWN bookings only, by the relation the caller is on — never by an id the
    // caller supplies, so there is nothing to tamper with.
    where: role === 'CLIENT' ? { client: { userId } } : { artist: { userId } },
    include: {
      client: { select: { displayName: true } },
      artist: { select: { id: true, stageName: true } },
      termsAcknowledgement: { select: { acknowledgedAt: true } },
    },
    orderBy: { eventDate: 'asc' },
    take: 200,
  });

  const rows = bookings.map((b: any) => {
    const facts: ActionFacts = { ...b, acknowledged: Boolean(b.termsAcknowledgement) };
    const action = nextActionFor(facts, role, now);
    return {
      id: b.id,
      state: b.state,
      amountKobo: b.amountKobo,
      eventDate: b.eventDate,
      eventEndAt: b.eventEndAt,
      eventLocation: b.eventLocation,
      // The OTHER party, by the name they chose to be known by.
      counterparty:
        role === 'CLIENT'
          ? { name: b.artist?.stageName ?? 'Your artist', artistId: b.artist?.id ?? null }
          : { name: b.client?.displayName ?? 'Your client', artistId: null },
      action,
      group: groupFor(facts, action, now),
    };
  });

  rows.sort((a: any, b: any) => {
    const g = GROUP_ORDER[a.group as keyof typeof GROUP_ORDER] - GROUP_ORDER[b.group as keyof typeof GROUP_ORDER];
    if (g !== 0) return g;
    const da = new Date(a.eventDate).getTime();
    const db = new Date(b.eventDate).getTime();
    // Soonest first while it is ahead; most recent first once it is past.
    return a.group === 'past' ? db - da : da - db;
  });

  return rows;
}

module.exports = { listMyBookings, nextActionFor, groupFor };
