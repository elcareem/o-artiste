import Link from 'next/link';

import { formatNaira } from '@/lib/currency';
import type { Artist } from '@/lib/artists';

export function ArtistCard({ artist }: { artist: Artist }) {
  return (
    <Link
      href={`/artists/${artist.id}`}
      className="block rounded-lg border border-[var(--color-line)] p-5 transition-colors hover:border-[var(--color-accent)]"
    >
      <h2 className="font-semibold tracking-tight">{artist.stageName}</h2>

      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {[artist.category, artist.location].filter(Boolean).join(' · ')}
      </p>

      {artist.baseRateKobo !== null && (
        <p className="mt-4 font-medium tabular-nums">
          {/* Kobo in, Naira out — the only place conversion happens. */}
          {formatNaira(artist.baseRateKobo)}
          <span className="ml-1 text-sm font-normal text-[var(--color-muted)]">from</span>
        </p>
      )}
    </Link>
  );
}
