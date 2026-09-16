/**
 * Cancellation preview proxy — issue #30.
 *
 * The figures come from the backend, which computes them with the SAME function
 * the cancellation itself uses against the SAME snapshot. Recomputing anything
 * here would create a second place where money is calculated, and the first
 * time the two disagreed a client would be shown one number and charged
 * another.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/cancellation-preview`, {
    method: 'GET',
  });
}
