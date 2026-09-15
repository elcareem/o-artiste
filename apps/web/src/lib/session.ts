/**
 * Session handling — supporting infrastructure for #21.
 *
 * THE JWT IS NEVER READABLE BY JAVASCRIPT. It lives in an httpOnly cookie set
 * by a Next route handler, and the browser never sees it. `localStorage` is the
 * usual shortcut here and it is the wrong one for this application: any script
 * that runs on the page — ours, a dependency's, an injected one — can read it,
 * and the token authorises money movement.
 *
 * The cost is that the browser cannot call the backend directly for anything
 * authenticated. It calls same-origin route handlers under `/api`, which attach
 * the bearer token server-side. That is the trade being made deliberately.
 */

import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'oa_session';

/** A week, matching the backend's default JWT_EXPIRES_IN. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  // Secure in production only, so the cookie still works on http://localhost.
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_MAX_AGE_SECONDS,
};

/** The caller's token, or null when they are not signed in. */
export async function sessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** Authorization header for a backend call, or an empty object. */
export async function authHeader(): Promise<Record<string, string>> {
  const token = await sessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
