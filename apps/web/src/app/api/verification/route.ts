/**
 * Identity verification proxy — issue #43.
 *
 * Forwards exactly three fields. The consent flag is passed through as sent —
 * deliberately NOT defaulted or coerced here, so a request without it reaches
 * the API without it and is refused there (#41).
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { method, identifier, consent } = body ?? {};

  return forwardAuthenticated('/me/verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, identifier, consent }),
  });
}
