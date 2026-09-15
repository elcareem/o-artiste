/**
 * Booking read proxy — issue #21. The polling loop's endpoint.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}`, { method: 'GET' });
}
