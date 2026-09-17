/**
 * The cancellation-rate display rule — docs/06 §6, issue #35.
 *
 * One decision, extracted from the component so it can be tested. `node:test`
 * runs TypeScript by stripping types and cannot transform JSX, so anything
 * living in a `.tsx` file is only checkable by reading it — and "renders
 * nothing below the threshold" is too important a rule to verify by inspection.
 */

/**
 * Whether there is a rate to show at all.
 *
 * `null` means "not enough bookings to say anything", and it is NOT the same as
 * zero. Zero, once the threshold is met, is a fact: this artist concluded
 * enough bookings and cancelled none of them. Below the threshold there is no
 * fact, and rendering `0%` would imply a perfect record that has not been
 * earned.
 *
 * A type guard, so a caller that shows the figure has to establish it first.
 */
export function shouldShowRate(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate);
}
