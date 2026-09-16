-- CreateTable
CREATE TABLE "StrikeRule" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "trigger" "StrikeTrigger" NOT NULL,
    "weight" INTEGER NOT NULL,
    "minDaysBefore" INTEGER,
    "maxDaysBefore" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrikeRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StrikeRule_versionId_idx" ON "StrikeRule"("versionId");

-- CreateIndex
CREATE INDEX "StrikeRule_effectiveFrom_idx" ON "StrikeRule"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "StrikeRule" ADD CONSTRAINT "StrikeRule_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
