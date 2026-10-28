-- Accounts whose password was set by someone else (admin create/reset, CLI
-- recovery, first-boot seed) must choose their own at next sign-in.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
