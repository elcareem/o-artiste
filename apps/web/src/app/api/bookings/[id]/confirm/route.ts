/**
 * After-event action proxy — issue #47. Forwards an allowlisted body; whether
 * the action is allowed, and what it does with the money, is the backend's.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  void body;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
