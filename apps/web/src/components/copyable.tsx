'use client';

import { useState } from 'react';

/**
 * A value the client has to type into their banking app — issue #21.
 *
 * THE TEXT IS SELECTABLE FIRST AND COPYABLE SECOND. `user-select: all` means one
 * tap selects the whole value on a phone, which works with no JavaScript, no
 * clipboard permission, and no secure context. The button is the convenience on
 * top; the selection is the guarantee.
 *
 * `navigator.clipboard` is unavailable on plain http and can be refused by the
 * browser, so the button reports failure honestly rather than claiming a copy
 * that did not happen — a client who trusts a silent failure pastes the wrong
 * account number.
 */
export function Copyable({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('unavailable');
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
        {/* select-all + break-all: one tap selects it, and a long value wraps
            instead of forcing the card to scroll sideways on a small screen. */}
        <div className="mt-1 select-all break-all font-medium tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-[var(--color-muted)]">{hint}</div>}
      </div>

      <button
        type="button"
        onClick={copy}
        // 44px minimum target — a mis-tap here is a mistyped account number.
        className="min-h-11 shrink-0 rounded-md border border-[var(--color-line)] px-3 text-sm transition-colors hover:border-[var(--color-accent)]"
        aria-label={`Copy ${label}`}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
      </button>
    </div>
  );
}
