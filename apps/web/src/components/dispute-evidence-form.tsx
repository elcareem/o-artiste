'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';

/** Adding a statement or a link to a dispute — issue #47. */
export function DisputeEvidenceForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [statement, setStatement] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = fileUrl.trim();
  const linkProblem = link && !/^https?:\/\/\S+$/i.test(link) ? 'Links must start with https://' : null;
  const empty = statement.trim() === '' && link === '';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (empty || linkProblem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(disputeId)}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statement: statement.trim() || undefined, fileUrl: link || undefined }),
      });
      if (!res.ok) {
        setError(failureMessage(await res.json().catch(() => null), `Your evidence was not added. ${NOTHING.saved}`));
        return;
      }
      setStatement('');
      setFileUrl('');
      router.refresh();
    } catch {
      setError(unreachable(NOTHING.saved));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3';
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <label className="block">
        <span className="font-medium">What happened, in your words</span>
        <textarea value={statement} onChange={(e) => setStatement(e.target.value)} rows={4} className={`${input} py-2`} />
      </label>
      <label className="block">
        <span className="font-medium">A link to a photo, video or document (optional)</span>
        <input value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} inputMode="url" placeholder="https://" className={`${input} min-h-11`} />
        {linkProblem && <span className="mt-1 block">{linkProblem}</span>}
      </label>
      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || empty || Boolean(linkProblem)}
        className="min-h-11 rounded-md border border-[var(--color-line)] px-4 font-medium hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add to the dispute'}
      </button>
    </form>
  );
}
