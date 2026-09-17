import { redirect } from 'next/navigation';
import Link from 'next/link';

import { BASE_URL } from '@/lib/api';
import { authHeader, sessionToken } from '@/lib/session';
import { formatNaira } from '@/lib/currency';
import { checkInVerdict, contradictsNoShowClaim, type DisputeDetail } from '@/lib/disputes';
import { DisputeResolution } from '@/components/dispute-resolution';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dispute',
  robots: { index: false, follow: false },
};

/**
 * One dispute, for deciding it — issue #32, docs/04 §6.
 *
 * THE CHECK-IN IS THE FIRST THING ON THE PAGE, above the parties' statements
 * and above the form. Most disputes should be cheap to resolve because that
 * single record reduces "did the event happen?" to a timestamped fact; burying
 * it among attachments makes every dispute expensive.
 *
 * Where it contradicts the client's own no-show claim, that is said outright.
 * One of the two parties is not telling the truth and the record says which —
 * leaving an admin to notice it themselves is how a five-minute decision
 * becomes an afternoon.
 */
export default async function AdminDisputePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!(await sessionToken())) redirect(`/login?next=/admin/disputes/${id}`);

  const headers = await authHeader();
  let dispute: DisputeDetail | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(`${BASE_URL}/admin/disputes/${encodeURIComponent(id)}`, {
      headers,
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);

    if (response.status === 403) error = 'This page is for administrators.';
    else if (!response.ok) error = payload?.error ?? 'Could not load this dispute.';
    else dispute = payload.dispute;
  } catch {
    error = 'Could not reach the server. Check your connection and try again.';
  }

  if (error || !dispute) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-16 text-center">
        <p className="text-sm">{error ?? 'Dispute not found.'}</p>
        <Link href="/admin/disputes" className="mt-4 inline-block text-sm underline underline-offset-4">
          Back to the queue
        </Link>
      </div>
    );
  }

  const contradiction = contradictsNoShowClaim(dispute);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link href="/admin/disputes" className="text-sm underline underline-offset-4">
        Back to the queue
      </Link>

      <h1 className="mt-4 text-xl font-semibold tracking-tight">
        {dispute.booking.client} &middot; {dispute.booking.artist}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {formatNaira(dispute.booking.amountKobo)} held since{' '}
        {new Date(dispute.openedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
      </p>

      {/* ABOVE THE FOLD. docs/04 §6. */}
      <section
        className={`mt-6 rounded-lg border p-4 ${
          dispute.checkIn
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-amber-500/40 bg-amber-500/5'
        }`}
      >
        <h2 className="text-xs uppercase tracking-wide opacity-70">Attendance record</h2>
        <p className="mt-2 text-sm">{checkInVerdict(dispute)}</p>

        {contradiction ? (
          <p className="mt-3 rounded border border-rose-500/50 bg-rose-500/10 p-3 text-sm">
            <span className="font-medium">This contradicts the client&rsquo;s claim. </span>
            They reported a no-show, and the artist holds a code only the client could have given
            them in person. One of these accounts is untrue.
          </p>
        ) : null}
      </section>

      <section className="mt-6 rounded-lg border border-[var(--color-line)] p-4">
        <h2 className="text-xs uppercase tracking-wide opacity-70">What was claimed</h2>
        <p className="mt-2 text-sm">{dispute.openedReason}</p>
        <p className="mt-2 text-xs opacity-60">
          Opened by the {dispute.openedBy?.toLowerCase() ?? 'party'}.
        </p>

        {dispute.booking.clientNoShowReason ? (
          <p className="mt-3 text-sm">
            <span className="opacity-70">Client&rsquo;s no-show account: </span>
            {dispute.booking.clientNoShowReason}
          </p>
        ) : null}
      </section>

      <section className="mt-6 rounded-lg border border-[var(--color-line)] p-4">
        <h2 className="text-xs uppercase tracking-wide opacity-70">Statements</h2>

        {dispute.evidence.length === 0 ? (
          <p className="mt-2 text-sm opacity-70">
            Neither party has submitted anything yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-4">
            {dispute.evidence.map((item) => (
              <li key={item.id} className="border-l-2 border-[var(--color-line)] pl-3">
                <p className="text-xs uppercase tracking-wide opacity-60">
                  {item.party === 'CLIENT' ? 'Client' : item.party === 'ARTIST' ? 'Artist' : 'Unknown'}
                </p>
                {item.statement ? <p className="mt-1 text-sm">{item.statement}</p> : null}
                {item.fileUrl ? (
                  <a
                    href={item.fileUrl}
                    // Untrusted, party-supplied. noopener/noreferrer so the
                    // linked page cannot reach back into this one.
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-1 inline-block text-sm underline underline-offset-4"
                  >
                    Attached file
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6">
        <DisputeResolution dispute={dispute} />
      </div>
    </div>
  );
}
