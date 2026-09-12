import Link from 'next/link';

import { listArtists } from '@/lib/artists';
import { ArtistCard } from '@/components/artist-card';
import { EmptyState } from '@/components/empty-state';

export const dynamic = 'force-dynamic';

/** Category chips. Derived from the live set once #35's data exists. */
const CATEGORIES = ['Afrobeats', 'DJ', 'Gospel', 'Comedy', 'Live band'];

/**
 * Discovery grid — issue #13.
 *
 * `searchParams` is a Promise in Next 16: synchronous access was removed
 * entirely, not merely deprecated (`docs/` note recorded at #3).
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;

  let listing;
  let failed = false;
  try {
    listing = await listArtists({ category, limit: 24 });
  } catch {
    // A backend that is down is not a blank page. No status codes or stack
    // traces reach the user (docs/02 §2).
    failed = true;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-balance">
        Book an artist. Your payment is held until the event has happened.
      </h1>
      <p className="mt-4 max-w-2xl text-[var(--color-muted)]">
        Funds are held by a licensed bank, never by us, and released only when both
        sides confirm. If the artist does not show up, you are refunded.
      </p>

      <nav aria-label="Filter by category" className="mt-10 flex flex-wrap gap-2">
        <FilterChip href="/" active={!category}>
          All
        </FilterChip>
        {CATEGORIES.map((name) => (
          <FilterChip
            key={name}
            href={`/?category=${encodeURIComponent(name)}`}
            active={category === name}
          >
            {name}
          </FilterChip>
        ))}
      </nav>

      <div className="mt-8">
        {failed ? (
          <EmptyState title="We could not load artists just now.">
            Please refresh in a moment.
          </EmptyState>
        ) : listing!.artists.length === 0 ? (
          <EmptyState title={category ? `No ${category} artists yet.` : 'No artists yet.'}>
            {category ? (
              <>
                Try another category, or <Link href="/" className="underline">see everyone</Link>.
              </>
            ) : (
              'Check back soon.'
            )}
          </EmptyState>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listing!.artists.map((artist) => (
              <li key={artist.id}>
                <ArtistCard artist={artist} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
        active
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-paper)]'
          : 'border-[var(--color-line)] hover:border-[var(--color-ink)]'
      }`}
    >
      {children}
    </Link>
  );
}
