/**
 * Dispute evidence proxy — issue #47. A statement, a link, or both. The
 * backend refuses anything but an http(s) link (#31).
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return forwardAuthenticated(`/disputes/${encodeURIComponent(id)}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement: body.statement, fileUrl: body.fileUrl }),
  });
}
