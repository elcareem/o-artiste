'use client';

import { useCallback, useState } from 'react';

import {
  canConfirm,
  describeTiming,
  figuresFor,
  headlineFor,
  isSevereForArtist,
  artistConsequenceSentence,
  refundSentence,
  sunkFeeSentence,
  unavailableReason,
  type CancellationPreview,
  type Party,
} from '@/lib/cancellation';

/**
 * Cancelling a booking — issue #30.
 *
 * THE FIGURES COME FIRST, ALWAYS. `docs/00` §10 exists because a cancellation
 * deduction discovered after the fact became a public dispute; the number was
 * never the problem, finding out afterwards was.
 *
 * That is enforced structurally rather than by care: the component has three
 * steps, and the confirm step cannot render without a preview object in hand.
 * There is no path from "cancel" to "cancelled" that skips the figures, because
 * there is no state in which the confirm button exists and the figures do not.
 */

type Step = 'idle' | 'review' | 'done';

export function CancelBooking({
  bookingId,
  party,
  onCancelled,
}: {
  bookingId: string;
  party: Party;
  onCancelled?: () => void;
}) {
  const [step, setStep] = useState<Step>('idle');
  const [preview, setPreview] = useState<CancellationPreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // Separate from the page's own error state. A failed cancellation must leave
  // the booking view intact and usable (#30) — this message appears inside the
  // panel and nothing else changes.
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/bookings/${encodeURIComponent(bookingId)}/cancellation-preview`,
        { cache: 'no-store' }
      );
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        // The backend's own wording, unaltered. No status codes, no error
        // objects (docs/02 §2).
        setError(payload?.error ?? 'Could not work out what cancelling would cost. Try again.');
        return;
      }

      setPreview(payload.preview);
      setStep('review');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [bookingId]);

  const confirm = useCallback(async () => {
    // Belt and braces. `step === 'review'` already implies a preview, and this
    // says so to anyone reading the function on its own.
    if (!canConfirm(preview)) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        setError(payload?.error ?? 'The cancellation did not go through. Nothing has changed.');
        return;
      }

      setStep('done');
      onCancelled?.();
    } catch {
      setError('Could not reach the server. Nothing has been cancelled.');
    } finally {
      setBusy(false);
    }
  }, [bookingId, preview, reason, onCancelled]);

  if (step === 'done') {
    return (
      <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
        <h3 className="font-medium">This booking is cancelled.</h3>
        <p className="mt-1 text-sm opacity-80">
          {party === 'ARTIST'
            ? 'The client has been refunded in full. What you owe will come out of your next payout.'
            : 'Your refund is on its way to the account you paid from. It usually arrives within minutes.'}
        </p>
      </section>
    );
  }

  if (step === 'idle') {
    return (
      <section className="rounded-lg border border-[color:var(--color-border,#8883)] p-4">
        <button
          type="button"
          onClick={loadPreview}
          disabled={busy}
          className="text-sm underline underline-offset-4 disabled:opacity-50"
        >
          {busy ? 'Working out what this costs…' : 'Cancel this booking'}
        </button>

        {/* Said up front, so nobody clicks expecting it to be instant. */}
        <p className="mt-2 text-xs opacity-70">
          You will see exactly what this costs before anything is cancelled.
        </p>

        {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
      </section>
    );
  }

  // step === 'review'. A preview is present by construction; `unavailable`
  // covers the case where it exists but says no.
  const unavailable = unavailableReason(preview);

  if (!canConfirm(preview)) {
    return (
      <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <h3 className="font-medium">This booking cannot be cancelled</h3>
        <p className="mt-1 text-sm opacity-80">
          {unavailable ?? 'This booking cannot be cancelled right now.'}
        </p>
        <button
          type="button"
          onClick={() => setStep('idle')}
          className="mt-3 text-sm underline underline-offset-4"
        >
          Go back
        </button>
      </section>
    );
  }

  const figures = figuresFor(preview, party);
  const severe = party === 'ARTIST' && isSevereForArtist(preview);

  return (
    <section
      className={`rounded-lg border p-4 ${
        severe ? 'border-rose-500/50 bg-rose-500/5' : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <h3 className="font-medium">{headlineFor(preview, party)}</h3>

      {/* THE FIGURES. Exact, before anything is committed. */}
      <dl className="mt-3 space-y-2">
        {figures.map((figure) => (
          <div key={figure.label} className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-sm opacity-80">{figure.label}</dt>
            <dd
              className={
                figure.emphasis ? 'text-lg font-semibold tabular-nums' : 'text-sm tabular-nums'
              }
            >
              {figure.value}
            </dd>
            {figure.note ? (
              <p className="w-full text-xs opacity-60">{figure.note}</p>
            ) : null}
          </div>
        ))}
      </dl>

      {party === 'CLIENT' ? (
        <>
          {/* A ₦0 outcome is a sentence, never a blank or a bare zero. */}
          <p className="mt-3 text-sm">{refundSentence(preview)}</p>
          {sunkFeeSentence(preview) ? (
            <p className="mt-2 text-xs opacity-70">{sunkFeeSentence(preview)}</p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-sm">
          <span className="font-medium">What this does to your account: </span>
          {artistConsequenceSentence(preview)}
        </p>
      )}

      <label className="mt-4 block text-sm">
        <span className="opacity-80">Why are you cancelling? (optional)</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={2000}
          className="mt-1 w-full rounded border border-[color:var(--color-border,#8883)] bg-transparent p-2 text-sm"
          placeholder={
            party === 'ARTIST'
              ? 'The client will see that you cancelled, not this note.'
              : 'Only support sees this.'
          }
        />
      </label>

      {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}

      <div className="mt-4 flex flex-wrap gap-3">
        {/* The destructive action is not the default one. */}
        <button
          type="button"
          onClick={() => setStep('idle')}
          disabled={busy}
          className="text-sm underline underline-offset-4 disabled:opacity-50"
        >
          Keep this booking
        </button>

        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="rounded bg-rose-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy
            ? 'Cancelling…'
            : party === 'ARTIST'
              ? 'Yes, cancel and accept what I owe'
              : `Yes, cancel ${describeTiming(preview.daysBeforeEvent)}`}
        </button>
      </div>
    </section>
  );
}
