'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatNaira } from '@/lib/currency';
import {
  isPayable,
  isTerminal,
  pollDelayMs,
  statusCopy,
  type Booking,
  type FundingInstruction,
} from '@/lib/booking-status';
import { Copyable } from './copyable';

/**
 * The post-checkout status page — issue #21.
 *
 * Bank transfer funding is out-of-band: the client leaves to make a transfer and
 * comes back, sometimes on another device, sometimes an hour later. This page
 * has to hold a useful state across that gap and move on its own when the
 * webhook lands, without the reader knowing what a webhook is.
 *
 * POLLING STOPS AT A TERMINAL STATE. A page left open on a finished booking
 * that keeps hitting the API is a battery and bandwidth cost paid by the person
 * who already completed their transaction.
 */

const TONE_CLASS = {
  waiting: 'border-amber-500/40 bg-amber-500/5',
  holding: 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5',
  settled: 'border-emerald-500/40 bg-emerald-500/5',
  attention: 'border-rose-500/40 bg-rose-500/5',
} as const;

export function BookingStatusView({
  bookingId,
  initialBooking,
  initialFunding,
  initialError,
}: {
  bookingId: string;
  initialBooking: Booking | null;
  initialFunding: FundingInstruction | null;
  initialError: string | null;
}) {
  const [booking, setBooking] = useState(initialBooking);
  const [error, setError] = useState(initialError);

  // Held in a ref so a poll in flight never reads a stale count, and so
  // changing it does not re-run the effect.
  const failures = useRef(0);

  // DERIVED, not state. The funding instruction is fixed for the life of the
  // page, and whether polling has stopped is a fact about the booking's state.
  // Mirroring either into useState only creates a second copy that can
  // disagree with the first.
  const funding = initialFunding;
  const stopped = booking ? isTerminal(booking.state) : false;

  const poll = useCallback(async (): Promise<number> => {
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}`, {
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        // The backend's own wording, rendered unaltered. No status codes, no
        // error objects, nothing a person cannot act on (docs/02 §2).
        setError(readError(payload) ?? 'Something went wrong. Please try again.');
        failures.current += 1;
        return pollDelayMs(failures.current);
      }

      failures.current = 0;
      setError(null);
      const next = (payload as { booking?: Booking } | null)?.booking ?? null;
      if (next) setBooking(next);
      return pollDelayMs(0);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      failures.current += 1;
      return pollDelayMs(failures.current);
    }
  }, [bookingId]);

  useEffect(() => {
    if (stopped) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // Chained timeouts rather than setInterval: a slow response must not stack
    // up requests behind it, and the delay changes with the failure count.
    const loop = async () => {
      const delay = await poll();
      if (!cancelled) timer = setTimeout(loop, delay);
    };

    timer = setTimeout(loop, pollDelayMs(0));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, stopped]);

  if (!booking) {
    return (
      <Message
        title="We could not load this booking"
        body={error ?? 'Something went wrong. Please try again.'}
      />
    );
  }

  const copy = statusCopy(booking.state);
  const awaitingPayment = booking.state === 'PENDING_PAYMENT';
  const payable = isPayable(funding?.bankTransfer);

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <div className={`rounded-lg border p-5 ${TONE_CLASS[copy.tone]}`}>
        <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{copy.label}</div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{copy.headline}</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{copy.detail}</p>
      </div>

      {error && (
        <p
          role="status"
          className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm text-[var(--color-muted)]"
        >
          {error} We are still checking.
        </p>
      )}

      {awaitingPayment && funding && (
        <section className="mt-6 rounded-lg border border-[var(--color-line)] p-5">
          <h2 className="font-semibold tracking-tight">Transfer the exact amount</h2>

          <p className="mt-3 text-2xl font-semibold tabular-nums">
            {formatNaira(funding.amountToTransferKobo)}
          </p>

          {/* BOTH FIGURES ARE NAMED. The provider charges its fee to the payer
              on top of the booking amount rather than deducting it from the
              escrow, so a client expecting to send ₦200,000 is asked for
              ₦202,000. Being surprised by that at the banking app is exactly
              what the disclosure rules exist to prevent (docs/05 §1). */}
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {formatNaira(funding.bookingAmountKobo)} for the booking, plus{' '}
            {formatNaira(funding.providerFeeKobo)} in bank charges.
          </p>

          {payable ? (
            <div className="mt-5">
              <Copyable label="Account number" value={funding.bankTransfer!.accountNumber} />
              <Copyable label="Account name" value={funding.bankTransfer!.accountName} />
              {funding.bankTransfer!.provider && (
                <Copyable label="Bank" value={funding.bankTransfer!.provider} />
              )}
              <Copyable
                label="Reference"
                value={booking.escrowReference}
                hint="Include this if your bank lets you add a narration."
              />
            </div>
          ) : (
            // A masked or missing account number cannot be paid into. Saying so
            // is better than rendering "****4680" as though it were dialable.
            <p className="mt-5 text-sm text-[var(--color-muted)]">
              We are still setting up your transfer details. This page will show
              them shortly — leave it open.
            </p>
          )}

          <p className="mt-5 text-xs leading-relaxed text-[var(--color-muted)]">
            Send the amount in one transfer from your own bank account. Your money
            is held by a licensed bank until after the event.
          </p>
        </section>
      )}

      <dl className="mt-6 rounded-lg border border-[var(--color-line)] p-5 text-sm">
        <Row label="Booking amount" value={formatNaira(booking.amountKobo)} />
        <Row label="Event date" value={formatEventDate(booking.eventDate)} />
        {booking.eventLocation && <Row label="Location" value={booking.eventLocation} />}
        <Row label="Reference" value={booking.escrowReference} />
      </dl>

      <p className="mt-4 text-xs text-[var(--color-muted)]">
        {stopped
          ? 'This booking is complete, so this page has stopped updating.'
          : 'This page updates on its own. You do not need to refresh it.'}
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[var(--color-line)] py-2 last:border-b-0">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-16 text-center">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
    </div>
  );
}

function formatEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-NG', { dateStyle: 'full' }).format(date);
}

function readError(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const { error } = payload as { error: unknown };
    if (typeof error === 'string' && error.trim().length > 0) return error;
  }
  return null;
}
