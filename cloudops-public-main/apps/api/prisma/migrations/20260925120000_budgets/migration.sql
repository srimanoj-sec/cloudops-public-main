-- Monthly budgets per scope (tracked against month-to-date cost and forecast).
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'all',
    "scopeId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "alertPercent" INTEGER NOT NULL DEFAULT 80,
    "createdById" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);
