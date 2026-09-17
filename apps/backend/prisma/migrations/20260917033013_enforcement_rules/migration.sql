-- CreateEnum
CREATE TYPE "EnforcementParty" AS ENUM ('ARTIST', 'CLIENT');

-- CreateTable: the enforcement ladders, versioned and append-only like
-- StrikeRule. A rung applies at minWeight of active strike weight and above;
-- the harshest matching rung wins.
CREATE TABLE "EnforcementRule" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "party" "EnforcementParty" NOT NULL,
    "minWeight" INTEGER NOT NULL,
    "standing" "AccountStanding" NOT NULL,
    "minLeadDays" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnforcementRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnforcementRule_versionId_idx" ON "EnforcementRule"("versionId");
CREATE INDEX "EnforcementRule_effectiveFrom_idx" ON "EnforcementRule"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "EnforcementRule" ADD CONSTRAINT "EnforcementRule_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
