import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { currentUser } from '@/lib/session';
import { BookingRequestForm } from '@/components/booking-request-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Book an artist', robots: { index: false, follow: false } };

/**
 * Request a booking — issue #46. Every artist profile's "Book" button has
 * pointed here since #13, and until now it was a 404.
 */
export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `/artists/${id}/book`;

  const user = await currentUser();
  if (!user) redirect(`/signup?as=client&next=${encodeURIComponent(here)}`);
  if (user.role === 'CLIENT' && user.verificationStatus !== 'VERIFIED') {
    redirect(`/verify?next=${encodeURIComponent(here)}`);
  }

  let artist: { id: string; stageName: string; baseRateKobo: number | null } | null = null;
  try {
    const res = await fetch(`${BASE_URL}/artists/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) notFound();
    if (res.ok) artist = (await res.json()).artist;
  } catch {
    artist = null;
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12">
      <Link href={`/artists/${id}`} className="text-sm underline">
        Back to {artist?.stageName ?? 'the artist'}
      </Link>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Book {artist?.stageName ?? 'this artist'}</h1>

      {user.role !== 'CLIENT' ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          Bookings are made from a client account. Artists and admins cannot book.
        </p>
      ) : !artist ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          We could not load this artist just now. Refresh the page to try again.
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Your payment is held by a licensed bank and released to {artist.stageName} only after the event.
          </p>
          <BookingRequestForm artistId={artist.id} artistName={artist.stageName} rateKobo={artist.baseRateKobo} />
        </>
      )}
    </div>
  );
}
