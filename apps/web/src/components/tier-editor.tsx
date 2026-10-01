'use client';

import { useState } from 'react';

import { tierProblems, type Tier } from '@/lib/settings';

/**
 * The cancellation tier table — issue #36.
 *
 * ROWS ARE ADDABLE AND DELETABLE, not merely editable. The band structure
 * itself will change, and an editor that only lets percentages be adjusted
 * forces a schema-shaped decision to be made in a database console.
 *
 * Validation mirrors #8's server-side rules so a gap is flagged while the
 * person is typing. The server stays authoritative: a set with a hole is
 * unsaveable whichever path the request arrives by, and this editor being wrong
 * would mean a confusing message, not a bad save.
 */
export function TierEditor({
  initial,
  editable,
  onSaved,
}: {
  initial: Tier[];
  editable: boolean;
  onSaved?: () => void;
}) {
  const [tiers, setTiers] = useState<Tier[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const problems = tierProblems(tiers);

  function update(index: number, patch: Partial<Tier>) {
    setTiers((current) => current.map((t, i) => (i === index ? { ...t, ...patch } : t)));
    setSaved(false);
  }

  function addRow() {
    const highest = tiers.reduce((max, t) => Math.max(max, t.maxDaysBefore ?? t.minDaysBefore), -1);
    setTiers((current) => [
      ...current,
      {
        minDaysBefore: highest + 1,
        maxDaysBefore: highest + 2,
        clientRefundBps: 5000,
        artistCompensationBps: 5000,
      },
    ]);
    setSaved(false);
  }

  function removeRow(index: number) {
    setTiers((current) => current.filter((_, i) => i !== index));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/admin/config/cancellation-tiers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiers }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        // The server's own wording. It is the authority on why a set is
        // invalid, and rewording it here would produce two sets of copy for the
        // same condition.
        setError(payload?.error ?? 'Could not save the cancellation bands.');
        return;
      }

      setSaved(true);
      onSaved?.();
    } catch {
      setError('Could not reach the server. Nothing has been saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-line)] p-4">
      <h2 className="font-medium">Cancellation bands</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        What a client gets back, by how far ahead they cancel. Saving creates a new version;
        existing bookings keep the bands they were made under.
      </p>

      <div className="mt-4 space-y-2">
        {tiers.map((tier, index) => (
          <div key={index} className="flex flex-wrap items-end gap-2 rounded border border-[var(--color-line)] p-2">
            <Field
              label="From (days)"
              value={tier.minDaysBefore}
              disabled={!editable}
              onChange={(v) => update(index, { minDaysBefore: v ?? 0 })}
            />
            <Field
              label="To (days)"
              value={tier.maxDaysBefore}
              disabled={!editable}
              nullable
              onChange={(v) => update(index, { maxDaysBefore: v })}
            />
            <Field
              label="Client %"
              value={tier.clientRefundBps / 100}
              disabled={!editable}
              onChange={(v) =>
                update(index, {
                  clientRefundBps: Math.round((v ?? 0) * 100),
                  // Kept summing to 100% as you type. Two independent fields
                  // that must total 10000 bps is a trap, and #8 rejects the set
                  // anyway — better to make the invalid state unreachable.
                  artistCompensationBps: 10000 - Math.round((v ?? 0) * 100),
                })
              }
            />
            <div className="text-xs text-[var(--color-muted)]">
              Artist {tier.artistCompensationBps / 100}%
            </div>

            {editable && (
              <button
                type="button"
                onClick={() => removeRow(index)}
                className="ml-auto text-xs underline underline-offset-4"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {editable && (
        <button type="button" onClick={addRow} className="mt-3 text-sm underline underline-offset-4">
          Add a band
        </button>
      )}

      {problems.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-amber-400">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {error ? <p className="mt-3 text-sm text-rose-400">{error}</p> : null}
      {saved ? <p className="mt-3 text-sm text-emerald-400">Saved as a new version.</p> : null}

      {editable && (
        <button
          type="button"
          onClick={save}
          disabled={busy || problems.length > 0}
          className="mt-4 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save as a new version'}
        </button>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  nullable,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  nullable?: boolean;
}) {
  return (
    <label className="text-xs">
      <span className="block opacity-70">{label}</span>
      <input
        inputMode="numeric"
        disabled={disabled}
        value={value === null ? '' : String(value)}
        placeholder={nullable ? 'any' : ''}
        onChange={(event) => {
          const raw = event.target.value.replace(/[^\d]/g, '');
          onChange(raw === '' ? (nullable ? null : 0) : Number(raw));
        }}
        className="mt-1 w-24 rounded border border-[var(--color-line)] bg-transparent p-1.5 tabular-nums disabled:opacity-50"
      />
    </label>
  );
}
