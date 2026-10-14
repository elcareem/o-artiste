/**
 * Terms acknowledgement proxy — issue #46.
 *
 * The bands are forwarded EXACTLY as the page received them. The backend
 * compares them with the booking's snapshot; that comparison is what makes the
 * record proof of what the client saw rather than an assertion (#16).
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardAuthenticated(`/bookings/${encodeURIComponent(id)}/terms/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledged: body.acknowledged, tiersAsDisplayed: body.tiersAsDisplayed }),
  });
}
