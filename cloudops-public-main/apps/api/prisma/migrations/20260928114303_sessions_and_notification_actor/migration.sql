-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "actorId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionsValidAfter" TIMESTAMP(3);
