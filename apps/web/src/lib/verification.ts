/**
 * Identity verification, as the person sees it — issue #43.
 *
 * The backend owns the outcome. This module decides only what each status MEANS
 * to the person looking at it, and what they can do next — because "PENDING" and
 * "RETRYABLE_FAILURE" are database words, and the difference between "try again
 * in a minute" and "contact support" is the whole point of the page.
 */

export type VerificationStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'RETRYABLE_FAILURE' | 'REJECTED';
export type Method = 'NIN' | 'BVN';

export type VerificationView = {
  /** What the page renders: the form, a finished state, or a dead end. */
  mode: 'form' | 'done' | 'blocked';
  headline: string;
  detail: string;
};

const VIEWS: Record<VerificationStatus, VerificationView> = {
  UNVERIFIED: {
    mode: 'form',
    headline: 'Verify your identity',
    detail:
      'Before you can book or be booked, we confirm who you are with your NIN or BVN. It takes a moment and you only do it once.',
  },
  PENDING: {
    // A request that never finished — the person closed the tab, or the
    // provider timed out mid-check. Safe to submit again.
    mode: 'form',
    headline: 'Your check did not finish',
    detail: 'Something interrupted it before we heard back. Submit your details again.',
  },
  RETRYABLE_FAILURE: {
    mode: 'form',
    headline: 'We could not reach our verification partner',
    detail: 'That was on their side, not yours. Try again in a few minutes — nothing was charged to you.',
  },
  VERIFIED: {
    mode: 'done',
    headline: 'You are verified',
    detail: 'You do not need to do this again.',
  },
  REJECTED: {
    // No form: the backend refuses every further attempt, and offering one
    // would send the person round a loop that cannot end well.
    mode: 'blocked',
    headline: 'We could not verify that identity',
    detail:
      'We cannot try it again automatically. Contact support and we will look into it with you — including if the number was simply mistyped.',
  },
};

export function viewFor(status: string | null | undefined): VerificationView {
  return (
    VIEWS[status as VerificationStatus] ?? {
      // An unknown status is treated as "not yet verified", never as verified.
      mode: 'form',
      headline: 'Verify your identity',
      detail: VIEWS.UNVERIFIED.detail,
    }
  );
}

/** Both are 11 digits in Nigeria. */
export const IDENTIFIER_LENGTH = 11;

export function identifierProblem(method: Method | '', raw: string): string | null {
  const digits = String(raw ?? '').replace(/\s/g, '');
  const name = method || 'number';
  if (digits.length === 0) return `Your ${name} is needed.`;
  if (!/^\d+$/.test(digits)) return `Your ${name} is digits only.`;
  if (digits.length !== IDENTIFIER_LENGTH) {
    return `Your ${name} is ${IDENTIFIER_LENGTH} digits — you have entered ${digits.length}.`;
  }
  return null;
}

export type VerificationForm = { method: Method | ''; identifier: string; consent: boolean };

export function verificationProblems(form: VerificationForm): Partial<Record<keyof VerificationForm, string>> {
  const problems: Partial<Record<keyof VerificationForm, string>> = {};
  if (form.method !== 'NIN' && form.method !== 'BVN') problems.method = 'Choose NIN or BVN.';
  const id = identifierProblem(form.method, form.identifier);
  if (id) problems.identifier = id;
  // The box is never pre-ticked and nothing here ticks it: consent the person
  // did not give is not consent (#41).
  if (form.consent !== true) problems.consent = 'Tick the box to agree to the check. We cannot run it without your consent.';
  return problems;
}

/** The body the API expects. `consent` is sent as the boolean it must be. */
export function verificationBody(form: VerificationForm) {
  return { method: form.method, identifier: form.identifier.replace(/\s/g, ''), consent: form.consent === true };
}
