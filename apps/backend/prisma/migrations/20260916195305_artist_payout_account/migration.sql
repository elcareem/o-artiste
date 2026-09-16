-- AlterTable: the artist's payout destination.
-- The account number itself is NOT stored; it is sent to the provider once at
-- registration and every later payout is addressed by `payoutAccountId`.
ALTER TABLE "Artist" ADD COLUMN     "payoutAccountId" TEXT,
ADD COLUMN     "payoutBankCode" TEXT,
ADD COLUMN     "payoutAccountLast4" TEXT,
ADD COLUMN     "payoutAccountName" TEXT,
ADD COLUMN     "payoutAccountVerifiedAt" TIMESTAMP(3);

-- AlterTable: the money-out leg on a booking.
ALTER TABLE "Booking" ADD COLUMN     "payoutId" TEXT,
ADD COLUMN     "paidOutAt" TIMESTAMP(3),
ADD COLUMN     "payoutFailureReason" TEXT;

-- CreateIndex: one artist per provider payout account. Existing rows are all
-- NULL, and NULLs do not collide in a PostgreSQL unique index.
CREATE UNIQUE INDEX "Artist_payoutAccountId_key" ON "Artist"("payoutAccountId");
