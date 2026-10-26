'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { CATEGORY_SUGGESTIONS } from '@/lib/artist-profile';
import { failureMessage, NOTHING, unreachable } from '@/lib/error-messages';
import { formatNaira } from '@/lib/currency';
import { koboToNairaInput, parseNairaToKobo } from '@/lib/naira';

type Profile = {
  id: string;
  stageName: string | null;
  bio: string | null;
  category: string | null;
  location: string | null;
  baseRateKobo: number | null;
};

/**
 * What clients see — issue #44.
 *
 * The rate is TYPED IN NAIRA and sent as kobo, converted by `parseNairaToKobo`
 * without a float. The parsed figure is shown back as it will be stored, so a
 * slip — an extra zero — is visible before saving rather than after the first
 * booking request arrives at ten times the price.
 */
export function ArtistProfileForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [stageName, setStageName] = useState(profile.stageName ?? '');
  const [category, setCategory] = useState(profile.category ?? '');
  const [location, setLocation] = useState(profile.location ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [rate, setRate] = useState(koboToNairaInput(profile.baseRateKobo));
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = parseNairaToKobo(rate, 'Your rate');
  const problems: Record<string, string> = {};
  if (stageName.trim() === '') problems.stageName = 'Your stage name is needed.';
  if (category.trim() === '') problems.category = 'Say what you perform — clients search by it.';
  if (location.trim() === '') problems.location = 'Say where you are based — clients search by it.';
  if (!parsed.ok) problems.rate = parsed.problem;
  const show = (k: string) => (submitted ? problems[k] : undefined);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    setSaved(false);
    if (Object.keys(problems).length > 0 || !parsed.ok) return;

    setBusy(true);
    try {
      const res = await fetch(`/api/artists/${encodeURIComponent(profile.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageName: stageName.trim(),
          category: category.trim(),
          location: location.trim(),
          bio: bio.trim() || null,
          baseRateKobo: parsed.kobo,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        // Including the rate range, which the backend words with the limits.
        setError(failureMessage(payload, `Your profile was not saved. ${NOTHING.saved}`));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError(unreachable(NOTHING.saved));
    } finally {
      setBusy(false);
    }
  }

  const input = 'mt-1 min-h-11 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3';

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <label className="block">
        <span className="text-sm font-medium">Stage name</span>
        <input value={stageName} onChange={(e) => setStageName(e.target.value)} className={input} />
        {show('stageName') && <span className="mt-1 block text-sm">{show('stageName')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">What you perform</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} list="categories" className={input} />
        <datalist id="categories">
          {CATEGORY_SUGGESTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {show('category') && <span className="mt-1 block text-sm">{show('category')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Where you are based</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Lagos" className={input} />
        {show('location') && <span className="mt-1 block text-sm">{show('location')}</span>}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Your rate, in naira</span>
        <input
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          inputMode="decimal"
          placeholder="200,000"
          aria-invalid={show('rate') ? true : undefined}
          className={input}
        />
        {show('rate') ? (
          <span className="mt-1 block text-sm">{show('rate')}</span>
        ) : (
          parsed.ok && (
            <span className="mt-1 block text-xs text-[var(--color-muted)]">
              Clients will see {formatNaira(parsed.kobo)}. Bookings must be between ₦20,000 and ₦3,000,000.
            </span>
          )
        )}
      </label>

      <label className="block">
        <span className="text-sm font-medium">About you</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-md border border-[var(--color-line)] bg-transparent px-3 py-2"
        />
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-[var(--color-line)] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {saved && <p className="text-sm">Saved.</p>}

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 rounded-md border border-[var(--color-line)] px-4 font-medium hover:border-[var(--color-accent)] disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}
