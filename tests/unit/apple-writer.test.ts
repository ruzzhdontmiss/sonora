import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLibraryPlaylist,
  addTracksToLibraryPlaylist,
  saveTracksToAppleLibrary,
  verifyLibraryPlaylist,
  getLibraryPlaylistTrackIds,
  verifyAppleLibrarySongs,
} from "@/modules/providers/apple/apple-writer.service";
import { ProviderError } from "@/modules/providers/errors";

describe("Apple Music Write Adapter (P4-T05)", () => {
  const userId = "test-user-apple-writer";
  const mockTokens = {
    developerToken: "mock-developer-jwt",
    musicUserToken: "mock-mut-token",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Library Playlist Creation", () => {
    it("creates an Apple Music library playlist and extracts ID", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          data: [
            {
              id: "p.apple-pl-999",
              type: "library-playlists",
              href: "/v1/me/library/playlists/p.apple-pl-999",
            },
          ],
        }),
      } as any);

      const res = await createLibraryPlaylist(userId, "Indie Gems", "Migrated via Sonora", mockTokens);
      expect(res.externalId).toBe("p.apple-pl-999");
      expect(res.href).toBe("/v1/me/library/playlists/p.apple-pl-999");
    });

    it("throws ProviderError if response data has no playlist ID", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ data: [] }),
      } as any);

      await expect(createLibraryPlaylist(userId, "Faulty", undefined, mockTokens)).rejects.toThrow(ProviderError);
    });
  });

  describe("Batch Track Addition", () => {
    it("batches track insertion in chunks of <= 100", async () => {
      const trackIds = Array.from({ length: 120 }, (_, i) => `song_${i}`);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 204,
      } as any);

      const res = await addTracksToLibraryPlaylist(userId, "p.apple-pl-999", trackIds, mockTokens);

      // Sliced into 2 calls: 100 and 20
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(res.addedCount).toBe(120);
      expect(res.failedIds).toHaveLength(0);
    });
  });

  describe("Library Song Addition", () => {
    it("batches saved song additions in chunks of <= 25", async () => {
      const songIds = Array.from({ length: 30 }, (_, i) => `id_${i}`);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 202,
      } as any);

      const res = await saveTracksToAppleLibrary(userId, songIds, mockTokens);

      // Sliced into 2 calls: 25 and 5
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(res.savedCount).toBe(30);
      expect(res.failedIds).toHaveLength(0);
    });
  });

  describe("Read-back Verification", () => {
    it("verifies library playlist count matches expected count", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: Array.from({ length: 15 }, (_, i) => ({ id: `track_${i}` })),
        }),
      } as any);

      const res = await verifyLibraryPlaylist(userId, "p.apple-pl-999", 15, mockTokens);
      expect(res.verified).toBe(true);
      expect(res.actualCount).toBe(15);
    });
  });

  describe("Playlist Item Order & Duplicate Reading", () => {
    it("reads all ordered track IDs handling pagination and preserving duplicate occurrences", async () => {
      // First page with 2 tracks (A, B) and next link
      // Second page with 2 tracks (A duplicate, C)
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "i.apple-1", attributes: { playParams: { catalogId: "am-catalog-A" } } },
              { id: "i.apple-2", attributes: { playParams: { catalogId: "am-catalog-B" } } },
            ],
            next: "/v1/me/library/playlists/p.apple-pl-999/tracks?offset=2",
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "i.apple-3", attributes: { playParams: { catalogId: "am-catalog-A" } } }, // Duplicate A preserved!
              { id: "i.apple-4", attributes: { playParams: { catalogId: "am-catalog-C" } } },
            ],
            next: null,
          }),
        } as any);

      const items = await getLibraryPlaylistTrackIds(userId, "p.apple-pl-999", mockTokens);
      expect(items).toEqual(["am-catalog-A", "am-catalog-B", "am-catalog-A", "am-catalog-C"]);
    });
  });

  describe("Apple Music 202 Accepted & Cloud Library Pending-State Semantics", () => {
    it("handles delayed visibility: attempt 1 returns 0 visible, attempt 2 confirms all tracks", async () => {
      const songIds = ["am-song-1", "am-song-2"];

      // Attempt 1: Cloud library returns empty (items still propagating)
      // Attempt 2: Cloud library returns both items
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "i.1", attributes: { playParams: { catalogId: "am-song-1" } } },
              { id: "i.2", attributes: { playParams: { catalogId: "am-song-2" } } },
            ],
          }),
        } as any);

      const res = await verifyAppleLibrarySongs(userId, songIds, {
        maxAttempts: 2,
        initialDelayMs: 10,
        explicitTokens: mockTokens,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(res.verified).toBe(true);
      expect(res.status).toBe("VERIFIED");
      expect(res.verifiedCount).toBe(2);
      expect(res.pendingCount).toBe(0);
    });

    it("handles permanent non-visibility / polling timeout: returns ACCEPTED_PENDING without duplicate writes", async () => {
      const songIds = ["am-slow-propagating-1", "am-slow-propagating-2"];

      // Both attempts return empty data
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as any);

      const res = await verifyAppleLibrarySongs(userId, songIds, {
        maxAttempts: 2,
        initialDelayMs: 10,
        explicitTokens: mockTokens,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // All fetch calls are GET requests (verifications only; NEVER duplicates writes!)
      for (const call of fetchSpy.mock.calls) {
        const init = call[1] as RequestInit | undefined;
        expect(init?.method).toBe("GET");
      }

      // Explicitly marks as ACCEPTED_PENDING, NOT verified or completed
      expect(res.verified).toBe(false);
      expect(res.status).toBe("ACCEPTED_PENDING");
      expect(res.verifiedCount).toBe(0);
      expect(res.pendingCount).toBe(2);
    });
  });
});
