-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "artistConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "clientConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "clientNoShowClaimedAt" TIMESTAMP(3),
ADD COLUMN     "clientNoShowReason" TEXT;
