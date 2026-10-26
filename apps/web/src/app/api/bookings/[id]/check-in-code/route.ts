/**
 * The client's check-in code — issue #48. A pass-through: the backend returns it
 * only to the booking's own client, and a 404 to everyone else (docs/02 §5).
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/check-in-code`);
}
