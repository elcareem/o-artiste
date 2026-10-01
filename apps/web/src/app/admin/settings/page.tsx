import { redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import type { Settings } from '@/lib/settings';
import { TierEditor } from '@/components/tier-editor';
import { CommissionEditor } from '@/components/commission-editor';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Platform settings',
  robots: { index: false, follow: false },
};

/**
 * The configuration surface — issue #36, docs/07 §6.
 *
 * Every tunable decision in this system was built as configuration rather than
 * a constant precisely so this screen could exist: the commission rate, the
 * cancellation bands, the auto-release grace period, the strike weights, the
 * enforcement ladders, and the reputation window and threshold.
 *
 * RESTRICTED SECTIONS ARE MARKED, NOT HIDDEN. An `ADMIN` sees that a commission
 * rate exists and that they cannot change it, which is more useful than a
 * screen that silently lacks a section — and the server refuses the write
 * regardless of what this page offers.
 */
export default async function AdminSettingsPage() {
  if (!(await sessionToken())) redirect('/login?next=/admin/settings');

  const headers = await authHeader();
  let settings: Settings | null = null;
  let viewerRole = '';
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/admin/settings`, { headers, cache: 'no-store' });
    const payload = await response.json().catch(() => null);

    if (response.status === 403) error = 'This page is for administrators.';
    else if (!response.ok) error = payload?.error ?? 'Could not load the settings.';
    else {
      settings = payload.settings;
      viewerRole = payload.viewerRole;
    }
  } catch {
    error = 'Could not reach the server. Check your connection and try again.';
  }

  if (error || !settings) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 text-center">
        <p className="text-sm">{error ?? 'Settings unavailable.'}</p>
      </div>
    );
  }

  const readOnly = viewerRole !== 'SUPER_ADMIN';

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Platform settings</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Changes apply to bookings made afterwards. Existing bookings keep the terms they were
        made under.
      </p>

      {readOnly && (
        <p className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
          You can see these settings but not change them. Changing any of them affects every
          booking made afterwards, so it is restricted to a super-admin.
        </p>
      )}

      <div className="mt-6 space-y-6">
        <CommissionEditor
          currentBps={settings.commission.rateBasisPoints}
          editable={settings.commission.editable}
        />

        <TierEditor
          initial={settings.cancellationTiers.tiers}
          editable={settings.cancellationTiers.editable}
        />

        <ReadOnlySection
          title="Auto-release grace period"
          note={
            settings.autoRelease.source === 'environment'
              ? 'Set by an environment variable on the service, which takes precedence over anything saved here.'
              : 'How long after an event funds release if the client says nothing.'
          }
          rows={[['Grace period', `${settings.autoRelease.graceHours} hours`]]}
        />

        <ReadOnlySection
          title="Cancellation rate"
          note="How the published statistic is calculated. Below the minimum, nothing is shown at all."
          rows={[
            ['Rolling window', `${settings.reputation.windowMonths} months`],
            ['Minimum bookings', String(settings.reputation.minBookings)],
            ['Source', settings.reputation.isDefault ? 'Shipped default' : 'Set by an administrator'],
          ]}
        />

        <ReadOnlySection
          title="Strike weights"
          note="What each kind of misconduct costs. A false no-show claim weighs more than a late cancellation."
          rows={[
            ['Rules', String(settings.strikes.rules.length)],
            ['Source', settings.strikes.isDefault ? 'Shipped default' : 'Set by an administrator'],
          ]}
        />

        <ReadOnlySection
          title="Enforcement ladders"
          note="What accumulated strikes do to an account."
          rows={[
            ['Rungs', String(settings.enforcement.rules.length)],
            ['Source', settings.enforcement.isDefault ? 'Shipped default' : 'Set by an administrator'],
          ]}
        />
      </div>

      <p className="mt-8 text-xs text-[var(--color-muted)]">
        A sample ₦200,000 booking currently pays the artist{' '}
        {formatNaira(20000000 - Math.floor((20000000 * settings.commission.rateBasisPoints) / 10000))}{' '}
        before payment charges.
      </p>
    </div>
  );
}

function ReadOnlySection({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: [string, string][];
}) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] p-4">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-xs text-[var(--color-muted)]">{note}</p>
      <dl className="mt-3 space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="opacity-70">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
