import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, currentUser } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { formatLagos } from '@/lib/dates';
import { statusCopy } from '@/lib/booking-status';
import { failureMessage, RETRY, unreachable } from '@/lib/error-messages';
import { GROUP_TITLES, hrefFor, type MyBooking } from '@/lib/my-bookings';
import { EmptyState } from '@/components/empty-state';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My bookings', robots: { index: false, follow: false } };

/**
 * The list every client and artist lands on — issue #45.
 *
 * What needs the person's attention comes first, and the backend decided it:
 * this page renders `action` and `group` as given rather than working them out.
 */
export default async function MyBookingsPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/bookings');
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') redirect('/admin/bookings');

  let bookings: MyBooking[] = [];
  let error: string | null = null;
  try {
    const res = await fetch(`${BASE_URL}/me/bookings`, { headers: await authHeader(), cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok) error = failureMessage(body, 'Could not load your bookings.');
    else bookings = body.bookings ?? [];
  } catch {
    error = unreachable(RETRY);
  }

  const isArtist = user.role === 'ARTIST';
  const groups = (['attention', 'upcoming', 'past'] as const)
    .map((g) => ({ group: g, rows: bookings.filter((b) => b.group === g) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">My bookings</h1>

      {user.verificationStatus !== 'VERIFIED' && (
        <p className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {isArtist ? 'Clients cannot book you' : 'You cannot book anyone'} until you have verified your identity.{' '}
          <Link href="/verify?next=/bookings" className="font-medium underline">
            Verify now
          </Link>
        </p>
      )}

      {error ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">{error}</p>
      ) : bookings.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No bookings yet">
            {isArtist ? (
              <>
                Clients book you from your public page. <Link href="/me/profile" className="underline">Check your profile</Link>{' '}
                is complete so they can find you.
              </>
            ) : (
              <>
                <Link href="/" className="underline">Browse artists</Link> to make your first booking. Your payment is held
                until the event has happened.
              </>
            )}
          </EmptyState>
        </div>
      ) : (
        groups.map(({ group, rows }) => (
          <section key={group} className="mt-8">
            <h2 className="text-sm font-semibold">{GROUP_TITLES[group]}</h2>
            <ul className="mt-2 divide-y divide-[var(--color-line)] rounded-md border border-[var(--color-line)]">
              {rows.map((b) => (
                <li key={b.id}>
                  <Link href={hrefFor(b)} className="block px-4 py-3 hover:bg-[var(--color-line)]/20">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="font-medium">{b.counterparty.name}</span>
                      <span className="text-sm tabular-nums">{formatNaira(b.amountKobo)}</span>
                    </div>
                    <div className="text-sm text-[var(--color-muted)]">
                      {formatLagos(b.eventDate, 'dateTime')}
                      {b.eventLocation ? ` · ${b.eventLocation}` : ''} · {statusCopy(b.state).label}
                    </div>
                    {b.action && (
                      <div className="mt-1 text-sm font-medium">
                        {b.action.label}
                        {b.action.deadline && (
                          // The consequence of silence, stated where the person is asked to act.
                          <span className="block font-normal text-[var(--color-muted)]">
                            If we hear nothing by {formatLagos(b.action.deadline, 'dateTime')}, payment is released automatically.
                          </span>
                        )}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
