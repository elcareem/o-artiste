/** Shown while the artist grid loads. */
export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="h-9 w-3/4 animate-pulse rounded bg-[var(--color-line)]" />
      <div className="mt-4 h-5 w-1/2 animate-pulse rounded bg-[var(--color-line)]" />
      <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="h-32 animate-pulse rounded-lg bg-[var(--color-line)]" />
        ))}
      </ul>
    </main>
  );
}
