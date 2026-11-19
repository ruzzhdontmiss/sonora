-- AlterTable: Add version, isArchived, archivedAt, snapshotHash to playlists
ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "playlists" ADD COLUMN IF NOT EXISTS "snapshotHash" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "playlists_libraryId_isArchived_idx" ON "playlists"("libraryId", "isArchived");

-- AlterTable: Add evidence, updatedAt to track_matches
ALTER TABLE "track_matches" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
ALTER TABLE "track_matches" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Add confirmedAt, cancelledAt to sync_jobs
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
