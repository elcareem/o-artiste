'use client';

import { useState } from 'react';

import { statusCopy } from '@/lib/booking-status';
import { codeProblem } from '@/lib/check-in';
import { NOTHING, failureMessage, thrownMessage } from '@/lib/error-messages';

/**
 * The artist redeems the client's code on arrival — issue #39, docs/04 §2.
 *
 * This is the screen at a noisy venue, on a phone, probably one-handed. Three
 * things follow from that.
 *
 * THE FAILURE MESSAGES COME FROM THE BACKEND, UNALTERED. "This code has already
 * been used" and "That code is not right" are different situations with
 * different next steps, and collapsing them into "check-in failed" is the exact
 * failure #39 exists to fix. The backend already words each one; the only wrong
 * thing this component could do is paraphrase.
 *
 * A FAILURE NEVER CLEARS THE FORM. Retyping a six-character code because the
 * first attempt was outside the window is the sort of thing that makes someone
 * give up and ask the client to pay them directly.
 *
 * LOCATION IS NEVER A GATE. An artist in a basement venue with no GPS lock has
 * still arrived, and turning a signal problem into a payment failure would be a
 * worse error than the one it prevents. It is attached when the browser offers
 * it and skipped silently otherwise.
 */
export function CheckInForm({
  bookingId,
  state,
  clientName,
}: {
  bookingId: string;
  state: string;
  clientName: string;
}) {
  const [code, setCode] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [nowCheckedIn, setNowCheckedIn] = useState(false);

  if (done || nowCheckedIn) {
    return (
      <div className="mt-6 rounded-md border border-[var(--color-line)] px-4 py-3">
        <p className="text-sm font-medium">Checked in.</p>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {done ??
            'This booking was already checked in. Nothing more is needed from you here.'}
        </p>
      </div>
    );
  }

  /** The reading, where the browser gives one. Never blocks the submission. */
  async function location(): Promise<Record<string, string> | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

    return new Promise((resolve) => {
      // A short timeout, and a failure resolves to null rather than rejecting.
      // Waiting on a GPS fix at the door is the whole problem with making this
      // a gate.
      const give_up = setTimeout(() => resolve(null), 4000);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(give_up);
          resolve({
            // Strings, so no float enters the payload (docs/01 §1).
            latitude: String(position.coords.latitude),
            longitude: String(position.coords.longitude),
            accuracyMeters: String(Math.round(position.coords.accuracy)),
          });
        },
        () => {
          clearTimeout(give_up);
          resolve(null);
        },
        { timeout: 4000, maximumAge: 60_000 }
      );
    });
  }

  async function submit() {
    // Length, not emptiness. A five-character code is a typo worth catching
    // before a round trip at a venue with poor signal.
    const problem = codeProblem(code);
    setProblems(problem ? { code: problem } : {});
    if (problem) return;

    setBusy(true);
    setFailure(null);

    try {
      const reading = await location();

      const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/check-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), ...(reading ?? {}) }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        // The backend's own words. "Already used" and "not right" are different
        // situations, and this is the line that keeps them different.
        setFailure(
          failureMessage(payload, 'That did not go through. Check the code with the client and try again.')
        );

        // Whether to keep offering the form is decided by the BOOKING STATE, not
        // by reading the message. A second artist device that lost the race gets
        // "already used", and the right view then is "checked in" — derived from
        // what is true rather than from prose that may be reworded.
        const after = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);

        if (after?.booking?.state === 'CHECKED_IN') setNowCheckedIn(true);
        return;
      }

      setDone(
        `Recorded at ${new Date(payload.checkIn.redeemedAt).toLocaleTimeString('en-NG', {
          hour: '2-digit',
          minute: '2-digit',
        })}. ${
          payload.checkIn.hasLocation
            ? 'Your location was attached.'
            : 'No location was available, which makes no difference to your payment.'
        }`
      );
    } catch {
      setFailure(thrownMessage(null, NOTHING.recorded));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold">Check in</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Ask {clientName} for their six-character code and enter it here. This booking is{' '}
        {statusCopy(state).label.toLowerCase()}.
      </p>

      <label className="mt-4 block text-sm font-medium" htmlFor="check-in-code">
        Check-in code
      </label>
      <input
        id="check-in-code"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        onBlur={() => {
          // On blur only once something has been typed: telling someone a field
          // is needed the moment they tab past it is nagging, not help.
          const problem = code.length > 0 ? codeProblem(code) : null;
          setProblems(problem ? { code: problem } : {});
        }}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        aria-invalid={problems.code ? true : undefined}
        aria-describedby={problems.code ? 'check-in-code-problem' : undefined}
        // Large and monospaced: this is read aloud across a room and typed on a
        // phone, and 0/O and 1/I are the characters that get it wrong.
        className="mt-1 w-full max-w-xs rounded-md border border-[var(--color-line)] px-3 py-2 font-mono text-lg tracking-[0.2em]"
      />
      {problems.code && (
        <p id="check-in-code-problem" className="mt-1 text-sm">
          {problems.code}
        </p>
      )}

      {failure && (
        <p className="mt-3 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {failure}
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="mt-4 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm disabled:opacity-50"
      >
        {busy ? 'Checking in…' : 'Check in'}
      </button>
    </section>
  );
}
