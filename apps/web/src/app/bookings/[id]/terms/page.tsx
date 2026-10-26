import { notFound, redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, currentUser } from '@/lib/session';
import { bandSentences, type Band } from '@/lib/booking-request';
import { formatNaira } from '@/lib/currency';
import { formatLagos } from '@/lib/dates';
import { failureMessage, RETRY, unreachable } from '@/lib/error-messages';
import { TermsAcceptance } from '@/components/terms-acceptance';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cancellation terms', robots: { index: false, follow: false } };

/**
 * The booking's cancellation terms, before payment — issue #46.
 *
 * Read from the booking's own SNAPSHOT (`GET /bookings/:id/terms`), never from
 * the current configuration: these are the terms that will execute, however
 * the platform's table changes after today.
 */
export default async function TermsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/bookings/${id}/terms`)}`);

  let terms: { amountKobo: number; eventDate: string; commissionRateBps: number; tiers: Band[]; acknowledged: boolean } | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${BASE_URL}/bookings/${encodeURIComponent(id)}/terms`, { headers: await authHeader(), cache: 'no-store' });
    if (res.status === 404) notFound();
    const body = await res.json().catch(() => null);
    if (!res.ok) error = failureMessage(body, 'Could not load the terms for this booking.');
    else terms = body.terms;
  } catch {
    error = unreachable(RETRY);
  }

  // Already agreed: nothing to do here, and the status page has the next step.
  if (terms?.acknowledged) redirect(`/booking-status/${encodeURIComponent(id)}`);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">If you need to cancel</h1>

      {error || !terms ? (
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">{error}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            For your {formatNaira(terms.amountKobo)} booking on {formatLagos(terms.eventDate, 'dateTime')}. The closer to the
            event you cancel, the more of the fee goes to the artist, who has held the date for you.
          </p>

          <dl className="mt-6 divide-y divide-[var(--color-line)] rounded-md border border-[var(--color-line)] text-sm">
            {bandSentences(terms.tiers, terms.amountKobo).map((b) => (
              <div key={b.when} className="px-4 py-3">
                <dt className="font-medium">{b.when}</dt>
                <dd className="mt-0.5 text-[var(--color-muted)]">{b.outcome}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-4 text-xs text-[var(--color-muted)]">
            If the artist cancels, you get everything back, including the payment fee. These terms are fixed for this booking
            and will not change.
          </p>

          <TermsAcceptance bookingId={id} bands={terms.tiers} />
        </>
      )}
    </div>
  );
}
