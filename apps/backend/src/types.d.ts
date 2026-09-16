/**
 * Shared domain types — the vocabulary the money code is written in.
 *
 * This file declares GLOBAL types deliberately. Every backend module is
 * CommonJS (`require`/`module.exports`) with no top-level `import`, which makes
 * each one a script rather than a module in TypeScript's view — so declarations
 * here are visible everywhere without adding an import to 57 files and without
 * changing a single line of runtime code.
 *
 * Nothing here emits anything. Node strips types at runtime; this file is never
 * loaded at all.
 */

/**
 * An integer number of kobo. ONE HUNDRED KOBO TO THE NAIRA.
 *
 * Every monetary value in this system is kobo: in the database, in service
 * code, and in every API payload. Naira exists only in `formatNaira()` output
 * at the moment a number is shown to a person (docs/00 §6).
 */
type Kobo = number;

/**
 * Basis points — one hundredth of one percent. 500 bps is 5%.
 *
 * Percentages are integers here for the same reason money is: a float
 * percentage applied to a kobo amount reintroduces exactly the rounding error
 * the integer discipline exists to prevent.
 */
type Bps = number;

/** Prisma's interactive transaction client. */
type PrismaTx = Omit<
  import('@prisma/client').PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Either the base client or a transaction client, for callers that accept both. */
type PrismaLike = import('@prisma/client').PrismaClient | PrismaTx;

type BookingState = import('@prisma/client').BookingState;
type LedgerParty = import('@prisma/client').LedgerParty;
type LedgerEntryType = import('@prisma/client').LedgerEntryType;
type UserRole = import('@prisma/client').UserRole;
type VerificationStatus = import('@prisma/client').VerificationStatus;
type AccountStanding = import('@prisma/client').AccountStanding;
type FeeLiabilityStatus = import('@prisma/client').FeeLiabilityStatus;

type BookingRow = import('@prisma/client').Booking;
type UserRow = import('@prisma/client').User;
type ArtistRow = import('@prisma/client').Artist;
type ClientRow = import('@prisma/client').Client;
type LedgerEntryRow = import('@prisma/client').LedgerEntry;
type FeeLiabilityRow = import('@prisma/client').FeeLiability;
type WebhookEventRow = import('@prisma/client').WebhookEvent;

/** A cancellation tier as frozen onto a booking (`cancellationTiersSnapshot`). */
interface CancellationTierSnapshot {
  minDaysBefore: number;
  maxDaysBefore: number | null;
  clientRefundBps: Bps;
  artistCompensationBps: Bps;
}

/** The authenticated caller, attached to the request by `requireAuth`. */
interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  verificationStatus: VerificationStatus;
  accountStanding: AccountStanding;
  [key: string]: unknown;
}

declare namespace Express {
  interface Request {
    user?: AuthenticatedUser;
  }
}

/** Express aliases, so handler signatures stay readable. */
type Req = import('express').Request;
type Res = import('express').Response;
type Next = import('express').NextFunction;

/** The claims carried by a session token (`lib/auth.ts`). */
interface TokenPayload {
  sub: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

/** A row destined for `AuditLog`. */
type AuditEntry = import('@prisma/client').Prisma.AuditLogUncheckedCreateInput;

// ── Fee computation results (`services/feeService.ts`) ──────────────────────

/** Who bears a given fee. */
type FeeBearer = 'CLIENT' | 'ARTIST' | 'PLATFORM';

/** One party's share of a settled booking, used for reconciliation. */
interface FeePart {
  party: LedgerParty;
  kobo: Kobo;
}

/** A booking that completes and releases — `computeCompletion`. */
interface CompletionBreakdown {
  amountKobo: Kobo;
  /** What the client actually transfers: amount PLUS the money-in fee. */
  clientPaysKobo: Kobo;
  commissionKobo: Kobo;
  moneyInFeeKobo: Kobo;
  moneyOutFeeKobo: Kobo;
  artistNetKobo: Kobo;
  platformNetKobo: Kobo;
  moneyInBearer: FeeBearer;
  moneyOutBearer: FeeBearer;
  commissionBearer: FeeBearer;
  parts: FeePart[];
}

/** A client-initiated cancellation — `computeClientCancellation`. */
interface ClientCancellationBreakdown {
  amountKobo: Kobo;
  clientShareKobo: Kobo;
  artistShareKobo: Kobo;
  moneyInFeeKobo: Kobo;
  moneyOutFeeKobo: Kobo;
  clientSunkFeeKobo: Kobo;
  clientRefundKobo: Kobo;
  unrecoveredShortfallKobo: Kobo;
  commissionKobo: Kobo;
  artistCompensationKobo: Kobo;
  moneyInBearer: FeeBearer;
  moneyOutBearer: FeeBearer;
}

/** An artist-initiated cancellation — `computeArtistCancellation`. */
interface ArtistCancellationBreakdown {
  amountKobo: Kobo;
  clientRefundKobo: Kobo;
  clientFeeReimbursementKobo: Kobo;
  clientTotalReturnedKobo: Kobo;
  moneyInFeeKobo: Kobo;
  moneyOutFeeKobo: Kobo;
  feeLiabilityKobo: Kobo;
  artistCompensationKobo: Kobo;
  commissionKobo: Kobo;
  feeBearer: FeeBearer;
}

/** The result of netting liabilities off a payout — `applyFeeLiabilities`. */
interface LiabilitySettlement {
  payoutKobo: Kobo;
  settledKobo: Kobo;
  remainingLiabilityKobo: Kobo;
}

/** One leg of a money movement, as written to the ledger. */
interface LedgerLeg {
  entryType: LedgerEntryType;
  party: LedgerParty;
  amountKobo: Kobo;
  description?: string | null;
  offsetsEntryId?: string | null;
}

/** A full ledger entry, including the booking it belongs to. */
interface LedgerEntryInput extends LedgerLeg {
  bookingId: string;
}

/** The result of summing a booking's ledger — `ledgerService.reconcile`. */
interface Reconciliation {
  bookingId: string;
  entryCount: number;
  sumKobo: Kobo;
  balanced: boolean;
  byParty: Record<LedgerParty, Kobo>;
  entries: LedgerEntryRow[];
}

// ── Escrow (`services/escrowService.ts`) ────────────────────────────────────

/** Bank transfer details a client pays into. */
interface BankTransferInstruction {
  accountNumber: string;
  accountName: string;
  bankCode?: string | null;
  provider?: string | null;
  expiresAt?: string | null;
}

/** What the client portal shows while a booking awaits payment (#21). */
interface FundingInstruction {
  bookingId: string;
  escrowReference: string;
  escrowId: string | null;
  state: BookingState;
  escrowState: string | null;
  bookingAmountKobo: Kobo;
  providerFeeKobo: Kobo;
  amountToTransferKobo: Kobo;
  channels: string[];
  bankTransfer: BankTransferInstruction | null;
}

/** What a release did — `escrowService.releaseBooking`. */
interface ReleaseSummary {
  /** The provider payout id, once the money has left our wallet for the artist. */
  payoutId?: string | null;
  /** False means released into our wallet but not yet sent on. */
  paidOut?: boolean;
  payoutFailureReason?: string | null;
  bookingId: string;
  state: BookingState;
  amountKobo: Kobo;
  commissionRateBpsSnapshot: Bps;
  commissionKobo: Kobo;
  moneyOutFeeKobo: Kobo;
  artistNetKobo: Kobo;
  artistPayoutKobo: Kobo;
  liabilitySettledKobo: Kobo;
  liabilityRemainingKobo: Kobo;
  platformNetKobo: Kobo;
  alreadyReleased: boolean;
  providerReleaseId: string | null;
}

/** Extra context passed into `releaseSummaryFor`. */
interface ReleaseSummaryExtra {
  /** The wallet-to-artist leg, where the money actually reaches them. */
  payout?: PayoutResult;
  completion?: CompletionBreakdown;
  settlement?: LiabilitySettlement;
  liabilities?: FeeLiabilityRow[];
  alreadyReleased?: boolean;
  providerReleaseId?: string | null;
}

/** A provider checkout session, as far as we rely on it. */
interface CheckoutSession {
  allowed_channels?: string[];
  payment_instructions?: {
    amount_minor?: Kobo;
    account_number: string;
    account_name: string;
    bank_code?: string | null;
    provider?: string | null;
    expires_at?: string | null;
  };
  [key: string]: unknown;
}

/** A provider transaction, as far as we rely on it. */
interface ProviderTransaction {
  id: string;
  status?: string;
  version?: number;
  amount_minor?: Kobo;
  funded_minor?: Kobo;
  released_minor?: Kobo;
  refunded_minor?: Kobo;
  [key: string]: unknown;
}

// ── Webhooks (`services/webhookService.ts`) ─────────────────────────────────

/** A provider webhook body. */
interface WebhookPayload {
  id?: string;
  type?: string;
  api_version?: string;
  created_at?: string;
  object?: string;
  object_id?: string;
  data?: Record<string, unknown> & { transaction_id?: string };
  [key: string]: unknown;
}

/** What one delivery produced. */
interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
  outcome:
    | 'processed'
    | 'duplicate'
    | 'rejected'
    | 'malformed'
    | 'retry_queued'
    | 'acknowledged'
    | 'unknown_type';
  result?: WebhookHandlerResult;
}

/** What a single event handler reports back. */
interface WebhookHandlerResult {
  note?: string;
  bookingId?: string;
}

type WebhookHandler = (payload: WebhookPayload) => Promise<WebhookHandlerResult>;

// ── Provider transport (`lib/escrowpay.ts`) ─────────────────────────────────

/** One request to the provider's Merchant API. */
interface ProviderRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Sent as `Idempotency-Key`. Our own reference, never the provider's. */
  idempotencyKey?: string;
  retries?: number;
}

/** The verdict of checking a webhook signature. */
interface SignatureVerdict {
  valid: boolean;
  reason?:
    | 'missing_signature'
    | 'malformed_signature'
    | 'timestamp_outside_tolerance'
    | 'signature_mismatch';
}

/**
 * An `AppError` as seen from a module that pulled it in with `require`.
 *
 * A CommonJS destructure produces a value binding, not a type, so the class
 * name cannot be used as a type at the call site. This alias describes the same
 * shape without depending on the import.
 */
type AppErrorLike = Error & {
  status: number;
  expected: boolean;
  providerStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  requestId?: string;
};

/** An axios response from the provider, as far as we read it. */
interface ProviderResponse {
  status: number;
  data?: any;
  headers?: Record<string, any>;
  config?: { method?: string; url?: string; [key: string]: unknown };
}

/**
 * A request that has passed `requireAuth`.
 *
 * Distinct from `Req` deliberately: `user` is optional on a plain request
 * because a public route genuinely does not have one, and a handler that reads
 * `req.user` should have to say it sits behind the guard. Annotating with this
 * is the claim "requireAuth runs before me", checked by the reader rather than
 * by a non-null assertion scattered through the body.
 */
type AuthedReq = Req & { user: AuthenticatedUser };

// ── Check-in codes (`services/checkInService.ts`) ────────────────────────────

/** A request to `lib/notifications.ts`. */
interface SmsRequest {
  /** E.164 phone number. */
  to: string;
  /** Body. Kept short — Nigerian networks bill per 160-character segment. */
  message: string;
  /** Correlates the log line with what caused it. */
  reference?: string;
}

interface SmsResult {
  delivered: boolean;
  /** True while #38 is unimplemented, so a caller can tell a stub from a send. */
  stubbed: boolean;
  /** Masked, never the full number — see `maskPhone`. */
  to: string;
  segments: number;
}

/** The fields of a booking that determine its check-in window. */
interface CheckInWindowInput {
  eventDate: Date | string;
  eventEndAt?: Date | string | null;
}

interface CheckInWindow {
  validFrom: Date;
  validTo: Date;
}

/**
 * The result of `issueForBooking`.
 *
 * `issued` distinguishes a code this call created from one that already
 * existed. It matters: the funding webhook is retryable, and a retry must send
 * nothing, because the client already has the code from the first delivery.
 */
interface IssuedCheckInCode {
  code: string;
  validFrom: Date | null;
  validTo: Date | null;
  issued: boolean;
}

/** Why a code cannot be redeemed right now, phrased for the person reading it. */
interface CheckInValidity {
  valid: boolean;
  reason: 'already_redeemed' | 'too_early' | 'expired' | null;
  message: string | null;
}

/** The minimum a booking must carry for `validityOf` to judge it. */
interface RedeemableBooking {
  checkIn?: { id: string } | null;
  checkInCodeValidFrom?: Date | null;
  checkInCodeValidTo?: Date | null;
}

interface CheckInCodeRequest {
  bookingId: string;
  userId: string;
}

/** What `GET /bookings/:id/check-in-code` returns. To the client, and only the client. */
interface CheckInCodeView extends CheckInValidity {
  bookingId: string;
  /** Hyphenated for reading aloud: `K7QX-M2F9`. */
  code: string;
  /** A PNG data URL. Rendered server-side so the code reaches no third party. */
  qrDataUrl: string;
  validFrom: Date | null;
  validTo: Date | null;
}

/** The outcome of one check-in-code SMS job (`jobs/checkInCodeJob.ts`). */
interface CheckInCodeDelivery {
  bookingId: string;
  sent: boolean;
  reason?: 'booking_missing' | 'booking_not_active' | 'no_code';
  /** Absent unless `sent`. False while #38 is unimplemented. */
  delivered?: boolean;
  stubbed?: boolean;
}

// ── Check-in redemption (`services/checkInService.ts`, issue #23) ────────────

type CheckInRow = import('@prisma/client').CheckIn;

/**
 * Geolocation as captured at the door.
 *
 * `unknown` rather than `number`, deliberately: these come straight off a
 * request body, where a browser's failure modes produce strings, nulls and the
 * literal `"NaN"`. Narrowing happens in `boundedCoordinate`, which drops
 * anything implausible instead of rejecting the check-in.
 */
interface GeolocationInput {
  latitude?: unknown;
  longitude?: unknown;
  accuracyMeters?: unknown;
}

/**
 * A redemption attempt.
 *
 * THERE IS NO TIMESTAMP FIELD, and that is the point. The record's value as
 * dispute evidence rests entirely on the time being ours, so a caller has no
 * way to express one — not even an ignored one.
 */
interface RedeemRequest extends GeolocationInput {
  bookingId: string;
  /** The artist presenting the code. Recorded as `redeemedByUser`. */
  artistUserId: string;
  /** As typed or scanned. Case, spacing and the dash are all forgiven. */
  code: unknown;
}

interface CheckInRedemption {
  checkIn: CheckInRow;
  booking: BookingRow;
}

/** What `escrowService.refundBooking` reports (#24). */
interface RefundSummary {
  bookingId: string;
  state: BookingState;
  /** True when the booking was already REFUNDED and no provider call was made. */
  alreadyRefunded: boolean;
  clientRefundKobo: Kobo | null;
  clientFeeReimbursementKobo: Kobo | null;
  clientTotalReturnedKobo: Kobo | null;
  /** Fronted by the platform, recovered from the artist at their next payout. */
  feeLiabilityKobo: Kobo | null;
  providerRefundId: string | null;
}

// ── Confirmation matrix (`services/confirmationService.ts`, issue #24) ───────

/**
 * What the matrix decides.
 *
 * `awaiting_auto_release` and `awaiting_response` are both "nothing happens
 * now", and they are separate because only the first one has something that
 * will ever happen on its own: #25's job fires only where a check-in exists.
 */
type ConfirmationOutcome =
  | 'release'
  | 'refund'
  | 'dispute'
  | 'awaiting_auto_release'
  | 'awaiting_response';

/** The matrix inputs. Facts, not a booking row, so `evaluate` needs no database. */
interface ConfirmationFacts {
  clientConfirmed: boolean;
  clientClaimedNoShow: boolean;
  artistConfirmed: boolean;
  hasCheckIn: boolean;
}

interface ConfirmationVerdict {
  outcome: ConfirmationOutcome;
  /** Written for a person: it becomes the release reason or the dispute's opening statement. */
  reason: string;
}

/** A booking with everything the matrix and its gates need. */
type ConfirmableBooking = BookingRow & {
  checkIn?: { id: string } | null;
  client: ClientRow;
  artist: ArtistRow;
};

interface ConfirmationResult extends ConfirmationVerdict {
  bookingId: string;
  state: BookingState;
  actedBy: 'CLIENT' | 'ARTIST';
  release?: ReleaseSummary;
  refund?: RefundSummary;
  disputeId?: string;
}

/** One environment variable the process cannot start without (`lib/requiredEnv.ts`). */
interface EnvRequirement {
  name: string;
  /** What breaks without it, in terms of what a user would see. */
  why: string;
  minLength?: number;
  /**
   * How to obtain an acceptable value — a command to run, or where to find it.
   * Shown in the failure, because the person reading it at 2am is often not the
   * person who knows where the secret lives.
   */
  how?: string;
}

// ── Auto-release (`jobs/autoReleaseJob.ts`, issue #25) ───────────────────────

/**
 * Why auto-release did nothing.
 *
 * Every one of these is a case where releasing would be wrong, and they are
 * named separately because "the job ran and did not pay anyone" is a sentence
 * an operator will need explained.
 */
type AutoReleaseSkipReason =
  | 'booking_missing'
  | 'already_settled'
  | 'dispute_open'
  | 'no_check_in'
  | 'client_claimed_no_show'
  | 'not_yet_due';

interface AutoReleaseOutcome {
  bookingId: string;
  /** True only when THIS run moved the money. A second run reports false. */
  released: boolean;
  reason: AutoReleaseSkipReason | 'released';
  release?: ReleaseSummary;
}

/** One dependency check in `GET /admin/diagnostics` (#41). */
interface DiagnosticCheck {
  ok: boolean;
  latencyMs: number;
  /** Human-readable. Carries an error message on failure, never a credential. */
  detail: string;
}

/** What a client cancellation reports (#27). */
interface CancellationSummary {
  bookingId: string;
  state: BookingState;
  /** True when the booking was already CANCELLED and no provider call was made. */
  alreadyCancelled: boolean;
  /** True when the booking was never funded, so there was nothing to split. */
  unfunded: boolean;
  daysBeforeEvent: number | null;
  /** A copy of the band applied, from the booking's own snapshot. */
  appliedTier: CancellationTierSnapshot | null;
  clientRefundKobo: Kobo | null;
  artistCompensationKobo: Kobo | null;
  commissionKobo: Kobo | null;
  /** Paid at funding, consumed, not refundable — the client's own cost. */
  clientSunkFeeKobo: Kobo | null;
  moneyOutFeeKobo: Kobo | null;
  /** Artist-initiated only (#28): the money-in fee returned to the client. */
  clientFeeReimbursementKobo?: Kobo | null;
  /** Artist-initiated only: fronted by the platform, recovered at the next payout. */
  feeLiabilityKobo?: Kobo | null;
}

// ── Strikes (`services/strikeService.ts`, issue #33) ─────────────────────────

type StrikeTrigger = import('@prisma/client').StrikeTrigger;
type StrikeRow = import('@prisma/client').Strike;
type StrikeRuleRow = import('@prisma/client').StrikeRule;

/** A rule as submitted, before it is versioned and stored. */
interface StrikeRuleInput {
  trigger: StrikeTrigger;
  /** Whole, at least 1. Weight is what #34's ladders read, not a count. */
  weight: number;
  /** Inclusive; null on both for the dispute triggers, which are not timed. */
  minDaysBefore?: number | null;
  maxDaysBefore?: number | null;
}

interface AccrueStrikeInput {
  userId: string;
  rule: Pick<StrikeRuleRow, 'trigger' | 'weight'>;
  bookingId?: string | null;
  /** Recorded verbatim. Every strike is appealable, so its cause must survive. */
  reason: string;
}

interface CancellationStrikeInput {
  userId: string;
  by: 'ARTIST' | 'CLIENT';
  daysBefore: number;
  bookingId?: string | null;
  at?: Date;
}

interface DisputeStrikeInput {
  userId: string;
  /** The heavier case: a no-show claim contradicted by a check-in record. */
  falseNoShowClaim: boolean;
  bookingId?: string | null;
  at?: Date;
}

interface StrikeHistory {
  userId: string;
  total: number;
  activeCount: number;
  /** Summed weight of active strikes — what enforcement reads. */
  activeWeight: number;
  strikes: StrikeRow[];
}

/** Handed to `refundBooking`'s `alsoRecord` hook, inside its transaction (#28). */
interface ArtistFaultRefundContext {
  booking: BookingRow & { client: ClientRow; artist: ArtistRow & { user: UserRow } };
  breakdown: ArtistCancellationBreakdown;
  /** Null when the computed liability was zero. */
  liability: FeeLiabilityRow | null;
}

/** What an artist-fault reclassification reports (#29). */
interface ReclassificationSummary {
  cancellationId: string;
  bookingId: string;
  reclassifiedByUserId: string;
  reason: string;
  /** How many original entries were negated. The originals stay queryable. */
  entriesReversed: number;
  /** Paid from the platform's wallet, because the escrow is already empty. */
  additionalToClientKobo: Kobo;
  clientTotalReturnedKobo: Kobo;
  /** Compensation the artist received and should not have. */
  artistClawbackKobo: Kobo;
  /** The clawback plus the fees the platform now fronts, as one debt. */
  liabilityKobo: Kobo;
}

// ── Payouts (`services/payoutService.ts`) ────────────────────────────────────

interface RegisterPayoutAccountInput {
  artistUserId: string;
  bankCode: string;
  /** Ten digits. Sent to the provider once and never stored. */
  accountNumber: string;
  accountName?: string | null;
}

/** What an artist is shown about the account on file. Never the full number. */
interface PayoutAccountView {
  registered: boolean;
  bankCode: string | null;
  accountLast4: string | null;
  accountName: string | null;
  verifiedAt: Date | null;
}

interface PayoutResult {
  bookingId: string;
  /** True only when THIS call moved the money. */
  paid: boolean;
  alreadyPaid?: boolean;
  payoutId?: string | null;
  reason?: 'nothing_to_pay' | 'no_payout_account' | 'provider_error';
  detail?: string;
}
