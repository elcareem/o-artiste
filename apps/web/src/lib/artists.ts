/**
 * Artist data access — issue #13.
 *
 * All money crossing this boundary is kobo integers. Nothing here converts;
 * `formatNaira()` does that at render, and only there.
 */

import { cache } from 'react';

import { ApiError, apiFetch } from './api';

export type Artist = {
  id: string;
  stageName: string;
  bio: string | null;
  category: string | null;
  location: string | null;
  /** Integer kobo. Never a formatted string. */
  baseRateKobo: number | null;
  media: unknown;
  /**
   * Percentage of this artist's recent bookings they cancelled, or `null`.
   *
   * `null` means the minimum-bookings threshold has not been met — NOT zero.
   * An artist with one cancelled booking out of one would read "100%", which is
   * noise presented as a verdict, so below the threshold the API says nothing
   * and the UI renders nothing (docs/06 §4).
   *
   * Populated in #35; `null` for every artist until then.
   */
  cancellationRate: number | null;
};

export type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type ArtistListing = {
  artists: Artist[];
  pagination: Pagination;
};

export function listArtists(params: {
  category?: string;
  location?: string;
  page?: number;
  limit?: number;
} = {}): Promise<ArtistListing> {
  const query = new URLSearchParams();
  if (params.category) query.set('category', params.category);
  if (params.location) query.set('location', params.location);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<ArtistListing>(`/artists${suffix}`);
}

/**
 * Wrapped in React's `cache()` so `generateMetadata` and the page component
 * share one request rather than each making their own.
 *
 * That matters because the artist has to be resolved in `generateMetadata` to
 * get a correct 404 status — see the comment on that function — and doing so
 * naively would double every profile page's API traffic.
 */
export const getArtist = cache(
  (id: string): Promise<{ artist: Artist }> =>
    apiFetch<{ artist: Artist }>(`/artists/${encodeURIComponent(id)}`)
);

/**
 * Returns the artist, or `null` if the API says there isn't one.
 *
 * A missing artist is an expected outcome here, not an exception — the API
 * returns 404 for suspended, unverified and unknown artists alike. Turning that
 * into `null` lets the page call `notFound()` directly in its body, which is
 * the pattern the framework documents and the one that actually produces a 404
 * status. Calling `notFound()` from inside a `catch` renders the right UI but
 * leaves the response at 200.
 *
 * Any other failure still throws — a provider outage must not masquerade as a
 * missing artist.
 */
export const getArtistOrNull = cache(async (id: string): Promise<Artist | null> => {
  try {
    const { artist } = await getArtist(id);
    return artist;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});
