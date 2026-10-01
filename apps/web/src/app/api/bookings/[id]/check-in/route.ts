/**
 * Check-in redemption proxy — issue #39.
 *
 * Forwards the code and the optional location reading. Everything that decides
 * the outcome is the backend's: whether the code matches, whether it has already
 * been used, whether the window is open, and whether this artist owns the
 * booking.
 *
 * NO TIME IS FORWARDED, and there is nowhere to put one. `redeemedAt` is a
 * database default, which is what makes the record evidence rather than an
 * assertion (docs/04 §2).
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  const { code, latitude, longitude, accuracyMeters } = body ?? {};

  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // An allowlist, so a field added to the form later cannot reach the API
    // without someone deciding it should.
    body: JSON.stringify({ code, latitude, longitude, accuracyMeters }),
  });
}
