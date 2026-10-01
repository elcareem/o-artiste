/**
 * Manual release and refund proxy — issue #37.
 *
 * ALLOWLISTED, not a pass-through. `[action]` in a path segment forwarded
 * verbatim would make this route a general-purpose tunnel to anything under
 * `/admin/bookings/:id/*` — including endpoints added later by someone who never
 * read this file. Two actions exist; only those two are forwarded.
 *
 * Everything that matters is still the backend's: the role check, the mandatory
 * written reason, the state machine, and `escrowService` as the sole mover of
 * money. This adds no authority of its own.
 */

import { NextResponse } from 'next/server';

import { forwardAuthenticated } from '@/lib/proxy';

const ALLOWED = new Set(['release', 'refund']);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> }
) {
  const { id, action } = await context.params;

  if (!ALLOWED.has(action)) {
    return NextResponse.json({ error: 'That is not an action on a booking.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  return forwardAuthenticated(
    `/admin/bookings/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}
