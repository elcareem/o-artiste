-- CreateTable: the auto-release grace period, moved out of an environment
-- variable so it can be changed from the settings screen without a deploy.
CREATE TABLE "AutoReleaseConfig" (
    "id" TEXT NOT NULL,
    "graceHours" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoReleaseConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoReleaseConfig_effectiveFrom_idx" ON "AutoReleaseConfig"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "AutoReleaseConfig" ADD CONSTRAINT "AutoReleaseConfig_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
