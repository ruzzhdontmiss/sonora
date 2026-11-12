-- AlterTable tracks: Unique index on isrc
DROP INDEX IF EXISTS "tracks_isrc_idx";
CREATE UNIQUE INDEX "tracks_isrc_key" ON "tracks"("isrc");

-- Step 1: Composite unique constraints on parent entities
CREATE UNIQUE INDEX "libraries_id_userId_key" ON "libraries"("id", "userId");
CREATE UNIQUE INDEX "provider_accounts_id_userId_key" ON "provider_accounts"("id", "userId");
CREATE UNIQUE INDEX "sync_jobs_id_userId_key" ON "sync_jobs"("id", "userId");

-- Step 2: Add userId to playlists with backfill from libraries
ALTER TABLE "playlists" ADD COLUMN "userId" TEXT;
UPDATE "playlists" p SET "userId" = l."userId" FROM "libraries" l WHERE p."libraryId" = l."id";
ALTER TABLE "playlists" ALTER COLUMN "userId" SET NOT NULL;

CREATE UNIQUE INDEX "playlists_id_userId_key" ON "playlists"("id", "userId");
CREATE UNIQUE INDEX "playlists_id_libraryId_key" ON "playlists"("id", "libraryId");
CREATE INDEX "playlists_userId_idx" ON "playlists"("userId");

-- Step 3: Add userId to provider_playlists with backfill from provider_accounts
ALTER TABLE "provider_playlists" ADD COLUMN "userId" TEXT;
UPDATE "provider_playlists" pp SET "userId" = pa."userId" FROM "provider_accounts" pa WHERE pp."providerAccountId" = pa."id";
ALTER TABLE "provider_playlists" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "provider_playlists_userId_idx" ON "provider_playlists"("userId");

-- Step 4: Add libraryId to library_snapshots with backfill from libraries
ALTER TABLE "library_snapshots" ADD COLUMN "libraryId" TEXT;
UPDATE "library_snapshots" s SET "libraryId" = l."id" FROM "libraries" l WHERE s."userId" = l."userId";

-- Step 5: Add lease, locking and fencing fields to outbox_events
ALTER TABLE "outbox_events" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "outbox_events" ADD COLUMN "lockedBy" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
CREATE INDEX "outbox_events_status_leaseExpiresAt_idx" ON "outbox_events"("status", "leaseExpiresAt");

-- Step 6: Add status, lease, and locking fields to idempotency_records
ALTER TABLE "idempotency_records" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "idempotency_records" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "idempotency_records" ADD COLUMN "lockedBy" TEXT;
ALTER TABLE "idempotency_records" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
CREATE INDEX "idempotency_records_status_leaseExpiresAt_idx" ON "idempotency_records"("status", "leaseExpiresAt");

-- Step 7: Enforce composite foreign keys on playlists
ALTER TABLE "playlists" DROP CONSTRAINT IF EXISTS "playlists_libraryId_fkey";
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_libraryId_userId_fkey" FOREIGN KEY ("libraryId", "userId") REFERENCES "libraries"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 8: Enforce composite foreign keys on provider_playlists (preventing cross-user playlist/account mapping at DB level)
ALTER TABLE "provider_playlists" DROP CONSTRAINT IF EXISTS "provider_playlists_playlistId_fkey";
ALTER TABLE "provider_playlists" DROP CONSTRAINT IF EXISTS "provider_playlists_providerAccountId_fkey";
ALTER TABLE "provider_playlists" ADD CONSTRAINT "provider_playlists_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_playlists" ADD CONSTRAINT "provider_playlists_playlistId_userId_fkey" FOREIGN KEY ("playlistId", "userId") REFERENCES "playlists"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_playlists" ADD CONSTRAINT "provider_playlists_providerAccountId_userId_fkey" FOREIGN KEY ("providerAccountId", "userId") REFERENCES "provider_accounts"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 9: Enforce composite foreign keys on library_snapshots
ALTER TABLE "library_snapshots" ADD CONSTRAINT "library_snapshots_libraryId_userId_fkey" FOREIGN KEY ("libraryId", "userId") REFERENCES "libraries"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

