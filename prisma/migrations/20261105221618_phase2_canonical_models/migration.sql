-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('SPOTIFY', 'APPLE_MUSIC', 'YOUTUBE_MUSIC');

-- CreateEnum
CREATE TYPE "ProviderAccountStatus" AS ENUM ('CONNECTED', 'EXPIRED', 'REVOKED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "LibrarySourceProvenance" AS ENUM ('MANUAL', 'SPOTIFY_IMPORT', 'APPLE_MUSIC_IMPORT', 'YOUTUBE_MUSIC_IMPORT', 'FILE_IMPORT');

-- CreateEnum
CREATE TYPE "ProviderItemType" AS ENUM ('TRACK', 'ALBUM', 'PLAYLIST');

-- CreateEnum
CREATE TYPE "ProviderItemStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "PlaylistSyncStatus" AS ENUM ('IN_SYNC', 'PENDING_PUSH', 'PENDING_PULL', 'CONFLICT', 'ERROR');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('EXACT_ISRC', 'METADATA_EXACT', 'METADATA_FUZZY', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "SnapshotTrigger" AS ENUM ('MANUAL', 'PRE_SYNC', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "SnapshotItemType" AS ENUM ('TRACK', 'PLAYLIST');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('ONE_WAY', 'TWO_WAY');

-- CreateEnum
CREATE TYPE "ConflictPolicy" AS ENUM ('ADDITIVE_MERGE', 'SOURCE_WINS', 'DESTINATION_WINS', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('IMPORT', 'EXPORT', 'SYNC_RECONCILE', 'SNAPSHOT_RESTORE');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncOperationAction" AS ENUM ('CREATED', 'MATCHED', 'SKIPPED', 'FAILED', 'TOMBSTONED');

-- CreateEnum
CREATE TYPE "SyncOperationStatus" AS ENUM ('SUCCESS', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProviderAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" TEXT NOT NULL,
    "isrc" TEXT,
    "title" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumName" TEXT,
    "durationMs" INTEGER NOT NULL,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "discNumber" INTEGER NOT NULL DEFAULT 1,
    "trackNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_tracks" (
    "id" TEXT NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "matchedTrackId" TEXT,
    "isrc" TEXT,
    "title" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumName" TEXT,
    "durationMs" INTEGER NOT NULL,
    "providerUri" TEXT,
    "rawMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "libraries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_tracks" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceProvenance" "LibrarySourceProvenance" NOT NULL DEFAULT 'MANUAL',
    "userNotes" TEXT,

    CONSTRAINT "library_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_library_items" (
    "id" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "itemType" "ProviderItemType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "ProviderItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_library_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlists" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_items" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "playlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_playlists" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "snapshotId" TEXT,
    "syncStatus" "PlaylistSyncStatus" NOT NULL DEFAULT 'IN_SYNC',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_matches" (
    "id" TEXT NOT NULL,
    "canonicalTrackId" TEXT NOT NULL,
    "providerTrackId" TEXT NOT NULL,
    "matchConfidence" DOUBLE PRECISION NOT NULL,
    "matchMethod" "MatchMethod" NOT NULL,
    "verifiedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "SnapshotTrigger" NOT NULL DEFAULT 'MANUAL',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_snapshot_items" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "itemType" "SnapshotItemType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_snapshot_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceProvider" "ProviderType" NOT NULL,
    "targetProvider" "ProviderType" NOT NULL,
    "direction" "SyncDirection" NOT NULL DEFAULT 'ONE_WAY',
    "conflictPolicy" "ConflictPolicy" NOT NULL DEFAULT 'ADDITIVE_MERGE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobType" "SyncJobType" NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "targetProvider" TEXT NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'QUEUED',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" TEXT NOT NULL,
    "syncJobId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT,
    "action" "SyncOperationAction" NOT NULL,
    "status" "SyncOperationStatus" NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "responsePayload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_accounts_userId_provider_idx" ON "provider_accounts"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_userId_provider_providerUserId_key" ON "provider_accounts"("userId", "provider", "providerUserId");

-- CreateIndex
CREATE INDEX "tracks_isrc_idx" ON "tracks"("isrc");

-- CreateIndex
CREATE INDEX "tracks_title_artistName_idx" ON "tracks"("title", "artistName");

-- CreateIndex
CREATE INDEX "provider_tracks_matchedTrackId_idx" ON "provider_tracks"("matchedTrackId");

-- CreateIndex
CREATE INDEX "provider_tracks_isrc_idx" ON "provider_tracks"("isrc");

-- CreateIndex
CREATE UNIQUE INDEX "provider_tracks_provider_externalId_key" ON "provider_tracks"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "libraries_userId_key" ON "libraries"("userId");

-- CreateIndex
CREATE INDEX "library_tracks_libraryId_addedAt_idx" ON "library_tracks"("libraryId", "addedAt");

-- CreateIndex
CREATE INDEX "library_tracks_trackId_idx" ON "library_tracks"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "library_tracks_libraryId_trackId_key" ON "library_tracks"("libraryId", "trackId");

-- CreateIndex
CREATE INDEX "provider_library_items_providerAccountId_status_idx" ON "provider_library_items"("providerAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provider_library_items_providerAccountId_itemType_externalI_key" ON "provider_library_items"("providerAccountId", "itemType", "externalId");

-- CreateIndex
CREATE INDEX "playlists_libraryId_deletedAt_idx" ON "playlists"("libraryId", "deletedAt");

-- CreateIndex
CREATE INDEX "playlist_items_playlistId_position_idx" ON "playlist_items"("playlistId", "position");

-- CreateIndex
CREATE INDEX "playlist_items_trackId_idx" ON "playlist_items"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_items_playlistId_position_key" ON "playlist_items"("playlistId", "position");

-- CreateIndex
CREATE INDEX "provider_playlists_playlistId_idx" ON "provider_playlists"("playlistId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_playlists_providerAccountId_externalId_key" ON "provider_playlists"("providerAccountId", "externalId");

-- CreateIndex
CREATE INDEX "track_matches_canonicalTrackId_idx" ON "track_matches"("canonicalTrackId");

-- CreateIndex
CREATE INDEX "track_matches_providerTrackId_idx" ON "track_matches"("providerTrackId");

-- CreateIndex
CREATE UNIQUE INDEX "track_matches_canonicalTrackId_providerTrackId_key" ON "track_matches"("canonicalTrackId", "providerTrackId");

-- CreateIndex
CREATE INDEX "library_snapshots_userId_createdAt_idx" ON "library_snapshots"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "library_snapshot_items_snapshotId_itemType_idx" ON "library_snapshot_items"("snapshotId", "itemType");

-- CreateIndex
CREATE INDEX "sync_rules_userId_idx" ON "sync_rules"("userId");

-- CreateIndex
CREATE INDEX "sync_jobs_userId_status_idx" ON "sync_jobs"("userId", "status");

-- CreateIndex
CREATE INDEX "sync_operations_syncJobId_status_idx" ON "sync_operations"("syncJobId", "status");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextRunAt_idx" ON "outbox_events"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_key_scope_key" ON "idempotency_records"("key", "scope");

-- AddForeignKey
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_tracks" ADD CONSTRAINT "provider_tracks_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_tracks" ADD CONSTRAINT "provider_tracks_matchedTrackId_fkey" FOREIGN KEY ("matchedTrackId") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "libraries" ADD CONSTRAINT "libraries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_library_items" ADD CONSTRAINT "provider_library_items_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_playlists" ADD CONSTRAINT "provider_playlists_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_playlists" ADD CONSTRAINT "provider_playlists_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_matches" ADD CONSTRAINT "track_matches_canonicalTrackId_fkey" FOREIGN KEY ("canonicalTrackId") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_matches" ADD CONSTRAINT "track_matches_providerTrackId_fkey" FOREIGN KEY ("providerTrackId") REFERENCES "provider_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_matches" ADD CONSTRAINT "track_matches_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_snapshots" ADD CONSTRAINT "library_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_snapshot_items" ADD CONSTRAINT "library_snapshot_items_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "library_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_rules" ADD CONSTRAINT "sync_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
