-- AddForeignKey: name the author of the two oldest configuration tables.
--
-- CommissionRate and CancellationTier carried setByUserId as a bare string
-- while every table added afterwards carried a relation. A change history
-- exists to answer "who changed this and when" (docs/07 §5), and answering it
-- with an id sends the reader to a second query they will not run.
--
-- Both columns already hold real user ids — they are written from an
-- authenticated request or the seed — so the constraint validates against
-- existing rows.
ALTER TABLE "CommissionRate" ADD CONSTRAINT "CommissionRate_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CancellationTier" ADD CONSTRAINT "CancellationTier_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
