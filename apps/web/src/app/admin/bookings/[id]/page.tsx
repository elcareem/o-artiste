import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { statusCopy } from '@/lib/booking-status';
import {
  ledgerLines,
  netPositions,
  payoutProblem,
  reconciliationProblem,
  type Reconciliation,
} from '@/lib/ledger';
import { ManualMoneyAction } from '@/components/manual-money-action';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Booking',
  robots: { index: false, follow: false },
};

type Detail = {
  booking: {
    id: string;
    escrowReference: string;
    state: string;
    amountKobo: number;
    commissionRateBpsSnapshot: number;
    eventDate: string;
    eventEndAt: string;
    eventLocation: string | null;
    createdAt: string;
    paidOutAt: string | null;
    clientConfirmedAt: string | null;
    artistConfirmedAt: string | null;
    autoReleaseAt: string | null;
    client: { displayName: string | null; email: string | null; phone: string | null };
    artist: { stageName: string | null; email: string | null; phone: string | null };
    awaitingPayout: boolean;
  };
  timeline: {
    fromState: string | null;
    toState: string;
    at: string;
    actor: { email: string; role: string } | null;
    reason: string | null;
    reconstructed: boolean;
  }[];
  checkIn: {
    redeemedAt: string;
    latitude: string | null;
    longitude: string | null;
    accuracyMeters: string | null;
  } | null;
  termsAcknowledgement: {
    acknowledgedAt: string;
    commissionRateBpsAsDisplayed: number;
    tiersAsDisplayed: {
      minDaysBefore: number;
      maxDaysBefore: number | null;
      clientRefundBps: number;
      artistCompensationBps: number;
    }[];
    ipAddress: string | null;
  } | null;
  projection: {
    amountKobo: number;
    clientPaysKobo: number;
    commissionKobo: number;
    moneyInFeeKobo: number;
    moneyOutFeeKobo: number;
    artistNetKobo: number;
    platformNetKobo: number;
  };
  ledger: Reconciliation;
};

const when = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString('en-NG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const band = (tier: { minDaysBefore: number; maxDaysBefore: number | null }) =>
  tier.maxDaysBefore === null
    ? `${tier.minDaysBefore}+ days before`
    : tier.minDaysBefore === tier.maxDaysBefore
      ? `${tier.minDaysBefore} days before`
      : `${tier.minDaysBefore}–${tier.maxDaysBefore} days before`;

/**
 * One booking, in full — issue #37, docs/07 §7.
 *
 * The order of this page is the order of the question it answers. A client asks
 * why they received ₦137,860; the reconciliation comes first, because that is
 * the answer. Then the sequence that produced it. Then the evidence — check-in
 * and acknowledgement — because that is what a challenge to the figures turns
 * on. The manual actions come last, where someone arrives only after reading.
 */
export default async function AdminBookingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await sessionToken())) redirect(`/login?next=/admin/bookings/${id}`);

  const headers = await authHeader();
  let detail: Detail | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/admin/bookings/${encodeURIComponent(id)}`, {
      headers,
      cache: 'no-store',
    });

    if (response.status === 404) notFound();

    const payload = await response.json().catch(() => null);
    if (response.status === 403) {
      error = 'This page is for administrators.';
    } else if (!response.ok) {
      error = payload?.error ?? 'Could not load this booking.';
    } else {
      detail = payload as Detail;
    }
  } catch {
    error = 'Could not reach the server. Check your connection and try again.';
  }

  if (error || !detail) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <Link href="/admin/bookings" className="text-sm underline">
          Back to bookings
        </Link>
        <p className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {error}
        </p>
      </div>
    );
  }

  const { booking, ledger } = detail;
  const lines = ledgerLines(ledger.entries);
  const problem = reconciliationProblem(booking.state, ledger);
  const payout = payoutProblem(booking.state, booking.paidOutAt);
  const clientName = booking.client.displayName ?? booking.client.email ?? 'the client';
  const artistName = booking.artist.stageName ?? 'the artist';

  // What a release would pay, computed by the backend with the same function
  // the real release uses. Reading the ledger's artist position instead would
  // show ₦0 on every booking that has not been released yet — which is every
  // booking where the button is offered.
  // `artistNetKobo` is already the artist's full payment: the amount less
  // commission. The payout fee is NOT deducted from it — that fee is borne by
  // the platform and reduces our take, not theirs (#18, docs/00 §8).
  const artistShareKobo = detail.projection.artistNetKobo;

  const available: ('release' | 'refund')[] =
    booking.state === 'CHECKED_IN' || booking.state === 'AWAITING_CONFIRMATION'
      ? ['release', 'refund']
      : booking.state === 'FUNDED_HELD'
        ? ['refund']
        : [];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <Link href="/admin/bookings" className="text-sm underline">
        Back to bookings
      </Link>

      <h1 className="mt-4 text-xl font-semibold tracking-tight">
        {artistName} for {clientName}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {formatNaira(booking.amountKobo)} · {statusCopy(booking.state).label} ·{' '}
        {when(booking.eventDate)}
        {booking.eventLocation ? ` · ${booking.eventLocation}` : ''}
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Reference {booking.escrowReference}
      </p>

      {problem && (
        <p className="mt-6 rounded-md border-2 border-[var(--color-line)] px-4 py-3 text-sm font-medium">
          {problem}
        </p>
      )}
      {payout && (
        <p className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          {payout}
        </p>
      )}

      {/* THE ANSWER, FIRST. Someone opening this page has been asked a question
          about an amount, and the net position is the reply. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold">Where the money stands</h2>
        <table className="mt-2 w-full border-collapse text-sm">
          <tbody>
            {netPositions(ledger.netByParty).map((position) => (
              <tr key={position.party} className="border-b border-[var(--color-line)]">
                <td className="py-2">{position.label}</td>
                <td className="py-2 text-right tabular-nums">
                  {position.amountKobo < 0 ? '−' : ''}
                  {formatNaira(Math.abs(position.amountKobo))}
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-2 font-medium">Net</td>
              <td className="py-2 text-right font-medium tabular-nums">
                {/* Zero on a settled booking. Printed rather than asserted, so
                    the reader sees the check rather than trusting it. */}
                {formatNaira(Math.abs(ledger.sumKobo))}
                {ledger.sumKobo === 0 ? ' — balanced' : ' — does not balance'}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Every entry</h2>
        {lines.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No money has moved on this booking yet.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left">
                  <th className="py-2 pr-3 font-medium">What</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.entry.id} className="border-b border-[var(--color-line)]">
                    <td className={`py-2 pr-3 ${line.reversed ? 'line-through opacity-60' : ''}`}>
                      {line.label}
                      {/* A correction names what it offsets, so the pair reads
                          as "charged, then reversed" rather than as two entries
                          that happen to cancel out (docs/01 §5). */}
                      {line.isCorrection && line.offsets && (
                        <span className="block text-xs text-[var(--color-muted)]">
                          Reverses: {ledgerLines([line.offsets])[0].label}
                        </span>
                      )}
                      {line.entry.description && (
                        <span className="block text-xs text-[var(--color-muted)]">
                          {line.entry.description}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">{line.party}</td>
                    <td
                      className={`py-2 pr-3 text-right tabular-nums ${line.reversed ? 'line-through opacity-60' : ''}`}
                    >
                      {line.direction === 'out' ? '−' : ''}
                      {formatNaira(Math.abs(line.entry.amountKobo))}
                    </td>
                    <td className="py-2 whitespace-nowrap text-[var(--color-muted)]">
                      {when(line.entry.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">How it got here</h2>
        <ol className="mt-2 space-y-2 text-sm">
          {detail.timeline.map((step, index) => (
            <li key={`${step.toState}-${index}`} className="border-b border-[var(--color-line)] pb-2">
              <span className="font-medium">{statusCopy(step.toState).label}</span>
              <span className="text-[var(--color-muted)]"> · {when(step.at)}</span>
              {step.actor && (
                <span className="text-[var(--color-muted)]">
                  {' '}
                  · {step.actor.email}
                </span>
              )}
              {step.reason && <span className="block text-xs">{step.reason}</span>}
              {step.reconstructed && (
                // Said plainly. An admin deciding whether to move money needs to
                // know the difference between a recorded fact and a derived one.
                <span className="block text-xs text-[var(--color-muted)]">
                  Worked out from the booking&apos;s timestamps — this predates the change history.
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Evidence</h2>
        <dl className="mt-2 space-y-3 text-sm">
          <div>
            <dt className="font-medium">Check-in</dt>
            <dd className="text-[var(--color-muted)]">
              {detail.checkIn ? (
                <>
                  Code redeemed {when(detail.checkIn.redeemedAt)}
                  {detail.checkIn.latitude && detail.checkIn.longitude
                    ? ` · ${detail.checkIn.latitude}, ${detail.checkIn.longitude}${
                        detail.checkIn.accuracyMeters
                          ? ` (±${detail.checkIn.accuracyMeters}m)`
                          : ''
                      }`
                    : ''}
                </>
              ) : (
                'No code was redeemed for this booking.'
              )}
            </dd>
          </div>

          <div>
            <dt className="font-medium">Confirmations</dt>
            <dd className="text-[var(--color-muted)]">
              Client {when(booking.clientConfirmedAt)} · Artist {when(booking.artistConfirmedAt)}
              {booking.autoReleaseAt && booking.state === 'AWAITING_CONFIRMATION'
                ? ` · releases on its own ${when(booking.autoReleaseAt)}`
                : ''}
            </dd>
          </div>

          <div>
            <dt className="font-medium">Terms the client agreed to</dt>
            <dd className="text-[var(--color-muted)]">
              {detail.termsAcknowledgement ? (
                <>
                  Accepted {when(detail.termsAcknowledgement.acknowledgedAt)}
                  {detail.termsAcknowledgement.ipAddress
                    ? ` from ${detail.termsAcknowledgement.ipAddress}`
                    : ''}
                  , showing {detail.termsAcknowledgement.commissionRateBpsAsDisplayed / 100}%
                  commission.
                  {/* WHAT THEY SAW, copied by value at the time — not the
                      configuration in force now. A deduction we cannot prove was
                      disclosed is one we may not be able to defend (#16). */}
                  <ul className="mt-1 list-disc pl-5">
                    {detail.termsAcknowledgement.tiersAsDisplayed
                      .slice()
                      .sort((a, b) => a.minDaysBefore - b.minDaysBefore)
                      .map((tier) => (
                        <li key={tier.minDaysBefore}>
                          {band(tier)}: {tier.clientRefundBps / 100}% back to the client,{' '}
                          {tier.artistCompensationBps / 100}% to the artist
                        </li>
                      ))}
                  </ul>
                </>
              ) : (
                'This booking has no recorded acknowledgement.'
              )}
            </dd>
          </div>
        </dl>
      </section>

      <ManualMoneyAction
        bookingId={booking.id}
        amountKobo={booking.amountKobo}
        artistShareKobo={artistShareKobo}
        artistName={artistName}
        clientName={clientName}
        available={available}
      />
    </div>
  );
}
