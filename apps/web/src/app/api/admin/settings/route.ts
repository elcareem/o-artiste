/**
 * Settings proxy — issue #36.
 *
 * Read-only. Each section writes through its own endpoint, because the
 * permissions differ per section and a single write path would have to
 * re-derive them — the server already knows, and asking it once per section
 * keeps that knowledge in one place.
 */

import { forwardAuthenticated } from '@/lib/proxy';

export async function GET() {
  return forwardAuthenticated('/admin/settings', { method: 'GET' });
}
