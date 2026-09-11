-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'ARTIST', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "AccountStanding" AS ENUM ('GOOD', 'WARNED', 'RESTRICTED', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'RETRYABLE_FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('NIN', 'BVN');

-- CreateEnum
CREATE TYPE "BookingState" AS ENUM ('PENDING_PAYMENT', 'FUNDED_HELD', 'CHECKED_IN', 'AWAITING_CONFIRMATION', 'RELEASED', 'REFUNDED', 'CANCELLED', 'DISPUTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeState" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED_RELEASE', 'RESOLVED_REFUND', 'RESOLVED_SPLIT');

-- CreateEnum
CREATE TYPE "CancellationInitiator" AS ENUM ('CLIENT', 'ARTIST', 'ADMIN');

-- CreateEnum
CREATE TYPE "FeeBearer" AS ENUM ('CLIENT', 'ARTIST', 'PLATFORM');

-- CreateEnum
CREATE TYPE "FeeLiabilityStatus" AS ENUM ('OUTSTANDING', 'SETTLED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "LedgerParty" AS ENUM ('CLIENT', 'ARTIST', 'PLATFORM', 'PROVIDER');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('FUNDED', 'RELEASED', 'REFUNDED', 'COMMISSION', 'ESCROW_FEE_IN', 'ESCROW_FEE_OUT', 'ARTIST_COMPENSATION', 'FEE_LIABILITY_ACCRUED', 'FEE_LIABILITY_SETTLED', 'CORRECTION');

-- CreateEnum
CREATE TYPE "StrikeTrigger" AS ENUM ('ARTIST_CANCEL_3_6_DAYS', 'ARTIST_CANCEL_1_2_DAYS', 'ARTIST_CANCEL_DAY_OF', 'CLIENT_CANCEL_1_2_DAYS', 'CLIENT_CANCEL_DAY_OF', 'DISPUTE_RULED_AGAINST', 'DISPUTE_FALSE_NO_SHOW_CLAIM');

-- CreateEnum
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verificationMethod" "VerificationMethod",
    "verifiedAt" TIMESTAMP(3),
    "verificationReference" TEXT,
    "accountStanding" "AccountStanding" NOT NULL DEFAULT 'GOOD',
    "restrictedMinLeadDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "bio" TEXT,
    "category" TEXT,
    "location" TEXT,
    "media" JSONB,
    "baseRateKobo" INTEGER,
    "profileComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "eventEndAt" TIMESTAMP(3) NOT NULL,
    "eventLocation" TEXT,
    "state" "BookingState" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "escrowReference" TEXT NOT NULL,
    "escrowId" TEXT,
    "commissionRateBpsSnapshot" INTEGER NOT NULL,
    "cancellationTiersSnapshot" JSONB NOT NULL,
    "checkInCode" TEXT,
    "checkInCodeValidFrom" TIMESTAMP(3),
    "checkInCodeValidTo" TIMESTAMP(3),
    "fundedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedByUser" TEXT NOT NULL,
    "latitude" TEXT,
    "longitude" TEXT,
    "accuracyMeters" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cancellation" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "initiatedBy" "CancellationInitiator" NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "daysBeforeEvent" INTEGER NOT NULL,
    "appliedTier" JSONB NOT NULL,
    "clientRefundKobo" INTEGER NOT NULL,
    "artistCompensationKobo" INTEGER NOT NULL,
    "escrowFeesKobo" INTEGER NOT NULL,
    "feeBearer" "FeeBearer" NOT NULL,
    "reclassifiedAsArtistFault" BOOLEAN NOT NULL DEFAULT false,
    "reclassifiedByUserId" TEXT,
    "reclassificationReason" TEXT,
    "reclassifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cancellation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "openedByUserId" TEXT NOT NULL,
    "openedReason" TEXT NOT NULL,
    "state" "DisputeState" NOT NULL DEFAULT 'OPEN',
    "checkInId" TEXT,
    "resolvedByUserId" TEXT,
    "resolutionReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "splitClientKobo" INTEGER,
    "splitArtistKobo" INTEGER,
    "externalMediatorOpinion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeEvidence" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "statement" TEXT,
    "fileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsAcknowledgement" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "tiersAsDisplayed" JSONB NOT NULL,
    "commissionRateBpsAsDisplayed" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TermsAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "party" "LedgerParty" NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "description" TEXT,
    "offsetsEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeLiability" (
    "id" TEXT NOT NULL,
    "artistUserId" TEXT NOT NULL,
    "originBookingId" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "FeeLiabilityStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "settledAgainstBookingId" TEXT,
    "settledAt" TIMESTAMP(3),
    "writtenOffAt" TIMESTAMP(3),
    "writeOffReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeeLiability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRate" (
    "id" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CancellationTier" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "minDaysBefore" INTEGER NOT NULL,
    "maxDaysBefore" INTEGER,
    "clientRefundBps" INTEGER NOT NULL,
    "artistCompensationBps" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CancellationTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Strike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" "StrikeTrigger" NOT NULL,
    "weight" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "bookingId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "overriddenByUserId" TEXT,
    "overrideReason" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_accountStanding_idx" ON "User"("accountStanding");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_userId_key" ON "Artist"("userId");

-- CreateIndex
CREATE INDEX "Artist_category_idx" ON "Artist"("category");

-- CreateIndex
CREATE INDEX "Artist_location_idx" ON "Artist"("location");

-- CreateIndex
CREATE UNIQUE INDEX "Client_userId_key" ON "Client"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_escrowReference_key" ON "Booking"("escrowReference");

-- CreateIndex
CREATE INDEX "Booking_state_idx" ON "Booking"("state");

-- CreateIndex
CREATE INDEX "Booking_clientId_idx" ON "Booking"("clientId");

-- CreateIndex
CREATE INDEX "Booking_artistId_idx" ON "Booking"("artistId");

-- CreateIndex
CREATE INDEX "Booking_eventDate_idx" ON "Booking"("eventDate");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_bookingId_key" ON "CheckIn"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Cancellation_bookingId_key" ON "Cancellation"("bookingId");

-- CreateIndex
CREATE INDEX "Cancellation_initiatedBy_idx" ON "Cancellation"("initiatedBy");

-- CreateIndex
CREATE INDEX "Dispute_state_idx" ON "Dispute"("state");

-- CreateIndex
CREATE INDEX "Dispute_bookingId_idx" ON "Dispute"("bookingId");

-- CreateIndex
CREATE INDEX "DisputeEvidence_disputeId_idx" ON "DisputeEvidence"("disputeId");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAcknowledgement_bookingId_key" ON "TermsAcknowledgement"("bookingId");

-- CreateIndex
CREATE INDEX "LedgerEntry_bookingId_idx" ON "LedgerEntry"("bookingId");

-- CreateIndex
CREATE INDEX "LedgerEntry_entryType_idx" ON "LedgerEntry"("entryType");

-- CreateIndex
CREATE INDEX "FeeLiability_artistUserId_status_idx" ON "FeeLiability"("artistUserId", "status");

-- CreateIndex
CREATE INDEX "CommissionRate_effectiveFrom_idx" ON "CommissionRate"("effectiveFrom");

-- CreateIndex
CREATE INDEX "CancellationTier_versionId_idx" ON "CancellationTier"("versionId");

-- CreateIndex
CREATE INDEX "CancellationTier_effectiveFrom_idx" ON "CancellationTier"("effectiveFrom");

-- CreateIndex
CREATE INDEX "Strike_userId_active_idx" ON "Strike"("userId", "active");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_key" ON "WebhookEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_processingStatus_idx" ON "WebhookEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");

-- AddForeignKey
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cancellation" ADD CONSTRAINT "Cancellation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "CheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeEvidence" ADD CONSTRAINT "DisputeEvidence_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcknowledgement" ADD CONSTRAINT "TermsAcknowledgement_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeLiability" ADD CONSTRAINT "FeeLiability_artistUserId_fkey" FOREIGN KEY ("artistUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeLiability" ADD CONSTRAINT "FeeLiability_originBookingId_fkey" FOREIGN KEY ("originBookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeLiability" ADD CONSTRAINT "FeeLiability_settledAgainstBookingId_fkey" FOREIGN KEY ("settledAgainstBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Strike" ADD CONSTRAINT "Strike_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
