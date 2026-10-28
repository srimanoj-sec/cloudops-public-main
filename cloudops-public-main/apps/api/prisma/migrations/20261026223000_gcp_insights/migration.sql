CREATE TABLE "ProviderInsightSnapshot" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderInsightSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderInsightSnapshot_providerKey_projectId_capability_key"
    ON "ProviderInsightSnapshot"("providerKey", "projectId", "capability");
CREATE INDEX "ProviderInsightSnapshot_providerKey_syncedAt_idx"
    ON "ProviderInsightSnapshot"("providerKey", "syncedAt");
