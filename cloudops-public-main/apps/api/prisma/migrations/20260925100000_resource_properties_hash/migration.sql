-- Detect configuration changes (properties) cheaply during sync.
ALTER TABLE "Resource" ADD COLUMN "propertiesHash" TEXT;
