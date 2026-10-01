'use client';

import { useState } from 'react';

import { formatNaira } from '@/lib/currency';

/**
 * The safety valve — issue #37, docs/07 §7.
 *
 * Manual release and refund exist for the cases the automated paths do not
 * cover: a client who will not confirm and will not dispute, a booking stuck by
 * a bug we have since fixed.
 *
 * Three things are deliberate here.
 *
 * It is CLOSED BY DEFAULT. A button that moves money should not be one stray
 * click away on a screen people open to read.
 *
 * It states the AMOUNT AND THE RECIPIENT before asking for confirmation, because
 * the number is the thing to check and an admin reading five bookings in a row
 * should not have to remember which one this is.
 *
 * The reason is required HERE AS WELL AS in the backend — not because this check
 * is the guarantee, but because being told at the point of typing beats a
 * rejected submission that loses what you wrote.
 */
export function ManualMoneyAction({
  bookingId,
  amountKobo,
  artistShareKobo,
  artistName,
  clientName,
  available,
}: {
  bookingId: string;
  amountKobo: number;
  artistShareKobo: number;
  artistName: string;
  clientName: string;
  /** Empty where the booking has already concluded — nothing to move. */
  available: ('release' | 'refund')[];
}) {
  const [open, setOpen] = useState<'release' | 'refund' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (available.length === 0 || done) {
    return done ? (
      <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
        {done} Reload the page to see the updated ledger.
      </p>
    ) : null;
  }

  // Mirrors the backend's bar. Kept in sync by the API test that submits "ok"
  // and expects a 400 — if these diverge, that test is the one that notices.
  const tooShort = reason.trim().length > 0 && reason.trim().length < 10;
  const reasonMissing = reason.trim().length === 0;

  async function submit(action: 'release' | 'refund') {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/admin/bookings/${encodeURIComponent(bookingId)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        }
      );
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        // The backend's message, unaltered. It is written for a person, and
        // rewording it here would produce two sets of copy for one condition.
        setError(payload?.error ?? 'The action did not go through. Nothing has changed.');
        return;
      }

      setDone(
        action === 'release'
          ? `Released. ${artistName} will be paid ${formatNaira(artistShareKobo)}.`
          : `Refunded to ${clientName}.`
      );
    } catch {
      setError('Could not reach the server. Nothing has changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 rounded-md border border-[var(--color-line)] p-4">
      <h2 className="text-sm font-semibold">Move this money by hand</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        For cases the automatic paths do not cover. Both actions are final and are recorded against
        your account with the reason you give.
      </p>

      {open === null ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {available.includes('release') && (
            <button
              type="button"
              onClick={() => setOpen('release')}
              className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm"
            >
              Release to {artistName}
            </button>
          )}
          {available.includes('refund') && (
            <button
              type="button"
              onClick={() => setOpen('refund')}
              className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm"
            >
              Refund {clientName}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-sm">
            {open === 'release' ? (
              <>
                {artistName} will receive <strong>{formatNaira(artistShareKobo)}</strong> of the{' '}
                {formatNaira(amountKobo)} held, after commission and the payout fee.
              </>
            ) : (
              <>
                {clientName} will be refunded from the {formatNaira(amountKobo)} held. The exact
                amount depends on the cancellation terms frozen on this booking.
              </>
            )}
          </p>

          <label className="mt-4 block text-sm font-medium" htmlFor="manual-reason">
            Why are you doing this?
          </label>
          <textarea
            id="manual-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="This is the only explanation the record will have."
            className="mt-1 w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm"
          />
          {tooShort && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              A little more detail — someone reading this in six months needs to understand it.
            </p>
          )}

          {error && (
            <p className="mt-3 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
              {error}
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || reasonMissing || tooShort}
              onClick={() => submit(open)}
              className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm disabled:opacity-50"
            >
              {busy
                ? 'Working…'
                : open === 'release'
                  ? `Release ${formatNaira(artistShareKobo)}`
                  : `Refund ${clientName}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(null);
                setReason('');
                setError(null);
              }}
              className="rounded-md px-3 py-2 text-sm text-[var(--color-muted)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
