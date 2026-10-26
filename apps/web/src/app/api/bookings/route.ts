/**
 * Booking creation proxy — issue #46. Allowlisted fields; everything that
 * decides whether the booking is allowed — verification, standing, the
 * artist's listability, the amount range, the lead time — is the backend's.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { artistId, amountKobo, eventDate, eventEndAt, eventLocation } = body;
  return forwardAuthenticated('/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artistId, amountKobo, eventDate, eventEndAt, eventLocation }),
  });
}
