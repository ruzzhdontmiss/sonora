import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  SpotifyImporterService,
  normalizeSpotifyTrack,
  normalizeSpotifyPlaylist,
  spotifyFetch,
} from "@/modules/providers/spotify/spotify-importer.service";
import {
  ProviderRateLimitError,
  ProviderAuthenticationError,
} from "@/modules/providers/errors";
import { encryptToken } from "@/lib/encryption";
import {
  ProviderType,
  ProviderAccountStatus,
  SyncJobType,
  SyncJobStatus,
  SyncOperationAction,
  SyncOperationStatus,
} from "@prisma/client";

describe("Spotify Read-Only Importer (Unit & Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000020";
  const testAccountId = "aa000000-0000-0000-0000-000000000020";

  beforeEach(async () => {
    process.env.SPOTIFY_CLIENT_ID = "mock-id";
    process.env.SPOTIFY_CLIENT_SECRET = "mock-secret";

    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { userId: testUserId } } });
    await prisma.providerPlaylist.deleteMany({ where: { userId: testUserId } });
    await prisma.playlist.deleteMany({ where: { userId: testUserId } });
    await prisma.libraryTrack.deleteMany({ where: { library: { userId: testUserId } } });
    await prisma.providerTrack.deleteMany({ where: { providerAccountId: testAccountId } });
    await prisma.providerLibraryItem.deleteMany({ where: { providerAccountId: testAccountId } });
    await prisma.providerAccount.deleteMany({ where: { id: testAccountId } });
    await prisma.library.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });

    await prisma.user.create({
      data: {
        id: testUserId,
        email: "spotify-import-test@example.com",
        displayName: "Importer Tester",
      },
    });

    await prisma.providerAccount.create({
      data: {
        id: testAccountId,
        userId: testUserId,
        provider: ProviderType.SPOTIFY,
        providerUserId: "spotify-importer-acc",
        displayName: "Import Account",
        encryptedAccessToken: encryptToken("valid-access-token"),
        encryptedRefreshToken: encryptToken("valid-refresh-token"),
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hr future
        status: ProviderAccountStatus.CONNECTED,
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { userId: testUserId } } });
    await prisma.providerPlaylist.deleteMany({ where: { userId: testUserId } });
    await prisma.playlist.deleteMany({ where: { userId: testUserId } });
    await prisma.libraryTrack.deleteMany({ where: { library: { userId: testUserId } } });
    await prisma.providerTrack.deleteMany({ where: { providerAccountId: testAccountId } });
    await prisma.providerLibraryItem.deleteMany({ where: { providerAccountId: testAccountId } });
    await prisma.providerAccount.deleteMany({ where: { id: testAccountId } });
    await prisma.library.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
  });

  describe("Metadata Normalization", () => {
    it("normalizes a raw Spotify track preserving ISRC, artists, duration and numbers", () => {
      const rawTrack = {
        id: "spotify-track-1",
        name: "Clair de Lune",
        duration_ms: 302000,
        explicit: false,
        disc_number: 1,
        track_number: 3,
        is_local: false,
        uri: "spotify:track:spotify-track-1",
        external_ids: { isrc: "  fr0123456789  " },
        artists: [{ id: "art-1", name: "Claude Debussy" }, { id: "art-2", name: "Alexis Weissenberg" }],
        album: { id: "alb-1", name: "Suite Bergamasque", release_date: "1985-05-01" },
      };

      const normalized = normalizeSpotifyTrack(rawTrack);
      expect(normalized).not.toBeNull();
      expect(normalized?.externalId).toBe("spotify-track-1");
      expect(normalized?.isrc).toBe("FR0123456789");
      expect(normalized?.title).toBe("Clair de Lune");
      expect(normalized?.artistName).toBe("Claude Debussy, Alexis Weissenberg");
      expect(normalized?.albumName).toBe("Suite Bergamasque");
      expect(normalized?.durationMs).toBe(302000);
      expect(normalized?.discNumber).toBe(1);
      expect(normalized?.trackNumber).toBe(3);
    });

    it("returns null for local or null tracks to prevent corrupted library records", () => {
      expect(normalizeSpotifyTrack(null)).toBeNull();
      expect(normalizeSpotifyTrack({ id: "loc-1", name: "Local Song", duration_ms: 120000, is_local: true })).toBeNull();
    });

    it("normalizes a raw Spotify playlist", () => {
      const rawPlaylist = {
        id: "spotify-pl-100",
        name: "Late Night Jazz",
        description: "Smooth evening tunes",
        public: true,
        snapshot_id: "snap-abc-123",
        tracks: { total: 42, href: "..." },
        owner: { id: "spotify-user-1" },
      };

      const normalized = normalizeSpotifyPlaylist(rawPlaylist);
      expect(normalized.externalId).toBe("spotify-pl-100");
      expect(normalized.title).toBe("Late Night Jazz");
      expect(normalized.description).toBe("Smooth evening tunes");
      expect(normalized.isPublic).toBe(true);
      expect(normalized.itemCount).toBe(42);
      expect(normalized.snapshotId).toBe("snap-abc-123");
    });
  });

  describe("Rate Limiting & Retry-After Compliance", () => {
    it("respects HTTP 429 Retry-After header and retries successfully", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            status: 429,
            ok: false,
            headers: new Headers({ "Retry-After": "1" }),
          });
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ success: true }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await spotifyFetch<{ success: boolean }>(
        "https://api.spotify.com/v1/test",
        "mock-token"
      );

      expect(callCount).toBe(2);
      expect(result.success).toBe(true);
    });

    it("throws ProviderRateLimitError when retries are exhausted", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          status: 429,
          ok: false,
          headers: new Headers({ "Retry-After": "1" }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        spotifyFetch("https://api.spotify.com/v1/test", "mock-token")
      ).rejects.toThrow(ProviderRateLimitError);
    });
  });

  describe("End-to-End Import Execution & Checkpointing", () => {
    it("imports liked tracks and playlists, preserving playlist order and duplicate occurrences idempotently", async () => {
      const importer = new SpotifyImporterService();

      // Create a SyncJob in database to track execution
      const syncJob = await prisma.syncJob.create({
        data: {
          userId: testUserId,
          jobType: SyncJobType.IMPORT,
          sourceProvider: "SPOTIFY",
          targetProvider: "SONORA",
          status: SyncJobStatus.RUNNING,
        },
      });

      // Mock Spotify API pages:
      // Liked tracks: 2 tracks
      // Playlists: 1 playlist with 3 tracks, where track #1 appears TWICE (at pos 0 and pos 2)
      const mockLikedPage = {
        items: [
          {
            added_at: "2026-01-01T00:00:00Z",
            track: {
              id: "sp-liked-1",
              name: "Liked Track One",
              duration_ms: 210000,
              external_ids: { isrc: "USAAA0000001" },
              artists: [{ id: "art-1", name: "Artist One" }],
              album: { id: "alb-1", name: "Album One" },
            },
          },
          {
            added_at: "2026-01-02T00:00:00Z",
            track: {
              id: "sp-liked-2",
              name: "Liked Track Two",
              duration_ms: 180000,
              external_ids: { isrc: "USAAA0000002" },
              artists: [{ id: "art-2", name: "Artist Two" }],
              album: { id: "alb-2", name: "Album Two" },
            },
          },
        ],
        total: 2,
        limit: 50,
        offset: 0,
        next: null,
      };

      const mockPlaylistsPage = {
        items: [
          {
            id: "sp-playlist-1",
            name: "My Favorite Playlist",
            description: "A great playlist",
            public: true,
            snapshot_id: "snap-1",
            tracks: { total: 3, href: "..." },
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        next: null,
      };

      const mockPlaylistTracksPage = {
        items: [
          {
            added_at: "2026-02-01T00:00:00Z",
            track: {
              id: "sp-pl-track-A",
              name: "Song Alpha",
              duration_ms: 240000,
              external_ids: { isrc: "USAAA0000003" },
              artists: [{ id: "art-3", name: "Artist Three" }],
            },
          },
          {
            added_at: "2026-02-02T00:00:00Z",
            track: {
              id: "sp-pl-track-B",
              name: "Song Beta",
              duration_ms: 195000,
              external_ids: { isrc: "USAAA0000004" },
              artists: [{ id: "art-4", name: "Artist Four" }],
            },
          },
          {
            added_at: "2026-02-03T00:00:00Z",
            // DUPLICATE OCCURRENCE: Same track Song Alpha repeated at position 2!
            track: {
              id: "sp-pl-track-A",
              name: "Song Alpha",
              duration_ms: 240000,
              external_ids: { isrc: "USAAA0000003" },
              artists: [{ id: "art-3", name: "Artist Three" }],
            },
          },
        ],
        total: 3,
        limit: 100,
        offset: 0,
        next: null,
      };

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/me/tracks")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockLikedPage });
        }
        if (url.includes("/me/playlists")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockPlaylistsPage });
        }
        if (url.includes("/playlists/sp-playlist-1/items")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockPlaylistTracksPage });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await importer.importLibrary({
        userId: testUserId,
        providerAccountId: testAccountId,
        syncJobId: syncJob.id,
      });

      // Assert modern GET /v1/playlists/{id}/items is called, deprecated /tracks is never called
      const calledUrls = mockFetch.mock.calls.map((c: any) => c[0] as string);
      expect(calledUrls.some((u: string) => u.includes("/playlists/sp-playlist-1/items"))).toBe(true);
      expect(calledUrls.some((u: string) => u.includes("/playlists/sp-playlist-1/tracks"))).toBe(false);

      expect(result.likedTracksImported).toBe(2);
      expect(result.playlistsImported).toBe(1);
      expect(result.playlistItemsImported).toBe(3);
      expect(result.totalFailed).toBe(0);

      // Verify canonical library tracks
      const userLibrary = await prisma.library.findUnique({ where: { userId: testUserId } });
      const libraryTracks = await prisma.libraryTrack.findMany({
        where: { libraryId: userLibrary!.id },
        include: { track: true },
      });
      expect(libraryTracks.length).toBe(2);

      // Verify playlist items: exactly 3 items, with positions 0, 1, 2!
      const playlist = await prisma.playlist.findFirst({
        where: { userId: testUserId },
        include: {
          items: {
            orderBy: { position: "asc" },
            include: { track: true },
          },
        },
      });

      expect(playlist).not.toBeNull();
      expect(playlist?.title).toBe("My Favorite Playlist");
      expect(playlist?.items.length).toBe(3);

      expect(playlist?.items[0].position).toBe(0);
      expect(playlist?.items[0].track.title).toBe("Song Alpha");

      expect(playlist?.items[1].position).toBe(1);
      expect(playlist?.items[1].track.title).toBe("Song Beta");

      // Repeated track at position 2 preserved!
      expect(playlist?.items[2].position).toBe(2);
      expect(playlist?.items[2].track.title).toBe("Song Alpha");
      expect(playlist?.items[2].trackId).toBe(playlist?.items[0].trackId);

      // Verify SyncJob status and checkpoint
      const updatedJob = await prisma.syncJob.findUnique({ where: { id: syncJob.id } });
      expect(updatedJob?.processedItems).toBe(6); // 2 liked tracks + 1 playlist + 3 playlist items
      expect(updatedJob?.checkpoint).toBeDefined();

      // Idempotency: re-running the import MUST not duplicate canonical records
      const secondResult = await importer.importLibrary({
        userId: testUserId,
        providerAccountId: testAccountId,
        syncJobId: syncJob.id,
      });

      expect(secondResult.totalFailed).toBe(0);

      // Total canonical library tracks must still be 2
      const libraryTracksAfter = await prisma.libraryTrack.findMany({
        where: { libraryId: userLibrary!.id },
      });
      expect(libraryTracksAfter.length).toBe(2);

      // Total playlist items must still be 3
      const playlistItemsAfter = await prisma.playlistItem.findMany({
        where: { playlistId: playlist!.id },
      });
      expect(playlistItemsAfter.length).toBe(3);
    });
  });
});
