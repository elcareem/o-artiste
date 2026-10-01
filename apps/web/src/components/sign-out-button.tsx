'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Clears the httpOnly session cookie through the route that set it — issue #42. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/session', { method: 'DELETE' });
    } finally {
      // Even if the request failed, leave the person looking at a signed-out
      // page: refreshing re-reads the cookie, so the header tells the truth
      // either way.
      router.replace('/');
      router.refresh();
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="text-sm text-[var(--color-muted)] hover:text-[var(--color-fg,inherit)] disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
