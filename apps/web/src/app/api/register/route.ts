/**
 * Sign-up — issue #42.
 *
 * Creates the account AND the session in one step, the same way /api/session
 * signs in: the backend's token is put in an httpOnly cookie and never handed
 * to browser JavaScript.
 *
 * The body is rebuilt from an allowlist rather than forwarded, so nothing the
 * page did not mean to send — a `role: "SUPER_ADMIN"` typed into devtools, say
 * — reaches the API from here. The backend refuses that anyway (#9); this is
 * the second lock, not the first.
 */

import { NextResponse } from 'next/server';

import { BASE_URL } from '@/lib/api';
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session';
import { NOTHING, failureMessage, unreachable } from '@/lib/error-messages';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Fill in the form to create your account.' }, { status: 400 });
  }

  const { role, email, phone, password, displayName, stageName } = body as Record<string, unknown>;

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, email, phone, password, displayName, stageName }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: unreachable('Your account has not been created.') }, { status: 503 });
  }

  const payload = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    // The backend's own words — which, for a duplicate, deliberately do not
    // say whether the email or the phone matched.
    return NextResponse.json(
      { error: failureMessage(payload, 'Your account could not be created. Try again.') },
      { status: upstream.status }
    );
  }

  const token = (payload as { token?: string } | null)?.token;
  if (!token) {
    return NextResponse.json({ error: `Something went wrong. ${NOTHING.changed}` }, { status: 502 });
  }

  const response = NextResponse.json({ user: (payload as { user?: unknown }).user ?? null }, { status: 201 });
  response.cookies.set(SESSION_COOKIE, token, COOKIE_OPTIONS);
  return response;
}
