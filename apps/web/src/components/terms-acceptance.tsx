'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';
import type { Band } from '@/lib/booking-request';

/**
 * Agreeing to the terms, then requesting payment details — issue #46.
 *
 * `bands` are passed back EXACTLY as the server rendered them: the backend
 * checks them against the booking's snapshot, which is what makes the record
 * proof of what was shown (#16). Funding cannot be requested before this
 * succeeds — the backend refuses it, and this page does not offer it.
 */
export function TermsAcceptance({ bookingId, bands }: { bookingId: string; bands: Band[] }) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setSubmitted(true);
    setError(null);
    if (!agreed) return;

    setBusy(true);
    try {
      const ack = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledged: true, tiersAsDisplayed: bands }),
      });
      if (!ack.ok) {
        setError(failureMessage(await ack.json().catch(() => null), `The terms were not recorded. ${NOTHING.charged}`));
        return;
      }

      // Only now: the payment details for this booking.
      const funding = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/funding`, { method: 'POST' });
      if (!funding.ok) {
        // The acknowledgement is recorded; the status page can request the
        // payment details again, so send them there rather than strand them.
        setError(failureMessage(await funding.json().catch(() => null), 'Your agreement is saved, but we could not get the payment details. Open the booking to try again.'));
        return;
      }
      router.push(`/booking-status/${encodeURIComponent(bookingId)}`);
    } catch {
      setError(unreachable(NOTHING.charged));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
        <span>I have read these terms and agree that they apply if I cancel this booking.</span>
      </label>
      {submitted && !agreed && <p className="mt-1 text-sm">Tick the box to agree to the terms before paying.</p>}
      {error && (
        <p role="alert" className="mt-3 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className="mt-4 min-h-11 w-full rounded-md border border-[var(--color-line)] font-medium hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Getting your payment details…' : 'Agree and get payment details'}
      </button>
    </div>
  );
}
