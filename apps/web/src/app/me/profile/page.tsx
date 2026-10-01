import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BASE_URL } from '@/lib/api';
import { authHeader, currentUser } from '@/lib/session';
import { listingStatus } from '@/lib/artist-profile';
import { ArtistProfileForm } from '@/components/artist-profile-form';
import { PayoutAccountForm } from '@/components/payout-account-form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My profile', robots: { index: false, follow: false } };

/** An artist's own profile and payout account — issue #44. */
export default async function MyProfilePage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/me/profile');
  if (user.role !== 'ARTIST') redirect('/bookings');

  const headers = await authHeader();
  const get = async (path: string) => {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { headers, cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const [profileBody, payoutBody, banksBody, meBody] = await Promise.all([
    get('/me/artist-profile'),
    get('/artists/me/payout-account'),
    get('/artists/banks'),
    get('/me'),
  ]);

  if (!profileBody?.artist) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-12">
        <h1 className="text-xl font-semibold tracking-tight">My profile</h1>
        <p className="mt-4 text-sm">We could not load your profile just now. Refresh the page to try again.</p>
      </div>
    );
  }

  const artist = profileBody.artist;
  const payout = payoutBody?.payoutAccount ?? { registered: false, bankCode: null, accountLast4: null, accountName: null };
  const status = listingStatus({
    ...artist,
    verificationStatus: profileBody.verificationStatus,
    accountStanding: meBody?.user?.accountStanding,
    payoutRegistered: payout.registered,
  });

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <h1 className="text-xl font-semibold tracking-tight">My profile</h1>

      <section className="mt-4 rounded-md border border-[var(--color-line)] px-4 py-3 text-sm">
        {status.listable ? (
          <p>
            <span className="font-medium">Clients can find and book you.</span>{' '}
            <Link href={`/artists/${artist.id}`} className="underline">
              See your public page
            </Link>
          </p>
        ) : (
          <>
            <p className="font-medium">Clients cannot find you yet.</p>
            <ul className="mt-1 list-disc pl-5 text-[var(--color-muted)]">
              {status.missing.map((m) => (
                <li key={m}>
                  {m}{' '}
                  {m.startsWith('Verify') && (
                    <Link href="/verify?next=/me/profile" className="underline">
                      Verify now
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {status.warnings.map((w) => (
          <p key={w} className="mt-2 font-medium">
            {w}
          </p>
        ))}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">What clients see</h2>
        <div className="mt-3">
          <ArtistProfileForm profile={artist} />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold">Where your money goes</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          After an event is confirmed, your payment is sent to this account.
        </p>
        <div className="mt-3">
          <PayoutAccountForm current={payout} banks={Array.isArray(banksBody?.banks) ? banksBody.banks : []} />
        </div>
      </section>
    </div>
  );
}
