-- Standards v2: rule library templates, parameters, conditions, scope,
-- remediation; exemptions (accepted exceptions) excluded from scoring.
ALTER TABLE "StandardRule" ADD COLUMN "category" TEXT;
ALTER TABLE "StandardRule" ADD COLUMN "template" TEXT;
ALTER TABLE "StandardRule" ADD COLUMN "params" JSONB;
ALTER TABLE "StandardRule" ADD COLUMN "definition" JSONB;
ALTER TABLE "StandardRule" ADD COLUMN "scope" JSONB;
ALTER TABLE "StandardRule" ADD COLUMN "remediation" TEXT;

ALTER TABLE "ComplianceResult" ADD COLUMN "exempt" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ComplianceExemption" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceExemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComplianceExemption_ruleId_resourceId_key" ON "ComplianceExemption"("ruleId", "resourceId");
CREATE INDEX "ComplianceExemption_resourceId_idx" ON "ComplianceExemption"("resourceId");
ALTER TABLE "ComplianceExemption" ADD CONSTRAINT "ComplianceExemption_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "StandardRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceExemption" ADD CONSTRAINT "ComplianceExemption_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
