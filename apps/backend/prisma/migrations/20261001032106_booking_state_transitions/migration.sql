-- CreateTable
CREATE TABLE "BookingStateTransition" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromState" "BookingState",
    "toState" "BookingState" NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingStateTransition_bookingId_createdAt_idx" ON "BookingStateTransition"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingStateTransition" ADD CONSTRAINT "BookingStateTransition_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingStateTransition" ADD CONSTRAINT "BookingStateTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

