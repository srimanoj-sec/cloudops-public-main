-- Costs are stored in one reporting currency; conversions keep the original.
ALTER TABLE "CostRecord" ADD COLUMN "originalCost" DOUBLE PRECISION;
ALTER TABLE "CostRecord" ADD COLUMN "originalCurrency" TEXT;
ALTER TABLE "CostRecord" ADD COLUMN "fxRate" DOUBLE PRECISION;
