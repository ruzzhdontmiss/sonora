import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { MatchMethod, ProviderType, TrackMatchReviewStatus } from "@prisma/client";
import {
  addTrackToLibrary,
  getLibraryTracks,
  importCanonicalTracks,
} from "@/modules/library/library.service";
import {
  createPlaylist,
  getPlaylistById,
  getUserPlaylists,
  addPlaylistItem,
  reorderPlaylistItems,
  removePlaylistItem,
  deletePlaylist,
} from "@/modules/playlists/playlists.service";
import {
  linkProviderAccount,
  getUserProviderAccounts,
  disconnectProviderAccount,
} from "@/modules/providers/provider-account.service";
import {
  findOrCreateCanonicalTrack,
  getTrackMatchesNeedingReview,
} from "@/modules/matching/track-matching.service";
import { NotFoundError, ValidationError } from "@/modules/common/errors";
import { decryptToken } from "@/lib/encryption";

describe("Phase 2 Domain Services & Invariants (Integration)", () => {
  const userAId = "aa000000-0000-0000-0000-000000000001";
  const userBId = "bb000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    await prisma.providerTrack.deleteMany({
      where: { externalId: { startsWith: "sp_race_" } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userAId, userBId] } },
    });
    await prisma.track.deleteMany({
      where: {
        OR: [
          { isrc: { startsWith: "US-TEST-" } },
          { isrc: { startsWith: "US-EAG-" } },
          { isrc: { startsWith: "US-CONTRA-" } },
          { isrc: { startsWith: "US-CONCUR-" } },
          { isrc: { startsWith: "US-RACE-" } },
          {
            title: {
              in: [
                "Starman",
                "Radio Ga Ga",
                "Concurrent Wave",
                "Midnight Express",
                "Solar Flare",
                "Seq Alpha",
                "Seq Beta",
              ],
            },
          },
        ],
      },
    });

    await prisma.user.createMany({
      data: [
        { id: userAId, email: "user-a@example.com", displayName: "User Alpha" },
        { id: userBId, email: "user-b@example.com", displayName: "User Beta" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.providerTrack.deleteMany({
      where: { externalId: { startsWith: "sp_race_" } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userAId, userBId] } },
    });
    await prisma.track.deleteMany({
      where: {
        OR: [
          { isrc: { startsWith: "US-TEST-" } },
          { isrc: { startsWith: "US-EAG-" } },
          { isrc: { startsWith: "US-CONTRA-" } },
          { isrc: { startsWith: "US-CONCUR-" } },
          { isrc: { startsWith: "US-RACE-" } },
          {
            title: {
              in: [
                "Starman",
                "Radio Ga Ga",
                "Concurrent Wave",
                "Midnight Express",
                "Solar Flare",
                "Seq Alpha",
                "Seq Beta",
              ],
            },
          },
        ],
      },
    });
    await prisma.$disconnect();
  });

  describe("Library Service & Import Idempotency", () => {
    it("adds a track to the user library with deterministic matching", async () => {
      const added = await addTrackToLibrary(userAId, {
        isrc: "US-TEST-26-00101",
        title: "Sovereign Audio",
        artistName: "The Architects",
        albumName: "Decoupled",
        durationMs: 240000,
        userNotes: "Favorite intro",
      });

      expect(added.track.title).toBe("Sovereign Audio");
      expect(added.track.isrc).toBe("US-TEST-26-00101");

      const library = await getLibraryTracks(userAId);
      expect(library.total).toBe(1);
      expect(library.items[0].track.title).toBe("Sovereign Audio");
    });

    it("idempotently batch imports canonical tracks without duplicates", async () => {
      const batch = [
        {
          isrc: "US-TEST-26-00101", // Already exists from previous test!
          title: "Sovereign Audio",
          artistName: "The Architects",
          albumName: "Decoupled",
          durationMs: 240000,
        },
        {
          isrc: "US-TEST-26-00102",
          title: "Outbox Pipeline",
          artistName: "Event Sourced",
          albumName: "Durable Messages",
          durationMs: 195000,
        },
      ];

      // First import
      const result1 = await importCanonicalTracks(userAId, batch);
      expect(result1.totalProcessed).toBe(2);
      expect(result1.existingCount).toBe(1); // One was already in library
      expect(result1.addedCount).toBe(1); // One new track added to library

      // Re-running exact same import batch
      const result2 = await importCanonicalTracks(userAId, batch);
      expect(result2.totalProcessed).toBe(2);
      expect(result2.existingCount).toBe(2);
      expect(result2.addedCount).toBe(0); // Zero duplicates created!
    });
  });

  describe("Playlist Ordering & Duplicate Preservation", () => {
    let testPlaylistId: string;
    let track1Id: string;
    let track2Id: string;

    beforeAll(async () => {
      const playlist = await createPlaylist(userAId, {
        title: "Sovereign Mix",
        description: "Testing ordering and repeats",
      });
      testPlaylistId = playlist.id;

      const t1 = await prisma.track.findFirstOrThrow({ where: { isrc: "US-TEST-26-00101" } });
      const t2 = await prisma.track.findFirstOrThrow({ where: { isrc: "US-TEST-26-00102" } });
      track1Id = t1.id;
      track2Id = t2.id;
    });

    it("preserves repeated track occurrences in playlists at distinct positions", async () => {
      // Add Track 1 at position 0
      const item0 = await addPlaylistItem(userAId, testPlaylistId, {
        trackId: track1Id,
        position: 0,
        notes: "Intro",
      });

      // Add Track 2 at position 1
      const item1 = await addPlaylistItem(userAId, testPlaylistId, {
        trackId: track2Id,
        position: 1,
      });

      // Add Track 1 AGAIN at position 2 (demonstrating repetition invariant)
      const item2 = await addPlaylistItem(userAId, testPlaylistId, {
        trackId: track1Id,
        position: 2,
        notes: "Reprise",
      });

      expect(item0.position).toBe(0);
      expect(item1.position).toBe(1);
      expect(item2.position).toBe(2);

      // Verify identical track ID for item0 and item2, but distinct playlist item IDs
      expect(item0.trackId).toBe(track1Id);
      expect(item2.trackId).toBe(track1Id);
      expect(item0.id).not.toBe(item2.id);

      const fetched = await getPlaylistById(userAId, testPlaylistId);
      expect(fetched.items.length).toBe(3);
      expect(fetched.items[0].trackId).toBe(track1Id);
      expect(fetched.items[1].trackId).toBe(track2Id);
      expect(fetched.items[2].trackId).toBe(track1Id);
    });

    it("atomically reorders playlist items without unique constraint collisions", async () => {
      const playlist = await getPlaylistById(userAId, testPlaylistId);
      const [item0, item1, item2] = playlist.items;

      // Desired new order: [item2, item0, item1]
      const reordered = await reorderPlaylistItems(userAId, testPlaylistId, [
        item2.id,
        item0.id,
        item1.id,
      ]);

      expect(reordered[0].id).toBe(item2.id);
      expect(reordered[0].position).toBe(0);
      expect(reordered[1].id).toBe(item0.id);
      expect(reordered[1].position).toBe(1);
      expect(reordered[2].id).toBe(item1.id);
      expect(reordered[2].position).toBe(2);
    });

    it("rejects reordering with duplicate item IDs, omitted items, or foreign items", async () => {
      const playlist = await getPlaylistById(userAId, testPlaylistId);
      const [item0, item1, item2] = playlist.items;

      // Duplicate item ID in submitted array
      await expect(
        reorderPlaylistItems(userAId, testPlaylistId, [item0.id, item0.id, item2.id])
      ).rejects.toThrow(ValidationError);

      // Omitted item ID (incomplete set)
      await expect(
        reorderPlaylistItems(userAId, testPlaylistId, [item0.id, item1.id])
      ).rejects.toThrow(ValidationError);

      // Foreign / non-existent item ID
      await expect(
        reorderPlaylistItems(userAId, testPlaylistId, [
          item0.id,
          item1.id,
          "00000000-0000-0000-0000-999999999999",
        ])
      ).rejects.toThrow(ValidationError);
    });

    it("safely serializes concurrent reorder operations using pessimistic row locking", async () => {
      const playlist = await getPlaylistById(userAId, testPlaylistId);
      const [item0, item1, item2] = playlist.items;

      // Two concurrent reorders with different target permutations
      const orderA = [item1.id, item2.id, item0.id];
      const orderB = [item2.id, item0.id, item1.id];

      const [resA, resB] = await Promise.all([
        reorderPlaylistItems(userAId, testPlaylistId, orderA),
        reorderPlaylistItems(userAId, testPlaylistId, orderB),
      ]);

      // Both should succeed cleanly without crashing on unique position index
      expect(resA.length).toBe(3);
      expect(resB.length).toBe(3);

      // Verify the final state in DB has clean 0, 1, 2 positions
      const finalPlaylist = await getPlaylistById(userAId, testPlaylistId);
      const positions = finalPlaylist.items.map((i) => i.position);
      expect(positions).toEqual([0, 1, 2]);
    });

    it("shifts subsequent item positions down when an item is removed", async () => {
      const playlist = await getPlaylistById(userAId, testPlaylistId);
      const itemToRemove = playlist.items[0]; // Currently at pos 0

      await removePlaylistItem(userAId, testPlaylistId, itemToRemove.id);

      const updated = await getPlaylistById(userAId, testPlaylistId);
      expect(updated.items.length).toBe(2);
      expect(updated.items[0].position).toBe(0);
      expect(updated.items[1].position).toBe(1);
    });

    it("supports soft deletion of playlists", async () => {
      await deletePlaylist(userAId, testPlaylistId, { permanent: false });

      // getPlaylistById should throw NotFoundError for soft-deleted playlist
      await expect(getPlaylistById(userAId, testPlaylistId)).rejects.toThrow(NotFoundError);

      // Direct DB check proves record remains with deletedAt set
      const dbRecord = await prisma.playlist.findUnique({
        where: { id: testPlaylistId },
      });
      expect(dbRecord?.deletedAt).not.toBeNull();
    });
  });

  describe("Cross-User Security & Resource Existence Protection", () => {
    it("strictly prevents User B from accessing or modifying User A's private playlist, throwing NotFound to avoid leaking existence", async () => {
      const playlistA = await createPlaylist(userAId, {
        title: "Private User A Playlist",
        isPublic: false,
      });

      // User B cannot view private playlist A and receives NotFound to avoid leaking existence
      await expect(getPlaylistById(userBId, playlistA.id)).rejects.toThrow(NotFoundError);

      // User B cannot add items to playlist A
      const track = await prisma.track.findFirstOrThrow();
      await expect(
        addPlaylistItem(userBId, playlistA.id, { trackId: track.id })
      ).rejects.toThrow(NotFoundError);

      // User B cannot delete playlist A
      await expect(deletePlaylist(userBId, playlistA.id)).rejects.toThrow(NotFoundError);
    });
  });

  describe("Deterministic Matching & Version Discrimination", () => {
    it("does not merge live, remix, acoustic, remastered, or explicit edits with studio recordings", async () => {
      const baseTrack = await addTrackToLibrary(userAId, {
        title: "Hotel California",
        artistName: "Eagles",
        durationMs: 390000,
        explicit: false,
      });

      // 1. Live version: MUST NOT merge into base track
      const liveTrack = await addTrackToLibrary(userAId, {
        title: "Hotel California (Live)",
        artistName: "Eagles",
        durationMs: 391000, // Duration within 2000ms
        explicit: false,
      });
      expect(liveTrack.trackId).not.toBe(baseTrack.trackId);

      // 2. Remix version: MUST NOT merge
      const remixTrack = await addTrackToLibrary(userAId, {
        title: "Hotel California (Remix)",
        artistName: "Eagles",
        durationMs: 390500,
        explicit: false,
      });
      expect(remixTrack.trackId).not.toBe(baseTrack.trackId);

      // 3. Explicit vs clean edit: MUST NOT merge
      const explicitTrack = await addTrackToLibrary(userAId, {
        title: "Hotel California",
        artistName: "Eagles",
        durationMs: 390000,
        explicit: true,
      });
      expect(explicitTrack.trackId).not.toBe(baseTrack.trackId);

      // 4. Conflicting ISRC: MUST NOT merge even if title/artist match
      const trackWithIsrc1 = await addTrackToLibrary(userAId, {
        isrc: "US-EAG-76-00001",
        title: "New Kid in Town",
        artistName: "Eagles",
        durationMs: 304000,
      });

      const trackWithIsrc2 = await addTrackToLibrary(userAId, {
        isrc: "US-EAG-76-00002", // Conflicting ISRC
        title: "New Kid in Town",
        artistName: "Eagles",
        durationMs: 304000,
      });
      expect(trackWithIsrc2.trackId).not.toBe(trackWithIsrc1.trackId);
    });

    it("detects material contradictions on matching ISRC, creates separate track, and flags for review", async () => {
      const sharedIsrc = "US-CONTRA-26-99999";

      // Track 1: David Bowie - Starman
      const track1 = await findOrCreateCanonicalTrack({
        isrc: sharedIsrc,
        title: "Starman",
        artistName: "David Bowie",
        durationMs: 256000,
      });
      expect(track1.isNew).toBe(true);
      expect(track1.isConflict).toBeUndefined();

      // Track 2: Queen - Radio Ga Ga (same ISRC erroneously submitted by provider)
      const track2 = await findOrCreateCanonicalTrack({
        isrc: sharedIsrc,
        title: "Radio Ga Ga",
        artistName: "Queen",
        durationMs: 343000,
      });

      // Must NOT be merged into Track 1!
      expect(track2.track.id).not.toBe(track1.track.id);
      expect(track2.isConflict).toBe(true);
      // The conflicted track must have isrc null to prevent corrupting the unique catalog index
      expect(track2.track.isrc).toBeNull();
    });

    it("safely handles concurrent canonical track creation with the same ISRC", async () => {
      const concurrentIsrc = "US-CONCUR-26-77777";

      // Launch two simultaneous calls creating the same track
      const [res1, res2] = await Promise.all([
        findOrCreateCanonicalTrack({
          isrc: concurrentIsrc,
          title: "Concurrent Wave",
          artistName: "Synchro",
          durationMs: 200000,
        }),
        findOrCreateCanonicalTrack({
          isrc: concurrentIsrc,
          title: "Concurrent Wave",
          artistName: "Synchro",
          durationMs: 200000,
        }),
      ]);

      // Both must succeed cleanly without throwing Prisma P2002
      expect(res1.track.id).toBe(res2.track.id);
      expect(res1.track.isrc).toBe(concurrentIsrc);
    });

    it("prevents silent merge during concurrent conflicting ISRC imports and durably persists ProviderTrack and TrackMatch review state (P0-3, P1-6)", async () => {
      const account = await linkProviderAccount(userAId, {
        provider: ProviderType.SPOTIFY,
        providerUserId: "spotify_conflict_race_user",
        displayName: "Race Test User",
        accessToken: "race_token_xyz",
      });

      const sharedRaceIsrc = "US-RACE-CONFLICT-26";

      // Concurrently import two materially different tracks claiming the SAME brand-new ISRC inside transactions
      const [importA, importB] = await Promise.all([
        addTrackToLibrary(userAId, {
          isrc: sharedRaceIsrc,
          title: "Midnight Express",
          artistName: "Artist One",
          durationMs: 210000,
          providerSource: {
            provider: ProviderType.SPOTIFY,
            externalId: "sp_race_conflict_1",
            providerAccountId: account.id,
            rawMetadata: { rawIsrc: sharedRaceIsrc, tag: "A" },
          },
        }),
        addTrackToLibrary(userAId, {
          isrc: sharedRaceIsrc,
          title: "Solar Flare",
          artistName: "Artist Two",
          durationMs: 245000,
          providerSource: {
            provider: ProviderType.SPOTIFY,
            externalId: "sp_race_conflict_2",
            providerAccountId: account.id,
            rawMetadata: { rawIsrc: sharedRaceIsrc, tag: "B" },
          },
        }),
      ]);

      // Neither import may silently map to the other song's canonical track!
      expect(importA.trackId).not.toBe(importB.trackId);
      expect(importA.track.artistName).toBe("Artist One");
      expect(importA.track.title).toBe("Midnight Express");
      expect(importB.track.artistName).toBe("Artist Two");
      expect(importB.track.title).toBe("Solar Flare");

      // Exactly one wins the unique canonical ISRC; the loser creates a separated conflict track with needsReview = true
      const conflictFlags = [
        importA.matchResolution.isConflict ?? false,
        importB.matchResolution.isConflict ?? false,
      ].sort();
      expect(conflictFlags).toEqual([false, true]);

      const winner = importA.matchResolution.isConflict ? importB : importA;
      const loser = importA.matchResolution.isConflict ? importA : importB;

      expect(winner.track.isrc).toBe(sharedRaceIsrc);
      expect(winner.track.needsReview).toBe(false);

      expect(loser.track.isrc).toBeNull();
      expect(loser.track.needsReview).toBe(true);
      expect(loser.track.conflictReason).toContain("Material contradiction");
      expect(loser.matchResolution.conflictingTrackId).toBe(winner.track.id);

      // Verify both ProviderTrack mappings & TrackMatch records are durably persisted in PostgreSQL
      const pTracks = await prisma.providerTrack.findMany({
        where: { externalId: { in: ["sp_race_conflict_1", "sp_race_conflict_2"] } },
        include: { matches: true },
      });
      expect(pTracks.length).toBe(2);
      for (const pt of pTracks) {
        expect(pt.isrc).toBe(sharedRaceIsrc); // Raw provider metadata ISRC preserved cleanly
        expect(pt.matches.length).toBe(1);
      }

      // Verify conflict review query finds the contested mapping even after simulated process restart
      const conflicts = await getTrackMatchesNeedingReview({ userId: userAId });
      const raceConflict = conflicts.find(
        (m) => m.canonicalTrackId === loser.track.id
      );
      expect(raceConflict).toBeDefined();
      expect(raceConflict?.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(raceConflict?.matchMethod).toBe(MatchMethod.MANUAL_OVERRIDE);
      expect(raceConflict?.matchConfidence).toBe(0);
      expect(raceConflict?.conflictingTrackId).toBe(winner.track.id);
      expect(raceConflict?.providerTrack.isrc).toBe(sharedRaceIsrc);
    });

    it("persists conflict ProviderTrack and TrackMatch review records during batch importCanonicalTracks (P1-6)", async () => {
      const account = await linkProviderAccount(userAId, {
        provider: ProviderType.YOUTUBE_MUSIC,
        providerUserId: "yt_conflict_seq_user",
        displayName: "Batch Conflict User",
        accessToken: "yt_token_xyz",
      });

      const sharedBatchIsrc = "US-RACE-BATCH-99";
      const batchResult = await importCanonicalTracks(userAId, [
        {
          isrc: sharedBatchIsrc,
          title: "Seq Alpha",
          artistName: "Band X",
          durationMs: 180000,
          providerSource: {
            provider: ProviderType.YOUTUBE_MUSIC,
            externalId: "sp_race_seq_1",
            providerAccountId: account.id,
          },
        },
        {
          isrc: sharedBatchIsrc,
          title: "Seq Beta",
          artistName: "Band Y",
          durationMs: 260000,
          providerSource: {
            provider: ProviderType.YOUTUBE_MUSIC,
            externalId: "sp_race_seq_2",
            providerAccountId: account.id,
          },
        },
      ]);

      expect(batchResult.totalProcessed).toBe(2);
      expect(batchResult.addedCount).toBe(2);
      expect(batchResult.conflictCount).toBe(1);

      const conflicts = await getTrackMatchesNeedingReview({ userId: userAId });
      const seqConflict = conflicts.find(
        (m) => m.providerTrack.externalId === "sp_race_seq_2"
      );
      expect(seqConflict).toBeDefined();
      expect(seqConflict?.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(seqConflict?.canonicalTrack.artistName).toBe("Band Y");
      expect(seqConflict?.canonicalTrack.isrc).toBeNull();
      expect(seqConflict?.canonicalTrack.needsReview).toBe(true);
    });
  });

  describe("Pagination Bounding & Defensive Constraints", () => {
    it("validates and bounds page and limit parameters on getUserPlaylists", async () => {
      // page < 1
      await expect(getUserPlaylists(userAId, { page: 0 })).rejects.toThrow(ValidationError);
      await expect(getUserPlaylists(userAId, { page: -1 })).rejects.toThrow(ValidationError);

      // page > 10,000
      await expect(getUserPlaylists(userAId, { page: 10001 })).rejects.toThrow(ValidationError);

      // limit < 1
      await expect(getUserPlaylists(userAId, { limit: 0 })).rejects.toThrow(ValidationError);

      // limit > 100
      await expect(getUserPlaylists(userAId, { limit: 101 })).rejects.toThrow(ValidationError);
    });

    it("validates and bounds page and limit parameters on getLibraryTracks", async () => {
      // page < 1
      await expect(getLibraryTracks(userAId, { page: 0 })).rejects.toThrow(ValidationError);

      // page > 10,000
      await expect(getLibraryTracks(userAId, { page: 10001 })).rejects.toThrow(ValidationError);

      // limit < 1
      await expect(getLibraryTracks(userAId, { limit: 0 })).rejects.toThrow(ValidationError);

      // limit > 100
      await expect(getLibraryTracks(userAId, { limit: 150 })).rejects.toThrow(ValidationError);
    });
  });

  describe("Provider Account Security & Non-Destructive Disconnect", () => {
    it("encrypts OAuth tokens at rest and redacts them from service outputs", async () => {
      const rawToken = "super_secret_spotify_oauth_token_xyz_12345";
      const rawRefreshToken = "super_secret_refresh_token_abc_67890";

      const linked = await linkProviderAccount(userAId, {
        provider: ProviderType.SPOTIFY,
        providerUserId: "spotify_user_alpha",
        displayName: "Spotify Alpha",
        accessToken: rawToken,
        refreshToken: rawRefreshToken,
        scopes: ["user-library-read", "playlist-read-private"],
      });

      // Service output must never expose token fields
      expect((linked as any).accessToken).toBeUndefined();
      expect((linked as any).encryptedAccessToken).toBeUndefined();
      expect(linked.providerUserId).toBe("spotify_user_alpha");

      // Verify database contains encrypted ciphertext, NOT plaintext
      const rawDbRow = await prisma.providerAccount.findUniqueOrThrow({
        where: { id: linked.id },
      });
      expect(rawDbRow.encryptedAccessToken).not.toBe(rawToken);
      expect(rawDbRow.encryptedAccessToken.startsWith("v1:")).toBe(true);

      // Decryption verifies authenticated ciphertext
      const decrypted = decryptToken(rawDbRow.encryptedAccessToken);
      expect(decrypted).toBe(rawToken);

      const decryptedRefresh = decryptToken(rawDbRow.encryptedRefreshToken!);
      expect(decryptedRefresh).toBe(rawRefreshToken);
    });

    it("disconnecting a provider account does not delete the user's canonical library or playlists", async () => {
      const accounts = await getUserProviderAccounts(userAId);
      expect(accounts.length).toBeGreaterThan(0);
      const targetAccountId = accounts[0].id;

      // Disconnect provider
      const result = await disconnectProviderAccount(userAId, targetAccountId);
      expect(result.success).toBe(true);

      // Check account status
      const updatedAccounts = await getUserProviderAccounts(userAId);
      const disconnectedAccount = updatedAccounts.find((a) => a.id === targetAccountId);
      expect(disconnectedAccount?.status).toBe("DISCONNECTED");

      // Verify canonical library remains intact!
      const userLibrary = await getLibraryTracks(userAId);
      expect(userLibrary.total).toBeGreaterThan(0);
    });
  });
});

