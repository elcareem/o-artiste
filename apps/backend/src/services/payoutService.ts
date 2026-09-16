/**
 * The money-out leg — where an artist's payment actually reaches them.
 *
 * WHY THIS EXISTS. EscrowPay rejects `payout_preference: automatic` on this
 * business (`policy_violation: automatic_payout_disabled`, verified against the
 * test book). A release therefore moves escrow into **our wallet**, not to the
 * artist, and the payout out of it is ours to issue.
 *
 * Until this module existed the system released money and stopped there: every
 * other path was built on the assumption that a release ends with the artist
 * paid, and it did not. `docs/00` §3 says the platform never holds client
 * money; a balance sitting in our wallet is exactly that, and the only reason
 * it is tolerable is that it is measured in seconds rather than days.
 *
 * ASK ESCROWPAY TO ENABLE AUTOMATIC PAYOUT. If they do, this module's
 * `payOut` becomes a no-op and the wallet leg disappears (docs/00 §11).
 *
 * The account NUMBER is never stored. It is sent once at registration and the
 * provider holds it; every payout afterwards is addressed by their id. Same
 * reasoning as the NIN in #10 — keeping the identifier is exposure with no
 * operational benefit.
 */

const prisma = require('../lib/prisma.ts');
const { AppError } = require('../lib/errors.ts');
const escrowpay = require('../lib/escrowpay.ts');

/** Nigerian NUBAN. Ten digits, no more and no fewer. */
const NUBAN_LENGTH = 10;

/**
 * Registers an artist's bank account as a payout destination.
 *
 * Idempotent on the artist: registering again replaces what is on file, because
 * an artist changing bank is ordinary and the alternative is a support ticket.
 */
async function registerPayoutAccount({
  artistUserId,
  bankCode,
  accountNumber,
  accountName,
}: RegisterPayoutAccountInput): Promise<PayoutAccountView> {
  const artist = await prisma.artist.findUnique({
    where: { userId: artistUserId },
    include: { user: true },
  });

  if (!artist) throw new AppError(404, 'Create your artist profile before adding a bank account.');

  const digits = String(accountNumber ?? '').replace(/\s/g, '');
  if (!/^\d+$/.test(digits) || digits.length !== NUBAN_LENGTH) {
    throw new AppError(400, `Account number must be ${NUBAN_LENGTH} digits.`);
  }

  const code = String(bankCode ?? '').trim();
  if (!code) throw new AppError(400, 'Choose your bank.');

  // The artist must exist at the provider first: a payout account is owned by a
  // party, and the party is created during identity verification (#10).
  if (!artist.user.escrowPartyId) {
    throw new AppError(
      409,
      'Verify your identity before adding a bank account — your payout account is registered against it.'
    );
  }

  const created = await escrowpay.createPayoutAccount({
    partyId: artist.user.escrowPartyId,
    bankCode: code,
    accountNumber: digits,
    // Stable per artist and account, so a retry after a timeout returns the
    // original rather than registering a duplicate.
    reference: `pa_${artist.id}_${digits.slice(-4)}`,
    isDefault: true,
  });

  const payoutAccountId = created?.id ?? created?.payout_account_id;
  if (!payoutAccountId) {
    throw new AppError(502, 'The payment provider did not return a payout account.');
  }

  const updated = await prisma.artist.update({
    where: { id: artist.id },
    data: {
      payoutAccountId,
      payoutBankCode: code,
      // Last four only. The full number is the provider's to hold.
      payoutAccountLast4: digits.slice(-4),
      // Their resolved name where they give one — it is the artist's own check
      // that the money is going where they think it is.
      payoutAccountName: created?.account_name ?? accountName ?? null,
      payoutAccountVerifiedAt: created?.verified_at ? new Date(created.verified_at) : null,
    },
  });

  console.log(`[payout] artist ${artist.id} registered payout account ending ${digits.slice(-4)}`);

  return publicPayoutAccount(updated);
}

/** What an artist sees about the account on file. Never the full number. */
function publicPayoutAccount(artist: ArtistRow): PayoutAccountView {
  return {
    registered: Boolean(artist.payoutAccountId),
    bankCode: artist.payoutBankCode,
    accountLast4: artist.payoutAccountLast4,
    accountName: artist.payoutAccountName,
    verifiedAt: artist.payoutAccountVerifiedAt,
  };
}

/** The banks a payout account can be registered against. */
async function banks(): Promise<any> {
  return escrowpay.listBanks();
}

/**
 * Our wallet id, resolved once per process.
 *
 * Cached because it does not change and a payout should not spend a round trip
 * discovering where its own money is.
 */
let cachedWalletId: string | null = null;

async function walletId(): Promise<string> {
  if (cachedWalletId) return cachedWalletId;

  const response = await escrowpay.listWallets();

  // `items` is what the provider actually returns — verified against the test
  // book, after a first version guessed `data` / `wallets` and would have
  // thrown on every payout. The alternatives are kept because a paginated
  // collection is exactly the shape an API changes its mind about, and the cost
  // of being wrong here is an artist not being paid.
  const wallets: any[] = Array.isArray(response)
    ? response
    : (response?.items ?? response?.data ?? response?.wallets ?? []);

  const ngn = wallets.find((w: any) => (w.currency ?? 'NGN') === 'NGN' && w.enabled !== false) ?? wallets[0];

  const id = ngn?.id ?? ngn?.wallet_id;
  if (!id) {
    throw new AppError(502, 'The payment provider did not return a wallet to pay out from.');
  }

  cachedWalletId = id;
  return id;
}

/**
 * Pays a released booking out to its artist.
 *
 * Called immediately after a release. FAILURE IS RECORDED, NOT THROWN: the
 * release already happened and is correct, and turning a payout problem into a
 * failed release would roll back a money movement that has already left the
 * escrow. A booking released but not paid out is a state a person can find —
 * `payoutFailureReason` is set and `paidOutAt` stays null — and retry.
 *
 * Idempotent on the booking: one already paid out returns what happened.
 */
async function payOut({
  bookingId,
  amountKobo,
  reason,
}: {
  bookingId: string;
  amountKobo: Kobo;
  reason?: string;
}): Promise<PayoutResult> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { artist: true },
  });

  if (!booking) throw new AppError(404, 'Booking not found.');

  if (booking.payoutId) {
    return { bookingId, paid: false, alreadyPaid: true, payoutId: booking.payoutId };
  }

  if (amountKobo <= 0) {
    // A payout of nothing is not a failure — a release can be fully consumed by
    // an outstanding liability (#26).
    return { bookingId, paid: false, reason: 'nothing_to_pay' };
  }

  if (!booking.artist.payoutAccountId) {
    await recordFailure(
      bookingId,
      'The artist has no bank account on file, so the payout could not be sent.'
    );
    return { bookingId, paid: false, reason: 'no_payout_account' };
  }

  try {
    const payout = await escrowpay.walletPayout({
      walletId: await walletId(),
      amountKobo,
      payoutAccountId: booking.artist.payoutAccountId,
      reference: `${booking.escrowReference}_payout`,
      transactionId: booking.escrowId,
      reason: reason ?? 'Artist payment for a completed booking',
    });

    const payoutId = payout?.id ?? payout?.payout_id ?? null;

    await prisma.booking.update({
      where: { id: bookingId },
      data: { payoutId, paidOutAt: new Date(), payoutFailureReason: null },
    });

    console.log(`[payout] booking ${bookingId} paid ${amountKobo} kobo to the artist (${payoutId})`);

    return { bookingId, paid: true, payoutId };
  } catch (err) {
    const message = (err as Error).message;
    await recordFailure(bookingId, message);

    // Loud, because money is sitting in our wallet that belongs to someone else.
    console.error(`[payout] BOOKING ${bookingId} RELEASED BUT NOT PAID OUT: ${message}`);

    return { bookingId, paid: false, reason: 'provider_error', detail: message };
  }
}

function recordFailure(bookingId: string, reason: string) {
  return prisma.booking.update({
    where: { id: bookingId },
    data: { payoutFailureReason: reason.slice(0, 2000) },
  });
}

/**
 * Bookings released but not paid out — money of ours that is not ours.
 *
 * The one query an operator needs when the provider has been down: every
 * booking where the artist is owed and has not been sent it.
 */
async function awaitingPayout(): Promise<BookingRow[]> {
  return prisma.booking.findMany({
    where: { state: 'RELEASED', paidOutAt: null },
    orderBy: { releasedAt: 'asc' },
    include: { artist: { select: { id: true, stageName: true, payoutAccountId: true } } },
  });
}

module.exports = {
  registerPayoutAccount,
  publicPayoutAccount,
  banks,
  payOut,
  awaitingPayout,
  walletId,
  NUBAN_LENGTH,
};
