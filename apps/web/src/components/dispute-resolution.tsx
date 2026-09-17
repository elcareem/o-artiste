'use client';

import { useState } from 'react';

import { formatNaira } from '@/lib/currency';
import {
  outcomeDescription,
  previewSplit,
  splitProblem,
  strikesSomeone,
  type DisputeDetail,
  type DisputeOutcome,
} from '@/lib/disputes';

/**
 * Issuing a verdict — issue #32, docs/04 §6.
 *
 * DISPUTE AUTHORITY SITS WITH US. EscrowPay does not arbitrate; funds stay held
 * until we instruct otherwise. This form is the instruction.
 *
 * The written reason is required here as well as in the backend — not because
 * the client-side check is the guarantee, but because being told at the point
 * of typing beats a rejected submission that loses the rest of the form.
 */
export function DisputeResolution({ dispute }: { dispute: DisputeDetail }) {
  const [outcome, setOutcome] = useState<DisputeOutcome>('RELEASE');
  const [reason, setReason] = useState('');
  const [splitClient, setSplitClient] = useState('');
  const [mediator, setMediator] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const amount = dispute.booking.amountKobo;
  const splitIssue = outcome === 'SPLIT' ? splitProblem(amount, splitClient) : null;
  const plan =
    outcome === 'SPLIT' && !splitIssue
      ? previewSplit(amount, Number(splitClient), dispute.booking.commissionRateBpsSnapshot)
      : null;

  const reasonMissing = reason.trim().length === 0;

  async function submit() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/disputes/${encodeURIComponent(dispute.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome,
          reason: reason.trim(),
          ...(outcome === 'SPLIT' ? { splitClientKobo: Number(splitClient) } : {}),
          ...(mediator.trim() ? { mediatorOpinion: mediator.trim() } : {}),
        }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        setError(payload?.error ?? 'The decision did not go through. Nothing has changed.');
        return;
      }

      setDone(payload.resolution.outcome);
    } catch {
      setError('Could not reach the server. Nothing has been decided.');
    } finally {
      setBusy(false);
    }
  }

  if (dispute.resolvedAt || done) {
    return (
      <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
        <h2 className="font-medium">This dispute has been decided.</h2>
        <p className="mt-1 text-sm opacity-80">
          {dispute.resolutionReason ?? 'The funds have been released according to the decision.'}
        </p>
        <p className="mt-2 text-xs opacity-60">
          A decision cannot be reversed here. Anything further is a correction, recorded as new
          entries against the booking.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--color-line)] p-4">
      <h2 className="font-medium">Decide this dispute</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {formatNaira(amount)} is held. Nothing moves until you choose.
      </p>

      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">Outcome</legend>
        {(['RELEASE', 'REFUND', 'SPLIT'] as DisputeOutcome[]).map((option) => (
          <label key={option} className="flex gap-3 rounded border border-[var(--color-line)] p-3">
            <input
              type="radio"
              name="outcome"
              value={option}
              checked={outcome === option}
              onChange={() => setOutcome(option)}
              className="mt-1"
            />
            <span className="text-sm">
              <span className="font-medium">
                {option === 'RELEASE'
                  ? 'Pay the artist'
                  : option === 'REFUND'
                    ? 'Refund the client'
                    : 'Split between them'}
              </span>
              <span className="block opacity-70">{outcomeDescription(option, dispute)}</span>
              {strikesSomeone(option) ? (
                <span className="mt-1 block text-xs opacity-60">
                  Records a strike against the party this goes against.
                </span>
              ) : (
                <span className="mt-1 block text-xs opacity-60">
                  Strikes nobody — a split is not a finding against either party.
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      {outcome === 'SPLIT' && (
        <div className="mt-4">
          <label className="block text-sm">
            <span className="opacity-80">The client receives (kobo)</span>
            <input
              inputMode="numeric"
              value={splitClient}
              onChange={(event) => setSplitClient(event.target.value.replace(/[^\d]/g, ''))}
              className="mt-1 w-full rounded border border-[var(--color-line)] bg-transparent p-2 text-sm tabular-nums"
              placeholder={String(Math.floor(amount / 2))}
            />
          </label>

          {splitIssue ? (
            <p className="mt-2 text-sm text-amber-400">{splitIssue}</p>
          ) : plan ? (
            // THE FIGURES THAT WILL EXECUTE, not an approximation of them. The
            // artist's share is the residual, computed the same way the backend
            // computes it, so what is shown is what moves.
            <dl className="mt-3 space-y-1 text-sm">
              <Row label="Client receives" value={formatNaira(plan.clientKobo)} />
              <Row label="Artist share" value={formatNaira(plan.artistKobo)} />
              <Row label="Commission on their share" value={formatNaira(plan.commissionKobo)} />
              <Row label="Artist receives" value={formatNaira(plan.artistNetKobo)} emphasis />
            </dl>
          ) : null}
        </div>
      )}

      <label className="mt-4 block text-sm">
        <span className="opacity-80">Your reasoning (required)</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={4000}
          className="mt-1 w-full rounded border border-[var(--color-line)] bg-transparent p-2 text-sm"
          placeholder="What decided it. Both parties may ask, and this is the record."
        />
      </label>

      <label className="mt-3 block text-sm">
        <span className="opacity-80">External mediator&rsquo;s opinion (optional)</span>
        <textarea
          value={mediator}
          onChange={(event) => setMediator(event.target.value)}
          rows={2}
          maxLength={4000}
          className="mt-1 w-full rounded border border-[var(--color-line)] bg-transparent p-2 text-sm"
        />
        {/* docs/04 §6: recorded, and nothing executes from it. */}
        <span className="mt-1 block text-xs opacity-60">
          Recorded only. The decision above is what executes.
        </span>
      </label>

      {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}

      <button
        type="button"
        onClick={submit}
        disabled={busy || reasonMissing || Boolean(splitIssue)}
        className="mt-4 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
      >
        {busy ? 'Issuing…' : 'Issue this decision'}
      </button>

      {reasonMissing ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          A decision cannot be issued without your reasoning. Both parties may ask why.
        </p>
      ) : null}
    </section>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="opacity-70">{label}</dt>
      <dd className={emphasis ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}
