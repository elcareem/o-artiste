-- CreateTable: the cancellation-rate statistic's configuration. Versioned and
-- append-only, so a rate shown last month can still be explained by the window
-- and threshold that were in force when it was shown.
CREATE TABLE "ReputationConfig" (
    "id" TEXT NOT NULL,
    "windowMonths" INTEGER NOT NULL,
    "minBookings" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReputationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReputationConfig_effectiveFrom_idx" ON "ReputationConfig"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "ReputationConfig" ADD CONSTRAINT "ReputationConfig_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
