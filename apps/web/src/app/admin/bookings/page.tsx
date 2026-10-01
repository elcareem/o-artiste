import { redirect } from 'next/navigation';
import Link from 'next/link';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { statusCopy } from '@/lib/booking-status';
import { EmptyState } from '@/components/empty-state';
import { RETRY, failureMessage, unreachable } from '@/lib/error-messages';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Bookings',
  robots: { index: false, follow: false },
};

type Row = {
  id: string;
  escrowReference: string;
  state: string;
  amountKobo: number;
  eventDate: string;
  createdAt: string;
  client: { displayName: string | null; email: string | null };
  artist: { stageName: string | null; email: string | null };
  awaitingPayout: boolean;
  hasOpenDispute: boolean;
};

/** The filters offered, as query parameters passed straight through. */
const STATES = [
  'PENDING_PAYMENT',
  'FUNDED_HELD',
  'CHECKED_IN',
  'AWAITING_CONFIRMATION',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'CANCELLED',
  'RESOLVED',
];

const FILTER_KEYS = ['state', 'from', 'to', 'minKobo', 'maxKobo', 'page'] as const;

/**
 * The booking list — issue #37.
 *
 * Ordered newest first, which is the opposite of the dispute queue and
 * deliberately so: a dispute is a thing to work through oldest-first, while this
 * is a list you come to with a specific booking in mind.
 *
 * The filters are a GET form with no JavaScript. The URL carries the whole
 * query, so a filtered list is a link an admin can paste into a conversation
 * about the booking they are discussing.
 */
export default async function AdminBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (!(await sessionToken())) redirect('/login?next=/admin/bookings');

  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params[key];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) query.set(key, single);
  }

  const headers = await authHeader();
  let rows: Row[] = [];
  let total = 0;
  let page = 1;
  let totalPages = 1;
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/admin/bookings?${query.toString()}`, {
      headers,
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);

    if (response.status === 403) {
      error = 'This page is for administrators.';
    } else if (!response.ok) {
      // Including a rejected filter. The backend refuses a value it cannot
      // honour rather than ignoring it, and saying so is the whole point —
      // a silently dropped filter returns a full list that looks filtered.
      error = failureMessage(payload, 'Could not load the bookings.');
    } else {
      rows = payload.bookings ?? [];
      total = payload.pagination?.total ?? rows.length;
      page = payload.pagination?.page ?? 1;
      totalPages = payload.pagination?.totalPages ?? 1;
    }
  } catch {
    error = unreachable(RETRY);
  }

  const pageLink = (next: number) => {
    const copy = new URLSearchParams(query);
    copy.set('page', String(next));
    return `/admin/bookings?${copy.toString()}`;
  };

  const selectedState = query.get('state') ?? '';

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Bookings</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Every booking, with the money trail behind each one.
      </p>

      <form method="GET" className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium" htmlFor="state">
            State
          </label>
          <select
            id="state"
            name="state"
            defaultValue={selectedState}
            className="mt-1 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {STATES.map((state) => (
              <option key={state} value={state}>
                {statusCopy(state).label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium" htmlFor="from">
            Event from
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={query.get('from') ?? ''}
            className="mt-1 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium" htmlFor="to">
            Event to
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={query.get('to') ?? ''}
            className="mt-1 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          {/* Kobo, labelled as kobo. The alternative is a naira field that has
              to be converted somewhere, and this screen is for staff who read
              the same integers the ledger stores. */}
          <label className="block text-xs font-medium" htmlFor="minKobo">
            Value at least (kobo)
          </label>
          <input
            id="minKobo"
            name="minKobo"
            inputMode="numeric"
            defaultValue={query.get('minKobo') ?? ''}
            className="mt-1 w-36 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-sm"
          />
        </div>

        <button
          type="submit"
          className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm"
        >
          Filter
        </button>
        {query.toString() && (
          <Link href="/admin/bookings" className="px-1 py-2 text-sm text-[var(--color-muted)]">
            Clear
          </Link>
        )}
      </form>

      {error ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No bookings match">
            {query.toString()
              ? 'Nothing matches these filters. Clear them to see everything.'
              : 'No bookings have been made yet.'}
          </EmptyState>
        </div>
      ) : (
        <>
          <p className="mt-6 text-sm text-[var(--color-muted)]">
            {total} booking{total === 1 ? '' : 's'}
            {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
          </p>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left">
                  <th className="py-2 pr-3 font-medium">Event date</th>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium">Artist</th>
                  <th className="py-2 pr-3 text-right font-medium">Value</th>
                  <th className="py-2 pr-3 font-medium">State</th>
                  <th className="py-2 font-medium">Needs attention</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--color-line)]">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <Link href={`/admin/bookings/${row.id}`} className="underline">
                        {new Date(row.eventDate).toLocaleDateString('en-NG', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{row.client.displayName ?? row.client.email ?? '—'}</td>
                    <td className="py-2 pr-3">{row.artist.stageName ?? '—'}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(row.amountKobo)}
                    </td>
                    <td className="py-2 pr-3">{statusCopy(row.state).label}</td>
                    <td className="py-2 text-[var(--color-muted)]">
                      {/* The two things invisible in the state: money sitting in
                          our wallet that is not ours, and a held dispute. */}
                      {[
                        row.awaitingPayout ? 'Not yet paid out' : null,
                        row.hasOpenDispute ? 'Open dispute' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex gap-3 text-sm">
              {page > 1 && (
                <Link href={pageLink(page - 1)} className="underline">
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link href={pageLink(page + 1)} className="underline">
                  Next
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
