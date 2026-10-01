import Link from 'next/link';

import { currentUser } from '@/lib/session';
import { SignOutButton } from './sign-out-button';

/**
 * The header on every page — issue #42.
 *
 * Before this there was no navigation at all: sign-in existed only for people
 * who knew to type its URL, and nobody could reach their bookings, their
 * profile or the admin screens except the same way.
 *
 * Rendered on the server from `GET /me`, so it can never show a name for a
 * session the backend no longer honours. What it shows depends on role, but it
 * GRANTS nothing — every page and endpoint checks for itself.
 */
export async function SiteHeader() {
  const user = await currentUser();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

  const link = 'text-sm text-[var(--color-muted)] hover:text-[var(--color-fg,inherit)]';

  return (
    <header className="border-b border-[var(--color-line)]">
      <nav
        aria-label="Main"
        className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3"
      >
        <Link href="/" className="mr-auto font-semibold tracking-tight">
          o-artiste
        </Link>

        <Link href="/" className={link}>
          Browse artists
        </Link>

        {user ? (
          <>
            {!isAdmin && (
              <Link href="/bookings" className={link}>
                My bookings
              </Link>
            )}
            {user.role === 'ARTIST' && (
              <Link href="/me/profile" className={link}>
                My profile
              </Link>
            )}
            {isAdmin && (
              <>
                <Link href="/admin/bookings" className={link}>
                  Bookings
                </Link>
                <Link href="/admin/disputes" className={link}>
                  Disputes
                </Link>
                <Link href="/admin/settings" className={link}>
                  Settings
                </Link>
              </>
            )}
            {user.verificationStatus !== 'VERIFIED' && !isAdmin && (
              // The one thing standing between a new account and booking or
              // being booked. Visible on every page until it is done.
              <Link href="/verify" className="text-sm font-medium underline underline-offset-4">
                Verify your identity
              </Link>
            )}
            <span className="hidden text-sm text-[var(--color-muted)] sm:inline" title={user.email}>
              {user.name ?? user.email}
            </span>
            <SignOutButton />
          </>
        ) : (
          <>
            <Link href="/login" className={link}>
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-md border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium hover:border-[var(--color-accent)]"
            >
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
