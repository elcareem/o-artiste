'use client';

import { useEffect, useState } from 'react';

import { codeGuidance, shouldFetchCode, type CodeView } from '@/lib/check-in-code';
import { formatLagos } from '@/lib/dates';

/**
 * The client's check-in code — issue #48.
 *
 * Fetched by the card itself, so it appears the moment the booking becomes
 * funded while the client is watching the page — the status view refreshes the
 * booking, not this.
 */
export function CheckInCodeCard({ bookingId, state, party }: { bookingId: string; state: string; party: 'CLIENT' | 'ARTIST' }) {
  const [view, setView] = useState<CodeView | null>(null);
  const wanted = shouldFetchCode(state, party);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    fetch(`/api/bookings/${encodeURIComponent(bookingId)}/check-in-code`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body?.checkIn) setView(body.checkIn);
      })
      .catch(() => {
        // The rest of the page is still correct without the card; it tries
        // again whenever the booking's state changes.
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId, state, wanted]);

  if (!wanted || !view) return null;

  const guidance = codeGuidance(view, 'the artist');
  const usable = view.reason === null || view.reason === 'too_early';

  return (
    <section className="mt-6 rounded-lg border border-[var(--color-line)] p-5">
      <h2 className="text-sm font-semibold">{guidance.headline}</h2>
      {usable && (
        <div className="mt-3 flex flex-wrap items-center gap-5">
          <p className="font-mono text-3xl font-semibold tracking-[0.15em]" aria-label={`Check-in code ${view.code.split('').join(' ')}`}>
            {view.code}
          </p>
          {view.qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL from our own API; there is nothing to optimise
            <img src={view.qrDataUrl} alt="The same code as a QR image, for the artist to scan" width={112} height={112} className="rounded bg-white p-1" />
          )}
        </div>
      )}
      <p className="mt-3 text-sm text-[var(--color-muted)]">{guidance.detail}</p>
      {usable && view.validFrom && view.validTo && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          It works from {formatLagos(view.validFrom, 'dateTime')} to {formatLagos(view.validTo, 'dateTime')}.
        </p>
      )}
    </section>
  );
}
