import { redirect } from 'next/navigation';
import Link from 'next/link';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { triage, type QueueEntry } from '@/lib/disputes';
import { EmptyState } from '@/components/empty-state';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Disputes',
  robots: { index: false, follow: false },
};

/**
 * The dispute queue — issue #32.
 *
 * Every row here is money held from two people who both believe it is theirs.
 * The list is ordered oldest first for that reason: how long that has been true
 * is the thing to act on, not which arrived most recently.
 *
 * `Check-in` is a column rather than a detail, because a dispute with one
 * should be cheap to decide — it reduces "did the event happen?" to a
 * timestamped fact — and knowing that before opening the row is what makes the
 * queue triageable.
 */
export default async function AdminDisputesPage() {
  if (!(await sessionToken())) redirect('/login?next=/admin/disputes');

  const headers = await authHeader();
  let entries: QueueEntry[] = [];
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/admin/disputes`, { headers, cache: 'no-store' });
    const payload = await response.json().catch(() => null);

    if (response.status === 403) {
      error = 'This page is for administrators.';
    } else if (!response.ok) {
      error = payload?.error ?? 'Could not load the dispute queue.';
    } else {
      entries = triage(payload.disputes ?? []);
    }
  } catch {
    error = 'Could not reach the server. Check your connection and try again.';
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Disputes</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Funds stay held until one of these is decided. Nothing resolves on its own.
      </p>

      {error ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {error}
        </p>
      ) : entries.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Nothing waiting">
            No booking is currently in dispute.
          </EmptyState>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Link
                href={`/admin/disputes/${entry.id}`}
                className="block rounded-lg border border-[var(--color-line)] p-4 hover:border-[var(--color-accent)]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {entry.client} &middot; {entry.artist}
                  </span>
                  <span className="tabular-nums font-semibold">
                    {formatNaira(entry.amountKobo)}
                  </span>
                </div>

                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted)]">
                  {entry.openedReason}
                </p>

                <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                  <span>
                    {entry.ageDays === 0 ? 'Opened today' : `Held ${entry.ageDays} day${entry.ageDays === 1 ? '' : 's'}`}
                  </span>

                  {/* The fact that usually decides it. */}
                  <span className={entry.hasCheckIn ? 'text-emerald-400' : 'text-amber-400'}>
                    {entry.hasCheckIn ? 'Check-in recorded' : 'No check-in'}
                  </span>

                  <span>
                    {entry.evidenceCount === 0
                      ? 'No statements yet'
                      : `${entry.evidenceCount} statement${entry.evidenceCount === 1 ? '' : 's'}`}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
