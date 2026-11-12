-- CreateEnum
CREATE TYPE "TrackMatchReviewStatus" AS ENUM ('AUTO_MATCHED', 'NEEDS_REVIEW', 'CONFIRMED', 'REJECTED');

-- AlterTable tracks: conflict review markers
ALTER TABLE "tracks" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tracks" ADD COLUMN "conflictReason" TEXT;

-- AlterTable track_matches: durable review status and conflicting metadata pointers
ALTER TABLE "track_matches" ADD COLUMN "reviewStatus" "TrackMatchReviewStatus" NOT NULL DEFAULT 'AUTO_MATCHED';
ALTER TABLE "track_matches" ADD COLUMN "conflictReason" TEXT;
ALTER TABLE "track_matches" ADD COLUMN "conflictingTrackId" TEXT;
CREATE INDEX "track_matches_reviewStatus_idx" ON "track_matches"("reviewStatus");

-- AlterTable outbox_events: lease generation and per-claim fencing token
ALTER TABLE "outbox_events" ADD COLUMN "leaseGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "outbox_events" ADD COLUMN "leaseToken" TEXT;
CREATE INDEX "outbox_events_leaseToken_idx" ON "outbox_events"("leaseToken");

