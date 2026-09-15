import { redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { BookingStatusView } from '@/components/booking-status-view';
import type { Booking, FundingInstruction } from '@/lib/booking-status';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Booking status',
  // The URL carries a booking id; keeping it out of search results is free.
  robots: { index: false, follow: false },
};

/**
 * Client-facing post-checkout page — issue #21.
 *
 * The first render happens on the server so a client landing here after their
 * bank app sees the funding details immediately, rather than a spinner while
 * JavaScript boots. Polling takes over from there.
 */
export default async function BookingStatusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!(await sessionToken())) {
    redirect(`/login?next=${encodeURIComponent(`/booking-status/${id}`)}`);
  }

  const headers = await authHeader();
  const [booking, error] = await load<{ booking: Booking }>(
    `/bookings/${encodeURIComponent(id)}`,
    { method: 'GET', headers }
  );

  // The funding instruction is fetched only while payment is outstanding.
  // Calling it is safe at any time — our reference is the provider's
  // idempotency key, so a repeat returns the same escrow (#18) — but there is
  // nothing to show once the money has arrived.
  let funding: FundingInstruction | null = null;
  if (booking?.booking.state === 'PENDING_PAYMENT') {
    const [payload] = await load<{ funding: FundingInstruction }>(
      `/bookings/${encodeURIComponent(id)}/funding`,
      { method: 'POST', headers }
    );
    funding = payload?.funding ?? null;
  }

  return (
    <BookingStatusView
      bookingId={id}
      initialBooking={booking?.booking ?? null}
      initialFunding={funding}
      initialError={error}
    />
  );
}

/**
 * Returns `[payload, error]` and never throws.
 *
 * A booking whose funding call failed should still render its state, and a
 * status page that 500s because the provider is slow is worse than one that
 * shows what it knows. The error string is the backend's own; no status codes
 * and no stack traces reach the page.
 */
async function load<T>(path: string, init: RequestInit): Promise<[T | null, string | null]> {
  try {
    const response = await fetch(`${BASE_URL}${path}`, { ...init, cache: 'no-store' });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        typeof (payload as { error?: unknown })?.error === 'string'
          ? ((payload as { error: string }).error)
          : 'Something went wrong. Please try again.';
      return [null, message];
    }
    return [payload as T, null];
  } catch {
    return [null, 'Could not reach the server. Check your connection and try again.'];
  }
}
