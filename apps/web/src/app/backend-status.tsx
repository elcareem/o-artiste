'use client';

import { useEffect, useState } from 'react';
import { getHealth } from '@/lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; status: string }
  | { kind: 'error'; message: string };

/**
 * Calls the backend's /health from the browser, which is what actually proves
 * the cross-origin path works — a server-side fetch would succeed even with
 * CORS misconfigured.
 */
export function BackendStatus() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let active = true;

    getHealth()
      .then((body) => {
        if (active) setState({ kind: 'ok', status: body.status });
      })
      .catch((error: unknown) => {
        // The backend's own message, rendered unaltered.
        // docs/02-API-CONTRACT.md §2.
        const message =
          error instanceof Error ? error.message : 'Something went wrong.';
        if (active) setState({ kind: 'error', message });
      });

    return () => {
      active = false;
    };
  }, []);

  if (state.kind === 'loading') {
    return <span className="text-[var(--color-muted)]">checking…</span>;
  }

  if (state.kind === 'error') {
    return <span className="text-[var(--color-muted)]">{state.message}</span>;
  }

  return <span>{state.status}</span>;
}
