/**
 * Authenticated backend proxy — issue #21.
 *
 * The polling loop runs in the browser, and the browser cannot read the
 * httpOnly session cookie — which is the point of putting the token there. This
 * attaches the bearer token server-side and forwards the backend's answer.
 *
 * It lives in `lib/` rather than in a route file because a Next route module is
 * expected to export HTTP method handlers and nothing else; exporting a helper
 * from one works until a version of Next decides it does not.
 */

import { NextResponse } from 'next/server';

import { BASE_URL } from './api';
import { authHeader } from './session';

/**
 * Forwards one request to the backend as the signed-in user.
 *
 * The backend's status and body are passed through unchanged. Its `error`
 * string is written for a person (docs/02 §2) and rewording it here would
 * produce two divergent sets of copy for the same condition.
 */
export async function forwardAuthenticated(
  path: string,
  init: RequestInit = {}
): Promise<NextResponse> {
  const auth = await authHeader();

  if (!('Authorization' in auth)) {
    return NextResponse.json({ error: 'Sign in to see this booking.' }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...auth },
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not reach the server. Check your connection and try again.' },
      { status: 503 }
    );
  }

  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
