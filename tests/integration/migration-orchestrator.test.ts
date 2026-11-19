import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  generateMigrationPreview,
  createMigrationJob,
  executeMigrationJob,
  cancelMigrationJob,
  verifyPlaylistPrefix,
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
import { ForbiddenError, NotFoundError, ValidationError } from "@/modules/common/errors";
import * as spotifyWriter from "@/modules/providers/spotify/spotify-writer.service";
import * as appleWriter from "@/modules/providers/apple/apple-writer.service";

describe("Cross-Provider Migration Orchestration (P4-T06 Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000050";
  const spotifyAccountId = "aa000000-0000-0000-0000-000000000051";
  const appleAccountId = "aa000000-0000-0000-0000-000000000052";

  let testLibraryId: string;
  let testPlaylistId: string;
  let track1Id: string;
  let track2Id: string;
  let track3Id: string;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Clean up test data
    await prisma.outboxEvent.deleteMany({ where: { eventType: "MIGRATION_JOB_DISPATCH" } });
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { library: { userId: testUserId } } } });
    await prisma.playlist.deleteMany({ where: { library: { userId: testUserId } } });
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
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, "ee000000-0000-0000-0000-000000000059"] } } });

    // Seed test user
    await prisma.user.create({
      data: {
        id: testUserId,
        email: "migration-test@example.com",
        displayName: "Migration Tester",
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
          providerUserId: "spotify-migrator-user",
          displayName: "Tester Spotify",
          encryptedAccessToken: encryptToken("mock-spotify-token"),
          encryptedRefreshToken: encryptToken("mock-refresh-token"),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scopes: ["playlist-modify-public", "playlist-modify-private", "user-library-modify"],
          status: ProviderAccountStatus.CONNECTED,
        },
        {
          id: appleAccountId,
          userId: testUserId,
          provider: ProviderType.APPLE_MUSIC,
          providerUserId: "apple-migrator-user",
          displayName: "Tester Apple Music",
          encryptedAccessToken: encryptToken("mock-apple-user-token"),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          status: ProviderAccountStatus.CONNECTED,
        },
      ],
    });

    // Seed canonical tracks
    const t1 = await prisma.track.create({
      data: {
        title: "Billie Jean",
        artistName: "Michael Jackson",
        durationMs: 294000,
        isrc: "USPR37300012",
      },
    });
    track1Id = t1.id;

    const t2 = await prisma.track.create({
      data: {
        title: "Beat It",
        artistName: "Michael Jackson",
        durationMs: 258000,
        isrc: "USPR37300013",
      },
    });
    track2Id = t2.id;

    const t3 = await prisma.track.create({
      data: {
        title: "Thriller (Rare Demo)",
        artistName: "Michael Jackson",
        durationMs: 357000,
      },
    });
    track3Id = t3.id;

    // Seed provider tracks & matches for Apple Music destination
    const applePt1 = await prisma.providerTrack.create({
      data: {
        providerAccountId: appleAccountId,
        provider: ProviderType.APPLE_MUSIC,
        externalId: "am-track-billie-jean-123",
        title: "Billie Jean",
        artistName: "Michael Jackson",
        durationMs: 294000,
        isrc: "USPR37300012",
      },
    });

    await prisma.trackMatch.create({
      data: {
        canonicalTrackId: track1Id,
        providerTrackId: applePt1.id,
        matchConfidence: 0.99,
        matchMethod: MatchMethod.EXACT_ISRC,
        reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
      },
    });

    const applePt2 = await prisma.providerTrack.create({
      data: {
        providerAccountId: appleAccountId,
        provider: ProviderType.APPLE_MUSIC,
        externalId: "am-track-beat-it-456",
        title: "Beat It",
        artistName: "Michael Jackson",
        durationMs: 258000,
        isrc: "USPR37300013",
      },
    });

    await prisma.trackMatch.create({
      data: {
        canonicalTrackId: track2Id,
        providerTrackId: applePt2.id,
        matchConfidence: 0.88,
        matchMethod: MatchMethod.METADATA_FUZZY,
        reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
      },
    });

    // Seed a playlist with repeat track to test duplicate preservation
    const playlist = await prisma.playlist.create({
      data: {
        userId: testUserId,
        libraryId: testLibraryId,
        title: "80s Pop Classics",
        description: "Best of MJ",
      },
    });
    testPlaylistId = playlist.id;

    // Insert item 1: Billie Jean (position 0)
    await prisma.playlistItem.create({
      data: {
        playlistId: testPlaylistId,
        trackId: track1Id,
        position: 0,
      },
    });
    // Insert item 2: Beat It (position 1)
    await prisma.playlistItem.create({
      data: {
        playlistId: testPlaylistId,
        trackId: track2Id,
        position: 1,
      },
    });
    // Insert item 3: Billie Jean AGAIN (position 2 - repeated track occurrence)
    await prisma.playlistItem.create({
      data: {
        playlistId: testPlaylistId,
        trackId: track1Id,
        position: 2,
      },
    });
    // Insert item 4: Thriller Demo (position 3 - unmatched track)
    await prisma.playlistItem.create({
      data: {
        playlistId: testPlaylistId,
        trackId: track3Id,
        position: 3,
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe("generateMigrationPreview", () => {
    it("generates a preview with accurate match categories and item counts without mutating destination", async () => {
      const createAppleSpy = vi.spyOn(appleWriter, "createLibraryPlaylist");

      const preview = await generateMigrationPreview(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
      });

      expect(preview).toBeDefined();
      expect(preview.sourceProvider).toBe(ProviderType.SPOTIFY);
      expect(preview.destinationProvider).toBe(ProviderType.APPLE_MUSIC);
      expect(preview.totalItems).toBe(4); // 4 playlist items
      expect(preview.exactMatchesCount).toBe(2); // Billie Jean twice (0.99)
      expect(preview.highConfidenceCount).toBe(1); // Beat It (0.88)
      expect(preview.unmatchedCount).toBe(1); // Thriller Demo (no match)
      expect(preview.playlists.length).toBe(1);
      expect(preview.playlists[0]!.title).toBe("80s Pop Classics");
      expect(preview.playlists[0]!.trackCount).toBe(4);

      // Verify zero external side effects occurred during preview
      expect(createAppleSpy).not.toHaveBeenCalled();
    });

    it("rejects migration preview if source and destination providers are identical", async () => {
      await expect(
        generateMigrationPreview(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.SPOTIFY,
          playlistIds: [testPlaylistId],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects migration preview if account is not connected", async () => {
      const unconnectedUserId = "ee000000-0000-0000-0000-000000000059";
      await prisma.user.create({
        data: { id: unconnectedUserId, email: "unconnected-59@example.com", displayName: "No Auth" },
      });

      await expect(
        generateMigrationPreview(unconnectedUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
        })
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("createMigrationJob — Pre-flight Confirmation Gate", () => {
    it("rejects job creation if confirmed is false (strict explicit confirmation gate)", async () => {
      await expect(
        createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: false,
        })
      ).rejects.toThrow(ValidationError);

      const jobCount = await prisma.syncJob.count({ where: { userId: testUserId } });
      expect(jobCount).toBe(0);
    });

    it("creates durable SyncJob in QUEUED status and dispatches OutboxEvent when confirmed", async () => {
      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        confirmed: true,
      });

      expect(job).toBeDefined();
      expect(job.status).toBe(SyncJobStatus.QUEUED);
      expect(job.jobType).toBe(SyncJobType.EXPORT);
      expect(job.sourceProvider).toBe(ProviderType.SPOTIFY);
      expect(job.targetProvider).toBe(ProviderType.APPLE_MUSIC);
      expect(job.totalItems).toBe(4);
      expect(job.confirmedAt).not.toBeNull();

      // Verify initial SyncOperation record created
      const ops = await prisma.syncOperation.findMany({ where: { syncJobId: job.id } });
      expect(ops.length).toBe(1);
      expect(ops[0]!.itemType).toBe("PLAYLIST");
      expect(ops[0]!.sourceId).toBe(testPlaylistId);

      // Verify transactional OutboxEvent created
      const outbox = await prisma.outboxEvent.findFirst({
        where: { eventType: "MIGRATION_JOB_DISPATCH" },
      });
      expect(outbox).not.toBeNull();
      const payload = outbox?.payload as any;
      expect(payload.syncJobId).toBe(job.id);
      expect(payload.userId).toBe(testUserId);
      expect(payload.playlistIds).toContain(testPlaylistId);
    });

    it("prevents duplicate concurrent active migration jobs", async () => {
      await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        confirmed: true,
      });

      // Second attempt while first is QUEUED must fail
      await expect(
        createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("executeMigrationJob — Worker Execution & Read-back Verification", () => {
    it("executes migration: creates playlist, adds tracks preserving duplicates, calls verify, and updates counts", async () => {
      // Mock Apple Music writer calls
      vi.spyOn(appleWriter, "createLibraryPlaylist").mockResolvedValue({
        externalId: "p.test-apple-playlist-999",
        href: "/v1/me/library/playlists/p.test-apple-playlist-999",
      });

      const addTracksSpy = vi.spyOn(appleWriter, "addTracksToLibraryPlaylist").mockResolvedValue({
        addedCount: 3,
        failedIds: [],
      });

      const verifySpy = vi.spyOn(appleWriter, "verifyLibraryPlaylist").mockResolvedValue({
        verified: true,
        actualCount: 3,
        status: "VERIFIED",
      });

      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        confirmed: true,
      });

      // Execute worker
      await executeMigrationJob({
        syncJobId: job.id,
        userId: testUserId,
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        migrateLikedSongs: false,
      });

      // Verify playlist writer was invoked
      expect(appleWriter.createLibraryPlaylist).toHaveBeenCalledWith(
        testUserId,
        "80s Pop Classics",
        "Best of MJ"
      );

      // Verify order and duplicate preservation:
      // Billie Jean (am-track-billie-jean-123), Beat It (am-track-beat-it-456), Billie Jean again (am-track-billie-jean-123)
      expect(addTracksSpy).toHaveBeenCalledWith(
        testUserId,
        "p.test-apple-playlist-999",
        ["am-track-billie-jean-123", "am-track-beat-it-456", "am-track-billie-jean-123"]
      );

      // Verify read-back verification was invoked
      expect(verifySpy).toHaveBeenCalledWith(
        testUserId,
        "p.test-apple-playlist-999",
        3
      );

      // Verify SyncJob state in database
      const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
      expect(updatedJob?.status).toBe(SyncJobStatus.COMPLETED);
      expect(updatedJob?.processedItems).toBe(3);
      expect(updatedJob?.failedItems).toBe(1); // Thriller Demo was unmatched
      expect(updatedJob?.completedAt).not.toBeNull();

      // Verify SyncOperation updated to SUCCESS
      const op = await prisma.syncOperation.findFirst({
        where: { syncJobId: job.id, sourceId: testPlaylistId },
      });
      expect(op?.status).toBe(SyncOperationStatus.SUCCESS);
      expect(op?.targetId).toBe("p.test-apple-playlist-999");
    });

    it("respects cancellation before starting or during checkpoints", async () => {
      const job = await createMigrationJob(testUserId, {
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        confirmed: true,
      });

      // Cancel before worker execution
      await cancelMigrationJob(testUserId, job.id);

      const createSpy = vi.spyOn(appleWriter, "createLibraryPlaylist");

      await executeMigrationJob({
        syncJobId: job.id,
        userId: testUserId,
        sourceProvider: ProviderType.SPOTIFY,
        destinationProvider: ProviderType.APPLE_MUSIC,
        playlistIds: [testPlaylistId],
        migrateLikedSongs: false,
      });

      // Cancelled job should not perform external writes
      expect(createSpy).not.toHaveBeenCalled();

      const refreshed = await prisma.syncJob.findUnique({ where: { id: job.id } });
      expect(refreshed?.status).toBe(SyncJobStatus.CANCELLED);
    });

    describe("Safe Playlist Recovery & Prefix Verification", () => {
      it("validates prefix and preserves duplicate occurrences in exact order", () => {
        const intended = ["trackA", "trackB", "trackA", "trackC", "trackD"];
        const existing = ["trackA", "trackB", "trackA"];

        const result = verifyPlaylistPrefix(existing, intended);
        expect(result.valid).toBe(true);
        expect(result.resumableIndex).toBe(3);
        expect(result.existingCount).toBe(3);
        expect(result.intendedCount).toBe(5);
      });

      it("rejects wrong prefix when an item at index i does not match intended track", () => {
        const intended = ["trackA", "trackB", "trackC"];
        const existing = ["trackA", "foreignTrack"];

        const result = verifyPlaylistPrefix(existing, intended);
        expect(result.valid).toBe(false);
        expect(result.resumableIndex).toBe(1);
        expect(result.error).toContain("mismatch at position 1");
      });

      it("rejects reordered items in destination even if all tracks are present", () => {
        const intended = ["trackA", "trackB"];
        const existing = ["trackB", "trackA"]; // Reordered!

        const result = verifyPlaylistPrefix(existing, intended);
        expect(result.valid).toBe(false);
        expect(result.resumableIndex).toBe(0);
        expect(result.error).toContain("mismatch at position 0");
      });

      it("rejects destination containing more items than intended", () => {
        const intended = ["trackA", "trackB"];
        const existing = ["trackA", "trackB", "trackC"]; // 3 > 2

        const result = verifyPlaylistPrefix(existing, intended);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("exceeding intended total");
      });

      it("handles crash-after-provider-write: resumes from verified prefix, does not duplicate playlist or tracks", async () => {
        // Intended tracks for testPlaylistId:
        // ["am-track-billie-jean-123", "am-track-beat-it-456", "am-track-billie-jean-123"]
        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        // Simulate crash-after-write:
        // The provider already received batch 1 (first 2 items), but worker died before writing item 3.
        // SyncOperation already has targetId persisted!
        await prisma.syncOperation.updateMany({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
          data: { targetId: "p.existing-apple-playlist-555" },
        });

        // Destination playlist currently contains first 2 items in exact order
        vi.spyOn(appleWriter, "getLibraryPlaylistTrackIds").mockResolvedValue([
          "am-track-billie-jean-123",
          "am-track-beat-it-456",
        ]);

        const createPlaylistSpy = vi.spyOn(appleWriter, "createLibraryPlaylist");
        const addTracksSpy = vi.spyOn(appleWriter, "addTracksToLibraryPlaylist").mockResolvedValue({
          addedCount: 1,
          failedIds: [],
        });
        const verifySpy = vi.spyOn(appleWriter, "verifyLibraryPlaylist").mockResolvedValue({
          verified: true,
          actualCount: 3,
          status: "VERIFIED",
        });

        // Resume worker execution
        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        // 1. MUST NOT create a second destination playlist!
        expect(createPlaylistSpy).not.toHaveBeenCalled();

        // 2. MUST only append the remaining 3rd track (the duplicate Billie Jean), NOT re-append tracks 1 & 2!
        expect(addTracksSpy).toHaveBeenCalledTimes(1);
        expect(addTracksSpy).toHaveBeenCalledWith(
          testUserId,
          "p.existing-apple-playlist-555",
          ["am-track-billie-jean-123"]
        );

        // 3. Completed cleanly with all 3 items accounted for
        const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(updatedJob?.status).toBe(SyncJobStatus.COMPLETED);
        expect(updatedJob?.processedItems).toBe(3);

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.SUCCESS);
        expect(op?.targetId).toBe("p.existing-apple-playlist-555");
      });

      it("halts safely for manual reconciliation when destination prefix is mismatched or reordered", async () => {
        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        await prisma.syncOperation.updateMany({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
          data: { targetId: "p.corrupted-apple-playlist-777" },
        });

        // Destination has items reordered or corrupted:
        vi.spyOn(appleWriter, "getLibraryPlaylistTrackIds").mockResolvedValue([
          "am-track-beat-it-456", // Out of order! Should have been billie-jean
        ]);

        const addTracksSpy = vi.spyOn(appleWriter, "addTracksToLibraryPlaylist");

        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        // MUST NOT append any tracks to a mismatched destination playlist!
        expect(addTracksSpy).not.toHaveBeenCalled();

        // Must record ERROR requiring manual reconciliation
        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.ERROR);
        expect(op?.errorMessage).toContain("Recovery halted");
        expect(op?.errorMessage).toContain("mismatch at position 0");
      });

      it("halts safely for manual reconciliation when destination playlist cannot be read reliably", async () => {
        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        await prisma.syncOperation.updateMany({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
          data: { targetId: "p.unreachable-apple-playlist-888" },
        });

        // Read fails with network error
        vi.spyOn(appleWriter, "getLibraryPlaylistTrackIds").mockRejectedValue(
          new Error("Network connection dropped by peer")
        );

        const addTracksSpy = vi.spyOn(appleWriter, "addTracksToLibraryPlaylist");

        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        // MUST NOT guess or append blindly!
        expect(addTracksSpy).not.toHaveBeenCalled();

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.ERROR);
        expect(op?.errorMessage).toContain("could not be read reliably");
      });

      it("records ERROR when read-back verification reveals incomplete destination items", async () => {
        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        vi.spyOn(appleWriter, "createLibraryPlaylist").mockResolvedValue({
          externalId: "p.apple-incomplete-123",
          href: "/v1/me/library/playlists/p.apple-incomplete-123",
        });

        vi.spyOn(appleWriter, "addTracksToLibraryPlaylist").mockResolvedValue({
          addedCount: 3,
          failedIds: [],
        });

        // Destination read-back returns only 1 track instead of expected 3!
        vi.spyOn(appleWriter, "verifyLibraryPlaylist").mockResolvedValue({
          verified: false,
          actualCount: 1,
          status: "VERIFIED",
        });

        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.ERROR);
        expect(op?.errorMessage).toContain("Destination playlist verification incomplete: expected 3 tracks, but read-back verified 1 tracks");
      });

      it("records WARNING with ACCEPTED_PENDING when Apple Music read-back is pending propagation", async () => {
        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        vi.spyOn(appleWriter, "createLibraryPlaylist").mockResolvedValue({
          externalId: "p.apple-pending-456",
          href: "/v1/me/library/playlists/p.apple-pending-456",
        });

        vi.spyOn(appleWriter, "addTracksToLibraryPlaylist").mockResolvedValue({
          addedCount: 3,
          failedIds: [],
        });

        // Apple Music read-back returns ACCEPTED_PENDING due to normal propagation delay
        vi.spyOn(appleWriter, "verifyLibraryPlaylist").mockResolvedValue({
          verified: false,
          actualCount: 1,
          status: "ACCEPTED_PENDING",
        });

        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.SPOTIFY,
          destinationProvider: ProviderType.APPLE_MUSIC,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.WARNING);
        expect(op?.errorMessage).toContain("ACCEPTED_PENDING: Playlist tracks accepted by Apple Music");
      });

      it("Spotify recovery: resumes from verified prefix, does not duplicate playlist or tracks", async () => {
        // Seed Spotify matches for track1 and track2
        const spotPt1 = await prisma.providerTrack.create({
          data: {
            providerAccountId: spotifyAccountId,
            provider: ProviderType.SPOTIFY,
            externalId: "spot-billie-jean-123",
            providerUri: "spotify:track:spot-billie-jean-123",
            title: "Billie Jean",
            artistName: "Michael Jackson",
            durationMs: 294000,
          },
        });
        await prisma.trackMatch.create({
          data: {
            canonicalTrackId: track1Id,
            providerTrackId: spotPt1.id,
            matchConfidence: 0.99,
            matchMethod: MatchMethod.EXACT_ISRC,
            reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
          },
        });

        const spotPt2 = await prisma.providerTrack.create({
          data: {
            providerAccountId: spotifyAccountId,
            provider: ProviderType.SPOTIFY,
            externalId: "spot-beat-it-456",
            providerUri: "spotify:track:spot-beat-it-456",
            title: "Beat It",
            artistName: "Michael Jackson",
            durationMs: 258000,
          },
        });
        await prisma.trackMatch.create({
          data: {
            canonicalTrackId: track2Id,
            providerTrackId: spotPt2.id,
            matchConfidence: 0.99,
            matchMethod: MatchMethod.EXACT_ISRC,
            reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
          },
        });

        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.APPLE_MUSIC,
          destinationProvider: ProviderType.SPOTIFY,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        // Simulate crash-after-write:
        // Spotify playlist was created and received first 2 tracks, but worker died before writing 3rd track.
        await prisma.syncOperation.updateMany({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
          data: { targetId: "spotify-existing-pl-123" },
        });

        // getDestinationPlaylistTrackUris returns first 2 items
        vi.spyOn(spotifyWriter, "getDestinationPlaylistTrackUris").mockResolvedValue([
          "spotify:track:spot-billie-jean-123",
          "spotify:track:spot-beat-it-456",
        ]);

        const createPlaylistSpy = vi.spyOn(spotifyWriter, "createDestinationPlaylist");
        const addTracksSpy = vi.spyOn(spotifyWriter, "addTracksToDestinationPlaylist").mockResolvedValue({
          addedCount: 1,
          snapshotId: "snap-resume",
          failedUris: [],
        });
        vi.spyOn(spotifyWriter, "verifyDestinationPlaylist").mockResolvedValue({
          verified: true,
          actualCount: 3,
        });

        // Resume execution
        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.APPLE_MUSIC,
          destinationProvider: ProviderType.SPOTIFY,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        // 1. MUST NOT create a second Spotify playlist!
        expect(createPlaylistSpy).not.toHaveBeenCalled();

        // 2. MUST append only the remaining 3rd track (the duplicate Billie Jean)
        expect(addTracksSpy).toHaveBeenCalledTimes(1);
        expect(addTracksSpy).toHaveBeenCalledWith(
          testUserId,
          "spotify-existing-pl-123",
          ["spotify:track:spot-billie-jean-123"]
        );

        // 3. Status completed
        const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
        expect(updatedJob?.status).toBe(SyncJobStatus.COMPLETED);
        expect(updatedJob?.processedItems).toBe(3);

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.SUCCESS);
      });

      it("Spotify recovery: halts safely when Spotify destination items are reordered", async () => {
        // Seed Spotify matches
        const spotPt1 = await prisma.providerTrack.create({
          data: {
            providerAccountId: spotifyAccountId,
            provider: ProviderType.SPOTIFY,
            externalId: "spot-billie-jean-reorder",
            providerUri: "spotify:track:spot-billie-jean-reorder",
            title: "Billie Jean",
            artistName: "Michael Jackson",
            durationMs: 294000,
          },
        });
        await prisma.trackMatch.create({
          data: {
            canonicalTrackId: track1Id,
            providerTrackId: spotPt1.id,
            matchConfidence: 0.99,
            matchMethod: MatchMethod.EXACT_ISRC,
            reviewStatus: TrackMatchReviewStatus.AUTO_MATCHED,
          },
        });

        const job = await createMigrationJob(testUserId, {
          sourceProvider: ProviderType.APPLE_MUSIC,
          destinationProvider: ProviderType.SPOTIFY,
          playlistIds: [testPlaylistId],
          confirmed: true,
        });

        await prisma.syncOperation.updateMany({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
          data: { targetId: "spotify-corrupted-pl-456" },
        });

        // Destination has wrong track at position 0
        vi.spyOn(spotifyWriter, "getDestinationPlaylistTrackUris").mockResolvedValue([
          "spotify:track:different-track-xyz",
        ]);

        const addTracksSpy = vi.spyOn(spotifyWriter, "addTracksToDestinationPlaylist");

        await executeMigrationJob({
          syncJobId: job.id,
          userId: testUserId,
          sourceProvider: ProviderType.APPLE_MUSIC,
          destinationProvider: ProviderType.SPOTIFY,
          playlistIds: [testPlaylistId],
          migrateLikedSongs: false,
        });

        expect(addTracksSpy).not.toHaveBeenCalled();

        const op = await prisma.syncOperation.findFirst({
          where: { syncJobId: job.id, sourceId: testPlaylistId },
        });
        expect(op?.status).toBe(SyncOperationStatus.ERROR);
        expect(op?.errorMessage).toContain("Recovery halted");
      });
    });
  });
});