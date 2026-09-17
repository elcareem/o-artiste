/**
 * Dispute resolution proxy — issue #32.
 *
 * Forwards the verdict and nothing more. The decision is executed by
 * `escrowService`, which is the only module permitted to move money, and every
 * check that matters — the written reason, the role, whether the dispute is
 * already decided — is the backend's.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));

  return forwardAuthenticated(`/admin/disputes/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
