/**
 * Artist profile update proxy — issue #44.
 *
 * Allowlisted fields only. The backend checks that the caller owns this
 * profile; the allowlist means a field added to the API later is not editable
 * from here until someone decides it should be.
 */

import { forwardAuthenticated } from '@/lib/proxy';

const EDITABLE = ['stageName', 'bio', 'category', 'location', 'baseRateKobo'] as const;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const patch: Record<string, unknown> = {};
  for (const field of EDITABLE) if (body[field] !== undefined) patch[field] = body[field];

  return forwardAuthenticated(`/artists/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
