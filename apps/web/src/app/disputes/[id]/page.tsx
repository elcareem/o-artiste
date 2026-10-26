import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, currentUser } from '@/lib/session';
import { formatLagos } from '@/lib/dates';
import { failureMessage, RETRY, unreachable } from '@/lib/error-messages';
import { DisputeEvidenceForm } from '@/components/dispute-evidence-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dispute', robots: { index: false, follow: false } };

type Evidence = { id: string; byYou: boolean; party: 'CLIENT' | 'ARTIST'; statement: string | null; fileUrl: string | null; createdAt: string };
type Dispute = {
  id: string;
  bookingId: string;
  state: string;
  openedReason: string;
  openedByYou: boolean;
  createdAt: string;
  checkIn: { redeemedAt: string; hasLocation: boolean } | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  evidence: Evidence[];
  viewerParty: 'CLIENT' | 'ARTIST';
};

const STATE_WORDS: Record<string, string> = {
  OPEN: 'Open — waiting for both sides',
  UNDER_REVIEW: 'With support, being reviewed',
  RESOLVED_RELEASE: 'Decided — the artist was paid',
  RESOLVED_REFUND: 'Decided — the client was refunded',
  RESOLVED_SPLIT: 'Decided — the money was split',
};

/**
 * A dispute, as either party sees it — issue #47.
 *
 * Both sides read the same record: what was claimed, the check-in (the
 * strongest single piece of evidence, docs/04 §2), and every statement in
 * order. Evidence one party adds, the other can see.
 */
export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/disputes/${id}`)}`);

  let dispute: Dispute | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${BASE_URL}/disputes/${encodeURIComponent(id)}`, { headers: await authHeader(), cache: 'no-store' });
    if (res.status === 404) notFound();
    const body = await res.json().catch(() => null);
    if (!res.ok) error = failureMessage(body, 'Could not load this dispute.');
    else dispute = body.dispute;
  } catch {
    error = unreachable(RETRY);
  }

  if (!dispute) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10">
        <p className="rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">{error}</p>
      </div>
    );
  }

  const resolved = dispute.state.startsWith('RESOLVED');
  const who = (e: Evidence) => (e.byYou ? 'You' : e.party === 'CLIENT' ? 'The client' : 'The artist');

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link href={`/booking-status/${dispute.bookingId}`} className="text-sm underline">
        Back to the booking
      </Link>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Dispute</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {STATE_WORDS[dispute.state] ?? 'In progress'} · opened {formatLagos(dispute.createdAt, 'shortDateTime')}
        {dispute.openedByYou ? ' by you' : ''}
      </p>

      {!resolved && (
        <p className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          The money is held until support decides. Nobody is paid or refunded before then.
        </p>
      )}
      {resolved && dispute.resolutionReason && (
        <section className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          <p className="font-medium">The decision</p>
          <p className="mt-1">{dispute.resolutionReason}</p>
        </section>
      )}

      <section className="mt-6 text-sm">
        <h2 className="font-semibold">Check-in</h2>
        <p className="mt-1 text-[var(--color-muted)]">
          {dispute.checkIn
            ? `The artist redeemed the client's code at ${formatLagos(dispute.checkIn.redeemedAt, 'shortDateTime')}${dispute.checkIn.hasLocation ? ', with a location' : ''}.`
            : 'No check-in was recorded for this booking.'}
        </p>
      </section>

      <section className="mt-6 text-sm">
        <h2 className="font-semibold">What each side has said</h2>
        <ol className="mt-2 space-y-3">
          <li className="rounded-md border border-[var(--color-line)] px-4 py-3">
            <p className="text-xs text-[var(--color-muted)]">
              {dispute.openedByYou ? 'You' : 'The other party'}, opening the dispute · {formatLagos(dispute.createdAt, 'shortDateTime')}
            </p>
            <p className="mt-1 whitespace-pre-wrap">{dispute.openedReason}</p>
          </li>
          {dispute.evidence.map((e) => (
            <li key={e.id} className="rounded-md border border-[var(--color-line)] px-4 py-3">
              <p className="text-xs text-[var(--color-muted)]">
                {who(e)} · {formatLagos(e.createdAt, 'shortDateTime')}
              </p>
              {e.statement && <p className="mt-1 whitespace-pre-wrap">{e.statement}</p>}
              {e.fileUrl && (
                <a href={e.fileUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 block break-all underline">
                  {e.fileUrl}
                </a>
              )}
            </li>
          ))}
        </ol>
      </section>

      {!resolved && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Add to the dispute</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">The other party will see what you add.</p>
          <div className="mt-3">
            <DisputeEvidenceForm disputeId={dispute.id} />
          </div>
        </section>
      )}
    </div>
  );
}
