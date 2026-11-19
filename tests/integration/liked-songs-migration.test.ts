import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  generateMigrationPreview,
  createMigrationJob,
  executeMigrationJob,
} from "@/modules/jobs/migration-orchestrator";
import { encryptToken } from "@/lib/encryption";
import {
  ProviderType,
  ProviderAccountStatus,
  SyncJobStatus,
  SyncJobType,
  SyncOperationStatus,
  TrackMatchReviewStatus,
  MatchMethod,
} from "@prisma/client";
import { ValidationError } from "@/modules/common/errors";
import * as spotifyWriter from "@/modules/providers/spotify/spotify-writer.service";
import * as appleWriter from "@/modules/providers/apple/apple-writer.service";

describe("Liked / Saved Songs Migration (P4-T07 Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000060";
  const spotifyAccountId = "aa000000-0000-0000-0000-000000000061";
  const appleAccountId = "aa000000-0000-0000-0000-000000000062";

  let testLibraryId: string;
  let matchedTrackId: string;
  let unmatchedTrackId: string;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Clean up test data
    await prisma.outboxEvent.deleteMany({ where: { eventType: "MIGRATION_JOB_DISPATCH" } });
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { userId: testUserId } } });
    await prisma.playlist.deleteMany({ where: { userId: testUserId } });
    await prisma.libraryTrack.deleteMany({ where: { library: { userId: testUserId } } });
    await prisma.trackMatch.deleteMany({});
    await prisma.providerTrack.deleteMany({});
    await prisma.track.deleteMany({
      where: {
        playlistItems: { none: {} },
      },
    });
    await prisma.providerAccount.deleteMany({ where: { userId: testUserId } });
    await prisma.library.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });

    // Seed test user & library
    await prisma.user.create({
      data: {
        id: testUserId,
        email: "likedsongs-test@example.com",
        displayName: "Liked Songs Tester",
      },
    });

    const library = await prisma.library.create({
      data: { userId: testUserId },
    });
    testLibraryId = library.id;

    // Seed connected Spotify and Apple accounts
    await prisma.providerAccount.createMany({
      data: [
        {
          id: spotifyAccountId,
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "spotify-liked-user",
          displayName: "Liked Spotify",
          encryptedAccessToken: encryptToken("mock-spotify-token"),
          encryptedRefreshToken: encryptToken("mock-refresh-token"),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scopes: ["playlist-modify-public", "user-library-modify"],
          status: ProviderAccountStatus.CONNECTED,
        },
        {
          id: appleAccountId,
          userId: testUserId,
          provider: ProviderType.APPLE_MUSIC,
          providerUserId: "apple-liked-user",
          displayName: "Liked Apple Music",
          encryptedAccessToken: encryptToken("mock-apple-user-token"),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          status: ProviderAccountStatus.CONNECTED,
        },
      ],
    });

    // Seed Track 1: Matched in Apple Music & Spotify
    const t1 = await prisma.track.create({
      data: {
        title: "Fast Car",
        artistName: "Tracy Chapman",
        durationMs: 296000,
        isrc: "USPR37300099",
      },
    });
    matchedTrackId = t1.id;

    // Seed Track 2: Unmatched (indie live recording)
    const t2 = await prisma.track.create({
      data: {
        title: "Indie Acoustic Jam (Live at Local Cafe)",
        artistName: "Local Artist",
        durationMs: 180000,
      },
    });
    unmatchedTrackId = t2.id;

    // Seed Apple Music provider track & match for Track 1
    const applePt = await prisma.providerTrack.create({
      data: {
        providerAccountId: appleAccountId,
        provider: ProviderType.APPLE_MUSIC,
        externalId: "am-song-fast-car-777",
        title: "Fast Car",
        artistName: "Tracy Chapman",
        durationMs: 296000,
        isrc: "USPR37300099",
      },
    });

    await prisma.trackMatch.create({
      data: {
        canonicalTrackId: matchedTrackId,
        providerTrackId: applePt.id,
        matchConfidence: 0.98,
        matchMethod: MatchMethod.EXACT_ISRC,
        reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
      },
    });

    // Seed Spotify provider track & match for Track 1
    const spotifyPt = await prisma.providerTrack.create({
      data: {
        providerAccountId: spotifyAccountId,
        provider: ProviderType.SPOTIFY,
        externalId: "sp-song-fast-car-888",
        title: "Fast Car",
        artistName: "Tracy Chapman",
        durationMs: 296000,
        isrc: "USPR37300099",
      },
    });

    await prisma.trackMatch.create({
      data: {
        canonicalTrackId: matchedTrackId,
        providerTrackId: spotifyPt.id,
        matchConfidence: 0.98,
        matchMethod: MatchMethod.EXACT_ISRC,
        reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
      },
    });

    // Add both tracks to user's saved library (Liked Songs)
    await prisma.libraryTrack.createMany({
      data: [
        { libraryId: testLibraryId, trackId: matchedTrackId },
        { libraryId: testLibraryId, trackId: unmatchedTrackId },
      ],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe("Liked Songs Migration Preview (P4-T07)", () => {
    it("previews supported target operations, required scopes, and clearly reports untransferable items", async () => {
      const preview = await generateMigrationPreview(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        migrateLikedSongs: true,
      });

      expect(preview.includesLikedSongs).toBe(true);
      expect(preview.totalItems).toBe(2);
      expect(preview.exactMatchesCount).toBe(1);
      expect(preview.unmatchedCount).toBe(1);

      const summary = preview.likedSongsSummary;
      expect(summary).toBeDefined();
      expect(summary?.total).toBe(2);
      expect(summary?.matched).toBe(1);
      expect(summary?.unmatched).toBe(1);

      // Verify explicit semantic distinction
      expect(summary?.destinationSemantic).toContain("Apple Music Cloud Library");
      expect(summary?.requiredScope).toContain("MusicKit Music-User-Token");
      expect(summary?.warningNote).toContain("distinct from track ratings");

      // Verify clear report for untransferable items
      expect(summary?.untransferableItems.length).toBe(1);
      expect(summary?.untransferableItems[0]!.title).toBe("Indie Acoustic Jam (Live at Local Cafe)");
      expect(summary?.untransferableItems[0]!.reason).toBe(
        "No matched catalog track found on destination provider"
      );
    });

    it("previews Spotify target semantics when migrating to Spotify", async () => {
      const preview = await generateMigrationPreview(testUserId, {
        sourceProvider: ProviderType.APPLE_MUSIC,
        destinationProvider: ProviderType.SPOTIFY,
        migrateLikedSongs: true,
      });

      const summary = preview.likedSongsSummary;
      expect(summary?.destinationSemantic).toContain("Spotify 'Liked Songs' collection");
      expect(summary?.requiredScope).toBe("user-library-modify");
    });
  });

  describe("Liked Songs Execution & Deduplication", () => {
    it("requires explicit user confirmation before executing bulk liked songs writes", async () => {
      await expect(
        createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          migrateLikedSongs: true,
          confirmed: false,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("migrates liked songs to Apple Music Cloud Library with deduplication and accurate accounting", async () => {
      const saveAppleSpy = vi
        .spyOn(appleWriter, "saveTracksToAppleLibrary")
        .mockResolvedValue({ savedCount: 1, acceptedCount: 1, status: "VERIFIED", failedIds: [] });

      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        migrateLikedSongs: true,
        confirmed: true,
      });

      await executeMigrationJob({
        syncJobId: job.id,
        userId: testUserId,
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [],
        migrateLikedSongs: true,
      });

      // Verify Apple Music save was called only with matched catalog ID
      expect(saveAppleSpy).toHaveBeenCalledTimes(1);
      expect(saveAppleSpy).toHaveBeenCalledWith(testUserId, ["am-song-fast-car-777"]);

      // Verify SyncJob results
      const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
      expect(updatedJob?.status).toBe(SyncJobStatus.COMPLETED);
      expect(updatedJob?.processedItems).toBe(1);
      expect(updatedJob?.failedItems).toBe(1); // 1 unmatched song omitted

      // Verify SyncOperation status & report
      const op = await prisma.syncOperation.findFirst({
        where: { syncJobId: job.id, itemType: "LIKED_SONGS" },
      });
      expect(op?.status).toBe(SyncOperationStatus.WARNING); // 1 success, 1 untransferable
      expect(op?.errorMessage).toContain("1 items had no destination catalog match");
    });

    it("migrates liked songs to Spotify Liked Songs with deduplication", async () => {
      const saveSpotifySpy = vi
        .spyOn(spotifyWriter, "saveTracksToUserLibrary")
        .mockResolvedValue({ savedCount: 1, failedIds: [] });

      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.APPLE_MUSIC,
        destinationProvider: ProviderType.SPOTIFY,
        migrateLikedSongs: true,
        confirmed: true,
      });

      await executeMigrationJob({
        syncJobId: job.id,
        userId: testUserId,
        sourceProvider: ProviderType.APPLE_MUSIC,
        destinationProvider: ProviderType.SPOTIFY,
        playlistIds: [],
        migrateLikedSongs: true,
      });

      expect(saveSpotifySpy).toHaveBeenCalledWith(testUserId, ["sp-song-fast-car-888"]);
    });

    it("safe retry: skips re-writing liked songs if operation already completed successfully", async () => {
      const saveAppleSpy = vi
        .spyOn(appleWriter, "saveTracksToAppleLibrary")
        .mockResolvedValue({ savedCount: 1, acceptedCount: 1, status: "VERIFIED", failedIds: [] });

      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        migrateLikedSongs: true,
        confirmed: true,
      });

      // Manually mark the LIKED_SONGS operation as SUCCESS to simulate retry of completed stage
      await prisma.syncOperation.updateMany({
        where: { syncJobId: job.id, itemType: "LIKED_SONGS" },
        data: { status: SyncOperationStatus.SUCCESS },
      });

      await executeMigrationJob({
        syncJobId: job.id,
        userId: testUserId,
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [],
        migrateLikedSongs: true,
      });

      // Spy should NOT have been called on retry
      expect(saveAppleSpy).not.toHaveBeenCalled();
    });
  });
});