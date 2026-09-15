'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Sign in — supporting infrastructure for #21, not part of its stated scope.
 *
 * #21 is the first page that needs an authenticated call, and no issue in the
 * backlog builds a sign-in screen. This is the minimum that lets a client reach
 * their own booking: it posts to the session route handler, which exchanges the
 * credentials for an httpOnly cookie. The token never reaches JavaScript.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        // The backend's wording, unaltered — it is deliberately vague about
        // which half was wrong, and rewriting it here would undo that.
        setError(
          typeof (payload as { error?: unknown })?.error === 'string'
            ? (payload as { error: string }).error
            : 'Something went wrong. Please try again.'
        );
        return;
      }

      // replace(), not push(): the back button should not return to a sign-in
      // form the person has already completed.
      router.replace(next);
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>

      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-[var(--color-muted)]">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3"
          />
        </label>

        <label className="block">
          <span className="text-sm text-[var(--color-muted)]">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-muted)]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="min-h-11 w-full rounded-md border border-[var(--color-line)] font-medium transition-colors hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
