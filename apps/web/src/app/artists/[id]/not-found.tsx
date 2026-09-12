import Link from 'next/link';

/** A suspended or unknown artist. Readable, and never a status code. */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">This artist is not available.</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        They may no longer be taking bookings.
      </p>
      <Link href="/" className="mt-8 inline-flex underline">
        Browse all artists
      </Link>
    </main>
  );
}
