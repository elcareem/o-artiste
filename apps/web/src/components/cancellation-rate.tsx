/**
 * The cancellation-rate stat — docs/06 §4.
 *
 * RENDERS NOTHING when the rate is null. Not "0%", which implies a perfect
 * record that has not been earned. Not "N/A" or "No data", which draw attention
 * to an absence and read as a warning. An artist with two completed bookings
 * should look neutral, because they are.
 *
 * Returning `null` emits no element at all, so there is nothing in the DOM to
 * style, space, or accidentally reveal.
 */
export function CancellationRate({ rate }: { rate: number | null }) {
  if (rate === null || rate === undefined) return null;

  return (
    <div
      data-testid="cancellation-rate"
      className="rounded-lg border border-[var(--color-line)] px-4 py-3"
    >
      <div className="text-xs tracking-wide text-[var(--color-muted)] uppercase">
        Cancellation rate
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{rate}%</div>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Share of recent bookings this artist cancelled.
      </p>
    </div>
  );
}
