'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { failureMessage, unreachable } from '@/lib/error-messages';
import {
  MIN_PASSWORD_LENGTH,
  normalisePhone,
  registrationBody,
  signupProblems,
  type Role,
  type SignupFields,
} from '@/lib/signup';

/**
 * Sign up — issue #42.
 *
 * One form for both kinds of account, because the only thing that differs is
 * one label. The choice comes FIRST, so the name field can ask for the right
 * thing: a client's name, or the stage name clients will search for.
 *
 * Problems show at the field, on blur and on submit — never as one generic
 * alert (#39). Whatever the backend still refuses is shown in its own words.
 */
function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [fields, setFields] = useState<SignupFields>({
    role: (params.get('as') === 'artist' ? 'ARTIST' : params.get('as') === 'client' ? 'CLIENT' : '') as Role | '',
    name: '',
    email: '',
    phone: '',
    password: '',
  });
  const [touched, setTouched] = useState<Partial<Record<keyof SignupFields, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const problems = signupProblems(fields);
  const show = (field: keyof SignupFields) => (submitted || touched[field] ? problems[field] : undefined);
  const set = (field: keyof SignupFields) => (value: string) => setFields((f) => ({ ...f, [field]: value }));
  const blur = (field: keyof SignupFields) => () => setTouched((t) => ({ ...t, [field]: true }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(problems).length > 0) return;

    setBusy(true);
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registrationBody(fields)),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok) {
        setError(failureMessage(payload, 'Your account could not be created. Try again.'));
        return;
      }

      // Verification next: nobody can book or be booked until it is done, and
      // being taken there now beats discovering it at the first booking.
      const after = next ? `?next=${encodeURIComponent(next)}` : '';
      router.replace(`/verify${after}`);
      router.refresh();
    } catch {
      setError(unreachable('Your account has not been created.'));
    } finally {
      setBusy(false);
    }
  }

  const input =
    'mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3';

  const roleOption = (value: Role, title: string, detail: string) => (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border px-3 py-3 ${
        fields.role === value ? 'border-[var(--color-accent)]' : 'border-[var(--color-line)]'
      }`}
    >
      <input
        type="radio"
        name="role"
        value={value}
        checked={fields.role === value}
        onChange={() => set('role')(value)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-[var(--color-muted)]">{detail}</span>
      </span>
    </label>
  );

  const phonePreview = normalisePhone(fields.phone);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Already have one?{' '}
        <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="underline">
          Sign in
        </Link>
      </p>

      <form onSubmit={submit} noValidate className="mt-8 space-y-5">
        <fieldset>
          <legend className="text-sm font-medium">I want to…</legend>
          <div className="mt-2 grid gap-2">
            {roleOption('CLIENT', 'Book artists', 'For your event. Your payment is held until it has happened.')}
            {roleOption('ARTIST', 'Perform', 'Get booked, and get paid once the event is confirmed.')}
          </div>
          {show('role') && <p className="mt-1 text-sm">{show('role')}</p>}
        </fieldset>

        <label className="block">
          <span className="text-sm font-medium">{fields.role === 'ARTIST' ? 'Stage name' : 'Your name'}</span>
          <input
            value={fields.name}
            onChange={(e) => set('name')(e.target.value)}
            onBlur={blur('name')}
            autoComplete={fields.role === 'ARTIST' ? 'nickname' : 'name'}
            aria-invalid={show('name') ? true : undefined}
            className={input}
          />
          {fields.role === 'ARTIST' && (
            <span className="mt-1 block text-xs text-[var(--color-muted)]">The name clients will search for.</span>
          )}
          {show('name') && <span className="mt-1 block text-sm">{show('name')}</span>}
        </label>

        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            value={fields.email}
            onChange={(e) => set('email')(e.target.value)}
            onBlur={blur('email')}
            autoComplete="email"
            aria-invalid={show('email') ? true : undefined}
            className={input}
          />
          {show('email') && <span className="mt-1 block text-sm">{show('email')}</span>}
        </label>

        <label className="block">
          <span className="text-sm font-medium">Mobile number</span>
          <input
            type="tel"
            value={fields.phone}
            onChange={(e) => set('phone')(e.target.value)}
            onBlur={blur('phone')}
            autoComplete="tel"
            inputMode="tel"
            placeholder="0801 234 5678"
            aria-invalid={show('phone') ? true : undefined}
            className={input}
          />
          {show('phone') ? (
            <span className="mt-1 block text-sm">{show('phone')}</span>
          ) : (
            phonePreview.startsWith('+234') &&
            phonePreview !== fields.phone.trim() && (
              // Shown back, so nobody wonders what was done to their number.
              <span className="mt-1 block text-xs text-[var(--color-muted)]">We will save this as {phonePreview}.</span>
            )
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            value={fields.password}
            onChange={(e) => set('password')(e.target.value)}
            onBlur={blur('password')}
            autoComplete="new-password"
            aria-invalid={show('password') ? true : undefined}
            className={input}
          />
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            {show('password') ?? `At least ${MIN_PASSWORD_LENGTH} characters.`}
          </span>
        </label>

        {error && (
          <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="min-h-11 w-full rounded-md border border-[var(--color-line)] font-medium transition-colors hover:border-[var(--color-accent)] disabled:opacity-50"
        >
          {busy ? 'Creating your account…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
