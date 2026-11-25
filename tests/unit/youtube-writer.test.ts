import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDestinationPlaylist,
  addTracksToDestinationPlaylist,
  getDestinationPlaylistVideoIds,
  dualReadDestinationPlaylistVideoIds,
  verifyDestinationPlaylist,
  saveTracksToUserLibrary,
} from "@/modules/providers/youtube/youtube-writer.service";
import {
  ProviderQuotaExhaustedError,
  ProviderError,
} from "@/modules/providers/errors";

// Set environment for tests
process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long-123456";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/sonora_dev";
process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "redis://localhost:6379";

describe("YouTube Destination Writer & Resilient Prefix Recovery (P5-T05)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Playlist Creation", () => {
    it("creates an empty playlist and returns externalId and url", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "PL_created_123",
          snippet: { title: "Road Trip Anthems" },
        }),
      });

      const res = await createDestinationPlaylist(
        "user-1",
        "Road Trip Anthems",
        "Migrated via Sonora",
        false,
        "mock-token"
      );

      expect(res.externalId).toBe("PL_created_123");
      expect(res.title).toBe("Road Trip Anthems");
      expect(res.url).toBe("https://www.youtube.com/playlist?list=PL_created_123");
    });

    it("throws ProviderQuotaExhaustedError if quota is exceeded during playlist creation", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          error: {
            errors: [{ domain: "youtube.quota", reason: "quotaExceeded" }],
          },
        }),
      });

      await expect(
        createDestinationPlaylist("user-1", "Playlist", undefined, false, "mock-token")
      ).rejects.toThrow(ProviderQuotaExhaustedError);
    });
  });

  describe("Sequential Track Insertion & Duplicate Preservation", () => {
    it("sequentially inserts video IDs into the playlist preserving duplicates", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      // 3 calls for 3 items
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "item1" }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "item2" }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "item3" }) });

      const videoIds = ["vidA", "vidB", "vidA"]; // intentional duplicate!
      const res = await addTracksToDestinationPlaylist(
        "user-1",
        "PL_123",
        videoIds,
        "mock-token"
      );

      expect(res.addedCount).toBe(3);
      expect(res.failedVideoIds).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("reconciles uncertain writes via dual-read recovery without duplicate re-insert", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      // First item succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: "item1" }),
      });

      // Second item suffers network/500 failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      // Dual-read safeguard fetches destination items to verify if item2 actually committed
      // Read 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { snippet: { resourceId: { videoId: "vid1" } } },
            { snippet: { resourceId: { videoId: "vid2" } } }, // vid2 DID commit!
          ],
        }),
      });
      // Read 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { snippet: { resourceId: { videoId: "vid1" } } },
            { snippet: { resourceId: { videoId: "vid2" } } },
          ],
        }),
      });

      const videoIds = ["vid1", "vid2"];
      const res = await addTracksToDestinationPlaylist(
        "user-1",
        "PL_123",
        videoIds,
        "mock-token"
      );

      expect(res.addedCount).toBe(2); // vid2 reconciled as committed via read-back!
      expect(res.failedVideoIds).toHaveLength(0);
    });
  });

  describe("Pagination and Read-back Verification", () => {
    it("completely paginates through destination playlist video IDs", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      // Page 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          nextPageToken: "page2-token",
          items: [{ snippet: { resourceId: { videoId: "v1" } } }],
        }),
      });

      // Page 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          nextPageToken: null,
          items: [{ snippet: { resourceId: { videoId: "v2" } } }],
        }),
      });

      const videoIds = await getDestinationPlaylistVideoIds("user-1", "PL_123", "mock-token");
      expect(videoIds).toEqual(["v1", "v2"]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("verifies destination playlist count correctly", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      // Dual read: read 1 & read 2
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { snippet: { resourceId: { videoId: "v1" } } },
              { snippet: { resourceId: { videoId: "v2" } } },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { snippet: { resourceId: { videoId: "v1" } } },
              { snippet: { resourceId: { videoId: "v2" } } },
            ],
          }),
        });

      const verify = await verifyDestinationPlaylist("user-1", "PL_123", 2, "mock-token");
      expect(verify.verified).toBe(true);
      expect(verify.actualCount).toBe(2);
    });
  });

  describe("Liked Videos Rating", () => {
    it("rates videos as liked with POST /videos/rate", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      global.fetch = mockFetch;

      const res = await saveTracksToUserLibrary("user-1", ["vid1", "vid2"], "mock-token");
      expect(res.savedCount).toBe(2);
      expect(res.failedIds).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
