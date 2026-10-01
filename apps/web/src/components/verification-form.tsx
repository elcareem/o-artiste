'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { failureMessage, unreachable } from '@/lib/error-messages';
import { IDENTIFIER_LENGTH, verificationBody, verificationProblems, type VerificationForm as Form } from '@/lib/verification';

/**
 * The NIN/BVN check, asked for honestly — issue #43.
 *
 * Three things the person is told BEFORE they agree: who runs the check, that
 * we pay for it, and that the number is not kept. The consent box starts
 * unticked and nothing ticks it for them; the API refuses the request without
 * it (#41), and this form refuses it first.
 */
export function VerificationForm({ next }: { next: string }) {
  const router = useRouter();
  const [form, setForm] = useState<Form>({ method: '', identifier: '', consent: false });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = verificationProblems(form);
  const show = (k: keyof Form) => (submitted ? problems[k] : undefined);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch('/api/verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verificationBody(form)),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        setError(failureMessage(payload, 'The check did not go through. Try again in a few minutes.'));
        // The status may have changed — a rejection, say — and the page should
        // show the state the backend now holds rather than this form.
        router.refresh();
        return;
      }

      router.replace(next);
      router.refresh();
    } catch {
      setError(unreachable('Nothing was checked.'));
    } finally {
      setBusy(false);
    }
  }

  const method = (value: 'NIN' | 'BVN', label: string) => (
    <label
      className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
        form.method === value ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]'
      }`}
    >
      <input
        type="radio"
        name="method"
        checked={form.method === value}
        onChange={() => setForm((f) => ({ ...f, method: value }))}
      />
      {label}
    </label>
  );

  return (
    <form onSubmit={submit} noValidate className="mt-8 space-y-5">
      <fieldset>
        <legend className="text-sm font-medium">Which number will you use?</legend>
        <div className="mt-2 flex gap-2">
          {method('NIN', 'NIN')}
          {method('BVN', 'BVN')}
        </div>
        {show('method') && <p className="mt-1 text-sm">{show('method')}</p>}
      </fieldset>

      <label className="block">
        <span className="text-sm font-medium">{form.method || 'NIN or BVN'}</span>
        <input
          value={form.identifier}
          onChange={(e) => setForm((f) => ({ ...f, identifier: e.target.value }))}
          inputMode="numeric"
          autoComplete="off"
          maxLength={IDENTIFIER_LENGTH + 4}
          placeholder={`${IDENTIFIER_LENGTH} digits`}
          aria-invalid={show('identifier') ? true : undefined}
          className="mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3 font-mono tracking-wider"
        />
        {show('identifier') && <span className="mt-1 block text-sm">{show('identifier')}</span>}
      </label>

      <div className="rounded-md border border-[var(--color-line)] p-3 text-sm">
        <p className="font-medium">Before you agree</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--color-muted)]">
          <li>Your number is checked by our payment partner, EscrowPay, through their licensed identity provider.</li>
          <li>We pay for the check. It costs you nothing.</li>
          <li>We keep only the result — that you are verified, and when. We do not store the number.</li>
        </ul>
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={form.consent}
            onChange={(e) => setForm((f) => ({ ...f, consent: e.target.checked }))}
            aria-invalid={show('consent') ? true : undefined}
            className="mt-1"
          />
          <span>I agree to my {form.method || 'NIN or BVN'} being checked to confirm my identity.</span>
        </label>
        {show('consent') && <p className="mt-1">{show('consent')}</p>}
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 w-full rounded-md border border-[var(--color-line)] font-medium hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Verify my identity'}
      </button>
    </form>
  );
}
