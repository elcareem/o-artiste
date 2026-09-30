/**
 * Configuration write proxy — issue #36.
 *
 * ONE ALLOWLISTED PATH PER SECTION, not a pass-through. A proxy that forwarded
 * any `:section` would let a crafted path reach an admin endpoint this screen
 * was never meant to touch — the backend's role checks would still hold, but
 * the proxy would have become a general-purpose admin API by accident.
 *
 * Every section here is SUPER_ADMIN on the backend. That is checked there, not
 * here: this list exists to bound what the screen can address, not to enforce
 * permission.
 */

import { NextResponse } from 'next/server';

import { forwardAuthenticated } from '@/lib/proxy';

const SECTIONS: Record<string, string> = {
  commission: '/admin/config/commission',
  'cancellation-tiers': '/admin/config/cancellation-tiers',
  'auto-release': '/admin/config/auto-release',
  strikes: '/admin/config/strikes',
  enforcement: '/admin/config/enforcement',
  reputation: '/admin/config/reputation',
};

export async function PUT(request: Request, context: { params: Promise<{ section: string }> }) {
  const { section } = await context.params;
  const path = SECTIONS[section];

  if (!path) {
    return NextResponse.json({ error: 'That setting does not exist.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  return forwardAuthenticated(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function GET(_request: Request, context: { params: Promise<{ section: string }> }) {
  const { section } = await context.params;
  const path = SECTIONS[section];

  if (!path) {
    return NextResponse.json({ error: 'That setting does not exist.' }, { status: 404 });
  }

  return forwardAuthenticated(path, { method: 'GET' });
}
