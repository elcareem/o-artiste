/**
 * A readable empty state, never a blank page.
 *
 * An empty filter result is a normal outcome, not an error — it should say what
 * happened and offer the way out, rather than leaving someone staring at
 * nothing wondering whether the page is broken.
 */
export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div
      data-testid="empty-state"
      className="rounded-lg border border-dashed border-[var(--color-line)] px-6 py-12 text-center"
    >
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-2 text-sm text-[var(--color-muted)]">{children}</p> : null}
    </div>
  );
}
