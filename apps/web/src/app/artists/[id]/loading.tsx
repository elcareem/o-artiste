/** Shown while an artist profile loads. */
export default function Loading() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="h-9 w-1/2 animate-pulse rounded bg-[var(--color-line)]" />
      <div className="mt-3 h-5 w-1/3 animate-pulse rounded bg-[var(--color-line)]" />
      <div className="mt-10 h-28 animate-pulse rounded-lg bg-[var(--color-line)]" />
      <div className="mt-6 h-12 w-48 animate-pulse rounded-lg bg-[var(--color-line)]" />
    </main>
  );
}
