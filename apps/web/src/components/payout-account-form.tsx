'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';

type Current = { registered: boolean; bankCode: string | null; accountLast4: string | null; accountName: string | null };

/**
 * Where an artist's money goes — issue #44.
 *
 * The full account number is typed once, sent on, and never shown again: the
 * backend keeps only the last four digits, and this shows only those. Someone
 * glancing at an artist's screen should not be able to read their account.
 */
export function PayoutAccountForm({ current, banks }: { current: Current; banks: { code: string; name: string }[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!current.registered);
  const [bankCode, setBankCode] = useState(current.bankCode ?? '');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState(current.accountName ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = accountNumber.replace(/\s/g, '');
  const problems: Record<string, string> = {};
  if (!bankCode) problems.bank = 'Choose your bank.';
  if (digits.length === 0) problems.number = 'Your account number is needed.';
  else if (!/^\d{10}$/.test(digits)) problems.number = `Account numbers are 10 digits — you have entered ${digits.length}.`;
  if (accountName.trim() === '') problems.name = 'The name on the account is needed.';
  const show = (k: string) => (submitted ? problems[k] : undefined);

  const bankName = (code: string | null) => banks.find((b) => b.code === code)?.name ?? 'Your bank';

  if (!editing) {
    return (
      <div className="rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
        <p className="font-medium">{bankName(current.bankCode)} · account ending {current.accountLast4}</p>
        {current.accountName && <p className="text-[var(--color-muted)]">{current.accountName}</p>}
        <button type="button" onClick={() => setEditing(true)} className="mt-2 underline">
          Change account
        </button>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch('/api/me/payout-account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankCode, accountNumber: digits, accountName: accountName.trim() }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(failureMessage(payload, `The account was not saved. ${NOTHING.saved}`));
        return;
      }
      // Cleared at once: the number should not sit in the page after it is saved.
      setAccountNumber('');
      setEditing(false);
      router.refresh();
    } catch {
      setError(unreachable(NOTHING.saved));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3';

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {banks.length === 0 && (
        <p className="text-sm">We could not load the list of banks just now. Refresh the page to try again.</p>
      )}
      <label className="block">
        <span className="text-sm font-medium">Bank</span>
        <select value={bankCode} onChange={(e) => setBankCode(e.target.value)} className={input}>
          <option value="">Choose your bank</option>
          {banks.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
        {show('bank') && <span className="mt-1 block text-sm">{show('bank')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Account number</span>
        <input
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          inputMode="numeric"
          autoComplete="off"
          maxLength={13}
          className={`${input} font-mono tracking-wider`}
        />
        {show('number') && <span className="mt-1 block text-sm">{show('number')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Name on the account</span>
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} className={input} />
        {show('name') && <span className="mt-1 block text-sm">{show('name')}</span>}
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md border border-[var(--color-line)] px-4 font-medium hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save account'}
        </button>
        {current.registered && (
          <button type="button" onClick={() => setEditing(false)} className="text-sm text-[var(--color-muted)]">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
