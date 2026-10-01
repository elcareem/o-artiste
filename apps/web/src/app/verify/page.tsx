import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, currentUser } from '@/lib/session';
import { homeFor } from '@/lib/signup';
import { viewFor } from '@/lib/verification';
import { VerificationForm } from '@/components/verification-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Verify your identity', robots: { index: false, follow: false } };

/** Only same-site paths, so `?next=` cannot send anyone off the site. */
function safeNext(raw: string | undefined, fallback: string): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : fallback;
}

/**
 * Identity verification — issue #43.
 *
 * Reads the status from the backend on every visit, so the page always shows
 * what is true now — including after a submission changed it.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/verify${params.next ? `?next=${params.next}` : ''}`)}`);

  const next = safeNext(params.next, homeFor(user.role));

  let status: string | null = user.verificationStatus;
  try {
    const res = await fetch(`${BASE_URL}/me/verification`, { headers: await authHeader(), cache: 'no-store' });
    if (res.ok) status = ((await res.json()) as { verification?: { status?: string } }).verification?.status ?? status;
  } catch {
    // Fall back to what /me said. The form is safe to show either way: the
    // backend answers a verified user without calling the provider.
  }

  const view = viewFor(status);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">{view.headline}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{view.detail}</p>

      {view.mode === 'form' && <VerificationForm next={next} />}

      {view.mode === 'done' && (
        <Link
          href={next}
          className="mt-8 inline-block rounded-md border border-[var(--color-line)] px-4 py-2 text-sm font-medium hover:border-[var(--color-accent)]"
        >
          Continue
        </Link>
      )}
    </div>
  );
}
