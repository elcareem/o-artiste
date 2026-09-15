/**
 * Funding instruction proxy — issue #21.
 *
 * POST rather than GET because this is `POST /bookings/:id/funding` on the
 * backend, which CREATES the escrow the first time and returns the existing
 * instruction every time after (#18). Safe to call on every page load: our
 * reference is the provider's idempotency key, so a repeat returns the same
 * escrow and the same destination account rather than opening a second one.
 *
 * Deliberately NOT part of the polling loop. Polling reads booking state; this
 * is called once, when the page mounts.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/funding`, { method: 'POST' });
}
