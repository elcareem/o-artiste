/**
 * Cancellation proxy — issue #30.
 *
 * Which economics apply is decided by the backend from the caller's part in the
 * booking, not from anything sent here (docs/02 §7). This forwards the reason
 * and nothing else: a role in a request body is a role a request body can lie
 * about.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 2000) : undefined;

  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
}
