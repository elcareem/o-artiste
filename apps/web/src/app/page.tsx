import { formatNaira } from '@/lib/currency';
import { BASE_URL } from '@/lib/api';
import { BackendStatus } from './backend-status';

/**
 * Placeholder landing page.
 *
 * The artist discovery grid this becomes is #13. What it carries now is the
 * one thing worth proving at bootstrap: that money renders through
 * formatNaira() and the client can reach the backend.
 */
export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-20">
      <p className="text-sm tracking-widest text-[var(--color-muted)] uppercase">
        Artist Escrow
      </p>

      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance">
        Book an artist. Your payment is held until the event has happened.
      </h1>

      <p className="mt-5 text-lg leading-relaxed text-[var(--color-muted)]">
        Funds are held by a licensed bank, never by us, and released only when
        both sides confirm. If the artist does not show up, you are refunded.
      </p>

      <div className="mt-12 rounded-lg border border-[var(--color-line)] p-6">
        <h2 className="text-sm font-medium tracking-wide uppercase">
          Bootstrap checks
        </h2>

        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">
              Rate rendered from kobo
            </dt>
            {/* 20,000,000 kobo. Never formatted anywhere but here. */}
            <dd className="font-medium tabular-nums">
              {formatNaira(20000000)}
            </dd>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">Zero renders as</dt>
            <dd className="font-medium tabular-nums">{formatNaira(0)}</dd>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">API</dt>
            <dd className="font-mono text-xs break-all">{BASE_URL}</dd>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">Backend health</dt>
            <dd className="font-medium">
              <BackendStatus />
            </dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
