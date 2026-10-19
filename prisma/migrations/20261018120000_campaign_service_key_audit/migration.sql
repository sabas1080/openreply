-- Additive only: which service key created or last edited a campaign.
ALTER TABLE "Automation" ADD COLUMN "createdByServiceKeyId" TEXT,
ADD COLUMN "lastEditedByServiceKeyId" TEXT;

CREATE INDEX "Automation_createdByServiceKeyId_idx" ON "Automation"("createdByServiceKeyId");

ALTER TABLE "Automation" ADD CONSTRAINT "Automation_createdByServiceKeyId_fkey" FOREIGN KEY ("createdByServiceKeyId") REFERENCES "ServiceKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_lastEditedByServiceKeyId_fkey" FOREIGN KEY ("lastEditedByServiceKeyId") REFERENCES "ServiceKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
