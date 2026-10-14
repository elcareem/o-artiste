'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { eventWindow, requestProblems, type RequestFields } from '@/lib/booking-request';
import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';
import { formatLagos } from '@/lib/dates';
import { formatNaira } from '@/lib/currency';
import { koboToNairaInput, parseNairaToKobo } from '@/lib/naira';

/**
 * Requesting a booking — issue #46.
 *
 * Times are typed as LAGOS times and sent as instants with the offset written
 * in, so a visitor in another timezone still books 8pm Lagos. An end earlier
 * than the start is read as the next morning, and said back.
 *
 * Nothing is charged here. Creating the booking only holds the terms; the next
 * page shows them and asks for agreement before any payment details appear.
 */
export function BookingRequestForm({ artistId, artistName, rateKobo }: { artistId: string; artistName: string; rateKobo: number | null }) {
  const router = useRouter();
  const [f, setF] = useState<RequestFields>({ date: '', start: '20:00', end: '23:00', location: '', amount: koboToNairaInput(rateKobo) });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = requestProblems(f);
  const show = (k: keyof RequestFields) => (submitted ? problems[k] : undefined);
  const set = (k: keyof RequestFields) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const window = f.date && f.start && f.end ? eventWindow(f.date, f.start, f.end) : null;
  const amount = parseNairaToKobo(f.amount);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(problems).length > 0 || !window || !amount.ok) return;

    setBusy(true);
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artistId,
          amountKobo: amount.kobo,
          eventDate: window.startIso,
          eventEndAt: window.endIso,
          eventLocation: f.location.trim(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(failureMessage(payload, `The request did not go through. ${NOTHING.charged}`));
        return;
      }
      router.push(`/bookings/${encodeURIComponent(payload.booking.id)}/terms`);
    } catch {
      setError(unreachable(NOTHING.charged));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3';

  return (
    <form onSubmit={submit} noValidate className="mt-8 space-y-5">
      <label className="block">
        <span className="text-sm font-medium">Date</span>
        <input type="date" value={f.date} onChange={set('date')} min={new Date().toISOString().slice(0, 10)} className={input} />
        {show('date') && <span className="mt-1 block text-sm">{show('date')}</span>}
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium">Starts</span>
          <input type="time" value={f.start} onChange={set('start')} className={input} />
          {show('start') && <span className="mt-1 block text-sm">{show('start')}</span>}
        </label>
        <label className="block">
          <span className="text-sm font-medium">Ends</span>
          <input type="time" value={f.end} onChange={set('end')} className={input} />
          {show('end') && <span className="mt-1 block text-sm">{show('end')}</span>}
        </label>
      </div>
      {window && (
        <p className="-mt-2 text-xs text-[var(--color-muted)]">
          {formatLagos(window.startIso, 'dateTime')} to {formatLagos(window.endIso, window.crossesMidnight ? 'dateTime' : 'time')}
          {window.crossesMidnight ? ' — the next morning' : ''}, Lagos time.
        </p>
      )}

      <label className="block">
        <span className="text-sm font-medium">Where</span>
        <input value={f.location} onChange={set('location')} placeholder="Venue and area" className={input} />
        {show('location') && <span className="mt-1 block text-sm">{show('location')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Amount, in naira</span>
        <input value={f.amount} onChange={set('amount')} inputMode="decimal" className={input} />
        {show('amount') ? (
          <span className="mt-1 block text-sm">{show('amount')}</span>
        ) : (
          amount.ok && (
            <span className="mt-1 block text-xs text-[var(--color-muted)]">
              {artistName}&apos;s rate is {rateKobo ? formatNaira(rateKobo) : 'not set'}. A small payment fee is added when you pay.
            </span>
          )
        )}
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className="min-h-11 w-full rounded-md border border-[var(--color-line)] font-medium hover:border-[var(--color-accent)] disabled:opacity-50">
        {busy ? 'Sending…' : 'Continue to the cancellation terms'}
      </button>
      <p className="text-center text-xs text-[var(--color-muted)]">Nothing is charged yet.</p>
    </form>
  );
}
