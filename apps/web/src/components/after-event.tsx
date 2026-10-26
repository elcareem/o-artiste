'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { afterEventOptions, type AfterEventBooking } from '@/lib/after-event';
import { formatLagos } from '@/lib/dates';
import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';

/**
 * After the event — issue #47. The actions that decide where the money goes.
 *
 * Only what the backend would accept is offered (lib/after-event.ts). Each
 * action is two steps — choose, then confirm — because every one of them moves
 * money or holds it, and a stray tap should not.
 */
export function AfterEvent({ booking, party }: { booking: AfterEventBooking & { id: string }; party: 'CLIENT' | 'ARTIST' }) {
  const router = useRouter();
  const o = afterEventOptions(booking, party);
  const [mode, setMode] = useState<'idle' | 'confirm' | 'noshow' | 'dispute'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (o.disputeId) {
    return (
      <section className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
        <p className="font-medium">This booking is under dispute.</p>
        <p className="mt-1 text-[var(--color-muted)]">The money stays held until support decides. Nobody is paid or refunded before then.</p>
        <Link href={`/disputes/${o.disputeId}`} className="mt-2 inline-block underline">
          Open the dispute
        </Link>
      </section>
    );
  }

  if (!o.ended || (!o.canConfirm && !o.canClaimNoShow && !o.canDispute)) {
    return o.alreadyConfirmed && !done ? (
      <p className="mt-6 text-sm text-[var(--color-muted)]">You have confirmed this event.</p>
    ) : null;
  }

  async function act(path: string, body: Record<string, unknown>, then: (payload: { dispute?: { id: string } } | null) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(booking.id)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(failureMessage(payload, `That did not go through. ${NOTHING.moved}`));
        return;
      }
      then(payload);
    } catch {
      setError(unreachable(NOTHING.moved));
    } finally {
      setBusy(false);
    }
  }

  const reasonShort = reason.trim().length < 10;
  const button = 'min-h-11 rounded-md border border-[var(--color-line)] px-4 text-sm font-medium hover:border-[var(--color-accent)] disabled:opacity-50';

  if (done) {
    return <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">{done}</p>;
  }

  return (
    <section className="mt-6 rounded-md border border-[var(--color-line)] p-4">
      <h2 className="text-sm font-semibold">{party === 'CLIENT' ? 'How did it go?' : 'After the event'}</h2>
      {o.deadline && (
        // THE CONSEQUENCE OF SILENCE, stated where the person is asked to act.
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          If we hear nothing from you by {formatLagos(o.deadline, 'dateTime')}, payment is released to the artist automatically.
        </p>
      )}

      {o.artistMissingCheckIn && (
        <p className="mt-2 text-sm">
          There is no check-in on record. Without one, you are paid only when the client confirms — it does not release on
          its own.{' '}
          <Link href={`/check-in/${booking.id}`} className="font-medium underline">
            Check in now
          </Link>{' '}
          if the window is still open.
        </p>
      )}

      {mode === 'idle' && (
        <div className="mt-4 flex flex-wrap gap-2">
          {o.canConfirm && (
            <button type="button" className={button} onClick={() => setMode('confirm')}>
              {party === 'CLIENT' ? 'It went ahead' : 'Confirm the event went ahead'}
            </button>
          )}
          {o.canClaimNoShow && (
            <button type="button" className={button} onClick={() => setMode('noshow')}>
              The artist did not come
            </button>
          )}
          {o.canDispute && (
            <button type="button" className={button} onClick={() => setMode('dispute')}>
              Something went wrong
            </button>
          )}
        </div>
      )}

      {mode === 'confirm' && (
        <div className="mt-4 text-sm">
          <p>
            {party === 'CLIENT'
              ? 'Confirming tells us the event happened as agreed. Payment is then released to the artist.'
              : 'Confirming tells us you performed. Payment is released once the client confirms too, or when the deadline passes.'}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              className={button}
              onClick={() =>
                act('confirm', {}, () => {
                  setDone(party === 'CLIENT' ? 'Thank you — the artist is being paid.' : 'Thank you — we have recorded that you performed.');
                  router.refresh();
                })
              }
            >
              {busy ? 'Confirming…' : 'Yes, confirm'}
            </button>
            <button type="button" className="text-sm text-[var(--color-muted)]" onClick={() => setMode('idle')}>
              Back
            </button>
          </div>
        </div>
      )}

      {(mode === 'noshow' || mode === 'dispute') && (
        <div className="mt-4 text-sm">
          <p>
            {mode === 'noshow'
              ? 'Tell us what happened. With no check-in on record, the money comes back to you unless the artist shows otherwise.'
              : 'Tell us what went wrong. The money stays held — nobody is paid or refunded — until support decides, and the artist can give their side.'}
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            className="mt-2 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3 py-2"
            placeholder={mode === 'noshow' ? 'When were they due, and what did you see?' : 'What happened?'}
          />
          {reason.length > 0 && reasonShort && <p className="mt-1">A little more detail helps support decide quickly.</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || reasonShort}
              className={button}
              onClick={() =>
                mode === 'noshow'
                  ? act('claim-no-show', { reason: reason.trim() }, () => {
                      setDone('We have recorded that the artist did not come.');
                      router.refresh();
                    })
                  : act('disputes', { reason: reason.trim() }, (payload) => {
                      if (payload?.dispute?.id) router.push(`/disputes/${encodeURIComponent(payload.dispute.id)}`);
                      else router.refresh();
                    })
              }
            >
              {busy ? 'Sending…' : mode === 'noshow' ? 'Report a no-show' : 'Raise a dispute'}
            </button>
            <button type="button" className="text-sm text-[var(--color-muted)]" onClick={() => setMode('idle')}>
              Back
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
