/**
 * Sign-up rules, checked as the person types — issue #42.
 *
 * Mirrors the backend's validation so a mistake is caught at the field rather
 * than by a rejected submission. The backend stays authoritative; the test for
 * this module reads its constants from source so the two cannot drift.
 */

/** Mirrors `MIN_PASSWORD_LENGTH` in routes/auth.ts. */
export const MIN_PASSWORD_LENGTH = 10;

/** Mirrors `E164_PATTERN` in routes/auth.ts. */
const E164 = /^\+[1-9]\d{7,14}$/;

export type Role = 'CLIENT' | 'ARTIST';

export type SignupFields = {
  role: Role | '';
  name: string;
  email: string;
  phone: string;
  password: string;
};

/**
 * A Nigerian number in the form the backend stores — `+2348012345678`.
 *
 * People type `0801 234 5678`. The backend requires international format and
 * says so, but asking a person to rewrite their own number is the form doing
 * its job badly: the conversion is unambiguous, so it is done for them and
 * shown back. Anything that does not look Nigerian is passed through untouched
 * for the backend to judge.
 */
export function normalisePhone(raw: string): string {
  const compact = String(raw ?? '').replace(/[\s()-]/g, '');
  if (/^0[789][01]\d{8}$/.test(compact)) return `+234${compact.slice(1)}`;
  if (/^234[789][01]\d{8}$/.test(compact)) return `+${compact}`;
  return compact;
}

/** Per-field messages; an empty object means the form may be submitted. */
export function signupProblems(fields: SignupFields): Partial<Record<keyof SignupFields, string>> {
  const problems: Partial<Record<keyof SignupFields, string>> = {};

  if (fields.role !== 'CLIENT' && fields.role !== 'ARTIST') {
    problems.role = 'Choose whether you are booking artists or performing.';
  }

  if (fields.name.trim().length === 0) {
    problems.name = fields.role === 'ARTIST' ? 'Your stage name is needed.' : 'Your name is needed.';
  }

  const email = fields.email.trim();
  if (email.length === 0) problems.email = 'Your email is needed.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.email = 'That does not look like an email address.';

  const phone = normalisePhone(fields.phone);
  if (phone.length === 0) problems.phone = 'Your phone number is needed — it is where your check-in code is sent.';
  else if (!E164.test(phone)) problems.phone = 'Enter a Nigerian mobile number, like 0801 234 5678.';

  if (fields.password.length === 0) problems.password = 'Choose a password.';
  else if (fields.password.length < MIN_PASSWORD_LENGTH) {
    problems.password = `At least ${MIN_PASSWORD_LENGTH} characters. A short phrase is easier to remember than symbols.`;
  }

  return problems;
}

/** The body the backend expects, built from the fields. */
export function registrationBody(fields: SignupFields) {
  return {
    role: fields.role,
    email: fields.email.trim().toLowerCase(),
    phone: normalisePhone(fields.phone),
    password: fields.password,
    ...(fields.role === 'ARTIST' ? { stageName: fields.name.trim() } : { displayName: fields.name.trim() }),
  };
}

/** Where each role goes after signing up or in. */
export function homeFor(role: string | null | undefined): string {
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return '/admin/bookings';
  return '/bookings';
}
