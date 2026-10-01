'use client';

import { useState } from 'react';

import { commissionPreview } from '@/lib/settings';

/**
 * The commission rate — issue #36, docs/07 §3.
 *
 * THE PREVIEW IS THE POINT. A basis-point change is hard to reason about in the
 * abstract and easy to reason about as "this ₦200,000 booking would pay
 * ₦188,000 instead of ₦190,000" (docs/07 §6). Nobody should have to do that
 * arithmetic in their head before changing what every artist earns.
 *
 * `editable` comes from the server, which decides it from the caller's role.
 * The field is SHOWN to an admin and disabled — a screen that silently lacks a
 * section tells them less than one that says "not yours to change".
 */
const SAMPLE_KOBO = 20000000; // ₦200,000

export function CommissionEditor({
  currentBps,
  editable,
}: {
  currentBps: number;
  editable: boolean;
}) {
  const [value, setValue] = useState(String(currentBps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const proposed = Number(value);
  const valid = Number.isInteger(proposed) && proposed >= 0 && proposed <= 10000;
  const changed = valid && proposed !== currentBps;

  const preview = valid ? commissionPreview(SAMPLE_KOBO, currentBps, proposed) : null;

  async function save() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/config/commission', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateBasisPoints: proposed }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        setError(payload?.error ?? 'Could not save the commission rate.');
        return;
      }
      setSaved(true);
    } catch {
      setError('Could not reach the server. Nothing has been saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-line)] p-4">
      <h2 className="font-medium">Commission</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        What the platform takes from the artist&rsquo;s share. Applies to bookings made after the
        change, never to existing ones.
      </p>

      <label className="mt-4 block text-sm">
        <span className="opacity-80">Rate, in basis points (500 = 5%)</span>
        <input
          inputMode="numeric"
          data-testid="commission-field"
          disabled={!editable}
          value={value}
          onChange={(event) => {
            setValue(event.target.value.replace(/[^\d]/g, ''));
            setSaved(false);
          }}
          className="mt-1 w-32 rounded border border-[var(--color-line)] bg-transparent p-2 tabular-nums disabled:opacity-50"
        />
      </label>

      {!valid && value !== '' ? (
        <p className="mt-2 text-sm text-amber-400">
          The rate must be between 0 and 10000 basis points — that is 0% to 100%.
        </p>
      ) : null}

      {/* The preview #36 asks for, shown before saving rather than after. */}
      {preview && changed ? (
        <p className="mt-3 text-sm">
          A ₦200,000 booking would pay the artist{' '}
          <span className="font-semibold tabular-nums">{preview.proposed}</span> instead of{' '}
          <span className="tabular-nums">{preview.current}</span> — {preview.worse ? 'a reduction' : 'an increase'}{' '}
          of <span className="tabular-nums">{preview.difference}</span>.
        </p>
      ) : null}

      {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
      {saved ? <p className="mt-3 text-sm text-emerald-400">Saved as a new version.</p> : null}

      {editable ? (
        <button
          type="button"
          onClick={save}
          disabled={busy || !changed}
          className="mt-4 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save as a new version'}
        </button>
      ) : (
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          Only a super-admin can change the commission rate.
        </p>
      )}
    </section>
  );
}
