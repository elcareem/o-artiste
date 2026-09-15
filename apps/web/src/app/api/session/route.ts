/**
 * Sign in and sign out — supporting infrastructure for #21.
 *
 * Exchanges credentials for an httpOnly cookie. The JWT is written to the
 * cookie and returned to the browser in no other form, so no script on the page
 * can read the token that authorises money movement.
 */

import { NextResponse } from 'next/server';

import { BASE_URL } from '@/lib/api';
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session';

export async function POST(request: Request) {
  let credentials: unknown;
  try {
    credentials = await request.json();
  } catch {
    return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not reach the server. Check your connection and try again.' },
      { status: 503 }
    );
  }

  const payload = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    // The backend's wording, unaltered. It is deliberately vague about which
    // half of the credentials was wrong, and rewording it here would undo that.
    return NextResponse.json(
      { error: readError(payload) ?? 'Something went wrong. Please try again.' },
      { status: upstream.status }
    );
  }

  const token = (payload as { token?: string } | null)?.token;
  if (!token) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 502 });
  }

  // The user object goes back; the token does not.
  const response = NextResponse.json({ user: (payload as { user?: unknown }).user ?? null });
  response.cookies.set(SESSION_COOKIE, token, COOKIE_OPTIONS);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ signedOut: true });
  response.cookies.set(SESSION_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}

function readError(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error: unknown };
    if (typeof error === 'string' && error.trim().length > 0) return error;
  }
  return null;
}
