import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getArtist } from '@/lib/artists';
import { formatNaira } from '@/lib/currency';
import { CancellationRate } from '@/components/cancellation-rate';
import { ApiError } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Resolves the artist BEFORE the page streams.
 *
 * `loading.tsx` on this route creates a Suspense boundary, so by the time the
 * page component runs Next has already sent the shell — and the status line.
 * Calling `notFound()` there renders the right page with a 200, which is
 * correct for a person and wrong for a crawler, since a suspended artist's URL
 * would stay indexed.
 *
 * `generateMetadata` runs before any of that, so a `notFound()` here sets a real
 * 404. `getArtist` is request-cached, so the page component's own call reuses
 * this one rather than hitting the API twice.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const { artist } = await getArtist(id);
    return {
      title: `${artist.stageName} — Artist Escrow`,
      description: artist.bio ?? `Book ${artist.stageName}.`,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    // Anything else is a real failure and should surface as one, not as a 404.
    throw error;
  }
}

/**
 * Artist profile — issue #13.
 *
 * `params` is a Promise in Next 16. The cancellation-rate stat sits ABOVE the
 * booking action: it exists so a client can weigh reliability before
 * committing, which requires seeing it before the decision, not in a footer or
 * on a review page afterwards (docs/06 §4).
 */
export default async function ArtistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let artist;
  try {
    ({ artist } = await getArtist(id));
  } catch (error) {
    // A suspended or unknown artist is a 404 from the API, and a 404 here.
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/" className="text-sm text-[var(--color-muted)] underline">
        ← All artists
      </Link>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">{artist.stageName}</h1>

      <p className="mt-2 text-[var(--color-muted)]">
        {[artist.category, artist.location].filter(Boolean).join(' · ')}
      </p>

      {artist.bio ? <p className="mt-6 leading-relaxed">{artist.bio}</p> : null}

      <section aria-label="Rate" className="mt-10 rounded-lg border border-[var(--color-line)] p-6">
        <div className="text-xs tracking-wide text-[var(--color-muted)] uppercase">From</div>
        <div className="mt-1 text-3xl font-semibold tabular-nums">
          {artist.baseRateKobo === null ? 'Rate on request' : formatNaira(artist.baseRateKobo)}
        </div>
      </section>

      {/*
        Above the booking action, deliberately. Renders nothing at all when the
        rate is null — no placeholder, no "N/A", no zero.
      */}
      <div className="mt-6">
        <CancellationRate rate={artist.cancellationRate} />
      </div>

      <div className="mt-6">
        <Link
          href={`/artists/${artist.id}/book`}
          data-testid="booking-cta"
          className="inline-flex rounded-lg bg-[var(--color-accent)] px-6 py-3 font-medium text-white"
        >
          Book {artist.stageName}
        </Link>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          You will see the cancellation terms before you pay.
        </p>
      </div>
    </main>
  );
}
