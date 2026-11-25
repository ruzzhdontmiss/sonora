import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  YouTubeImporterService,
  normalizeYouTubeTrack,
  normalizeYouTubePlaylist,
  youTubeFetch,
} from "@/modules/providers/youtube/youtube-importer.service";
import {
  ProviderQuotaExhaustedError,
  ProviderRateLimitError,
} from "@/modules/providers/errors";
import { prisma } from "@/lib/db";

// Ensure env variables for tests
process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long-123456";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/sonora_dev";
process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "redis://localhost:6379";

describe("YouTube Read-Only Importer (P5-T04)", () => {
  let importer: YouTubeImporterService;

  beforeEach(() => {
    vi.restoreAllMocks();
    importer = new YouTubeImporterService();
  });

  describe("Metadata Normalization", () => {
    it("normalizes a valid YouTube music video into canonical track representation", () => {
      const raw = {
        id: "vid-valid-1",
        snippet: {
          title: "Dua Lipa - Levitating (Official Music Video)",
          channelTitle: "Dua Lipa",
          description: "ISRC: GBAHT1901299\nWarner Records",
          categoryId: "10",
        },
        contentDetails: {
          duration: "PT3M23S",
        },
        status: {
          privacyStatus: "public",
        },
      };

      const track = normalizeYouTubeTrack(raw);
      expect(track).not.toBeNull();
      expect(track?.externalId).toBe("vid-valid-1");
      expect(track?.title).toBe("Levitating");
      expect(track?.artistName).toBe("Dua Lipa");
      expect(track?.isrc).toBe("GBAHT1901299");
      expect(track?.durationMs).toBe(203000);
      expect(track?.uri).toBe("https://www.youtube.com/watch?v=vid-valid-1");
    });

    it("returns null for deleted, private, or unavailable videos", () => {
      const deleted = {
        id: "vid-deleted",
        snippet: { title: "Deleted video" },
        status: { privacyStatus: "public" },
      };
      expect(normalizeYouTubeTrack(deleted)).toBeNull();

      const privateVid = {
        id: "vid-private",
        snippet: { title: "Private video" },
        status: { privacyStatus: "private" },
      };
      expect(normalizeYouTubeTrack(privateVid)).toBeNull();

      const hiddenVid = {
        id: "vid-hidden",
        snippet: { title: "Some Title" },
        status: { privacyStatus: "private" },
      };
      expect(normalizeYouTubeTrack(hiddenVid)).toBeNull();
    });

    it("normalizes a raw playlist into canonical playlist representation", () => {
      const rawPlaylist = {
        id: "pl-123",
        snippet: {
          title: "Road Trip Anthems",
          description: "Songs for the open road",
          channelId: "chan-1",
        },
        contentDetails: {
          itemCount: 42,
        },
        status: {
          privacyStatus: "public",
        },
      };

      const playlist = normalizeYouTubePlaylist(rawPlaylist);
      expect(playlist.externalId).toBe("pl-123");
      expect(playlist.title).toBe("Road Trip Anthems");
      expect(playlist.description).toBe("Songs for the open road");
      expect(playlist.itemCount).toBe(42);
      expect(playlist.isPublic).toBe(true);
    });
  });

  describe("API Fetch and Error Handling", () => {
    it("throws ProviderQuotaExhaustedError on HTTP 403 quotaExceeded", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        status: 403,
        ok: false,
        text: async () => JSON.stringify({
          error: {
            errors: [{ domain: "youtube.quota", reason: "quotaExceeded", message: "Quota exceeded" }],
          },
        }),
      });

      await expect(
        youTubeFetch("https://example.com/api", "mock-token")
      ).rejects.toThrow(ProviderQuotaExhaustedError);
    });

    it("retries on HTTP 429 with Retry-After header and fails with ProviderRateLimitError if exhausted", async () => {
      vi.useFakeTimers();
      global.fetch = vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        headers: new Headers({ "Retry-After": "1" }),
        text: async () => "Rate limit exceeded",
      });

      const assertion = expect(
        youTubeFetch("https://example.com/api", "mock-token")
      ).rejects.toThrow(ProviderRateLimitError);

      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
      vi.useRealTimers();
    });
  });

  describe("Liked Music and Channel Fallback Discovery", () => {
    it("discovers likes playlist from channels.list relatedPlaylists.likes", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: "channel-1",
              contentDetails: {
                relatedPlaylists: {
                  likes: "LL_USER_LIKES_PLAYLIST_ID",
                },
              },
            },
          ],
        }),
      });

      const playlistId = await importer.discoverLikedPlaylistId("mock-token");
      expect(playlistId).toBe("LL_USER_LIKES_PLAYLIST_ID");
    });

    it("fetches liked videos with categoryId filtering and pagination", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          nextPageToken: "next-token-liked",
          pageInfo: { totalResults: 2, resultsPerPage: 2 },
          items: [
            {
              id: "music-vid-1",
              snippet: {
                title: "Dua Lipa - Levitating",
                categoryId: "10", // Music
              },
              contentDetails: { duration: "PT3M23S" },
              status: { privacyStatus: "public" },
            },
            {
              id: "gaming-vid-2",
              snippet: {
                title: "Minecraft Let's Play Part 1",
                categoryId: "20", // Gaming (Non-music)
              },
              contentDetails: { duration: "PT15M00S" },
              status: { privacyStatus: "public" },
            },
          ],
        }),
      });

      const response = await importer.fetchLikedVideosPage("mock-token", null, 50);
      expect(response.items).toHaveLength(2);
      expect(response.nextPageToken).toBe("next-token-liked");
      expect((response.items[0]["snippet"] as Record<string, unknown>)?.categoryId).toBe("10");
    });
  });

  describe("Playlist & Playlist Items Fetching", () => {
    it("fetches user playlists with mine=true", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          nextPageToken: null,
          pageInfo: { totalResults: 1, resultsPerPage: 50 },
          items: [
            {
              id: "pl-favs",
              snippet: { title: "Favorites" },
              contentDetails: { itemCount: 10 },
              status: { privacyStatus: "public" },
            },
          ],
        }),
      });

      const response = await importer.fetchPlaylistsPage("mock-token");
      expect(response.items).toHaveLength(1);
      expect(response.items[0]["id"]).toBe("pl-favs");
    });

    it("batch fetches video details for playlist items", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              id: "v1",
              snippet: { title: "Song 1", categoryId: "10" },
              contentDetails: { duration: "PT3M00S" },
            },
            {
              id: "v2",
              snippet: { title: "Song 2", categoryId: "10" },
              contentDetails: { duration: "PT4M00S" },
            },
          ],
        }),
      });

      const map = await importer.batchFetchVideos("mock-token", ["v1", "v2"]);
      expect(map.size).toBe(2);
      expect((map.get("v1")?.["snippet"] as Record<string, unknown>)?.title).toBe("Song 1");
      expect((map.get("v2")?.["snippet"] as Record<string, unknown>)?.title).toBe("Song 2");
    });
  });
});
