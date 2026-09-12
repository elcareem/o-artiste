-- AlterTable
ALTER TABLE "User" ADD COLUMN     "escrowPartyId" TEXT,
ADD COLUMN     "lastVerificationAttemptAt" TIMESTAMP(3),
ADD COLUMN     "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "verificationFailureReason" TEXT;

-- CreateTable
CREATE TABLE "PlatformCost" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "userId" TEXT,
    "reference" TEXT,
    "description" TEXT,
    "incurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCost_reference_key" ON "PlatformCost"("reference");

-- CreateIndex
CREATE INDEX "PlatformCost_category_incurredAt_idx" ON "PlatformCost"("category", "incurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_escrowPartyId_key" ON "User"("escrowPartyId");

