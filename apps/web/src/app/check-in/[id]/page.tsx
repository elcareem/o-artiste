import { notFound, redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { statusCopy } from '@/lib/booking-status';
import { RETRY, failureMessage, unreachable } from '@/lib/error-messages';
import { canCheckIn, whyNotYet } from '@/lib/check-in';
import { CheckInForm } from '@/components/check-in-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Check in',
  robots: { index: false, follow: false },
};

/** Only the fields this screen reads. */
type Booking = {
  id: string;
  state: string;
  amountKobo: number;
  eventDate: string;
  eventLocation: string | null;
};

/**
 * The artist's arrival screen — issue #39.
 *
 * This existed only as a backend endpoint (#22, #23): the code was issued, the
 * SMS was sent, and there was nowhere for the artist to type it. Without this
 * page the check-in cannot be redeemed through the product at all, and the
 * check-in is what releases the money.
 *
 * It renders whatever the booking's state is rather than refusing to load —
 * an artist who opens it on the wrong day needs to be told why they cannot
 * check in yet, which is information the booking has.
 */
export default async function CheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await sessionToken())) redirect(`/login?next=/check-in/${id}`);

  const headers = await authHeader();
  let booking: Booking | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/bookings/${encodeURIComponent(id)}`, {
      headers,
      cache: 'no-store',
    });

    if (response.status === 404) notFound();

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      error = failureMessage(payload, 'Could not load this booking.');
    } else {
      booking = payload.booking;
    }
  } catch {
    error = unreachable(RETRY);
  }

  if (error || !booking) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Check in</h1>
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {error}
        </p>
      </div>
    );
  }

  // Anything else gets the reason instead of a form it cannot use — the backend
  // would refuse it anyway, and being told before typing is the point of #39.
  const redeemable = canCheckIn(booking.state);

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Check in</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {formatNaira(booking.amountKobo)} ·{' '}
        {new Date(booking.eventDate).toLocaleString('en-NG', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit',
        })}
        {booking.eventLocation ? ` · ${booking.eventLocation}` : ''}
      </p>

      {redeemable ? (
        <CheckInForm bookingId={booking.id} state={booking.state} clientName="the client" />
      ) : (
        <div className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3">
          <p className="text-sm font-medium">{statusCopy(booking.state).label}</p>
          {/* Why not, and what to do instead. "You cannot check in" leaves an
              artist standing at a venue with no idea what to do next. */}
          <p className="mt-1 text-sm text-[var(--color-muted)]">{whyNotYet(booking.state)}</p>
        </div>
      )}
    </div>
  );
}
