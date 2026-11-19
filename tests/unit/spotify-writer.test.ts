import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDestinationPlaylist,
  addTracksToDestinationPlaylist,
  saveTracksToUserLibrary,
  checkTracksInLibrary,
  verifyTracksInUserLibrary,
  verifyDestinationPlaylist,
  getDestinationPlaylistTrackUris,
  assertSpotifyWriteScopes,
} from "@/modules/providers/spotify/spotify-writer.service";
import * as spotifyAuth from "@/modules/providers/spotify/spotify-auth.service";
import { prisma } from "@/lib/db";
import { ProviderAuthenticationError } from "@/modules/providers/errors";

describe("Spotify Write Adapter (P4-T05)", () => {
  const userId = "test-user-spotify-writer";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Scope assertions", () => {
    it("throws ProviderAuthenticationError if user has no connected Spotify account", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValueOnce(null);

      await expect(assertSpotifyWriteScopes(userId, "playlist")).rejects.toThrow(
        ProviderAuthenticationError
      );
    });

    it("throws ProviderAuthenticationError if playlist write scopes are missing", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValueOnce({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "user-read-email user-library-read" }, // Missing playlist-modify
      } as any);

      await expect(assertSpotifyWriteScopes(userId, "playlist")).rejects.toThrow(
        ProviderAuthenticationError
      );
    });

    it("passes scope assertion when playlist-modify-private is granted", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValueOnce({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "playlist-modify-private user-library-modify" },
      } as any);

      await expect(assertSpotifyWriteScopes(userId, "playlist")).resolves.toBeUndefined();
    });
  });

  describe("Playlist Creation", () => {
    it("creates a destination playlist and returns externalId, uri, and url", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "playlist-modify-public" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: "spot-pl-123",
          uri: "spotify:playlist:spot-pl-123",
          external_urls: { spotify: "https://open.spotify.com/playlist/spot-pl-123" },
          snapshot_id: "snap-abc",
        }),
      } as any);

      const res = await createDestinationPlaylist(userId, "Rock Anthems", "Created via Sonora", false, "mock-token");
      expect(res.externalId).toBe("spot-pl-123");
      expect(res.uri).toBe("spotify:playlist:spot-pl-123");
      expect(res.snapshotId).toBe("snap-abc");
    });
  });

  describe("Batch Track Addition", () => {
    it("batches track insertion in chunks of <= 100 preserving duplicate URIs", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "playlist-modify-public" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      // Generate 150 URIs with duplicates
      const uris: string[] = [];
      for (let i = 0; i < 150; i++) {
        uris.push(`spotify:track:track_${i % 10}`); // repeats track_0 through track_9
      }

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ snapshot_id: "snap-batch" }),
      } as any);

      const res = await addTracksToDestinationPlaylist(userId, "spot-pl-123", uris, "mock-token");

      // Sliced into 2 batches (100 and 50)
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(res.addedCount).toBe(150);
      expect(res.failedUris).toHaveLength(0);

      // Verify called URL is modern POST /v1/playlists/{id}/items and NEVER deprecated /tracks
      const firstCallUrl = fetchSpy.mock.calls[0][0] as string;
      expect(firstCallUrl).toBe("https://api.spotify.com/v1/playlists/spot-pl-123/items");
      expect(firstCallUrl).not.toContain("/tracks");
    });

    it("respects Retry-After header when encountering 429 rate limit", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "playlist-modify-public" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      // First call returns 429 with Retry-After: 1
      // Second call returns 201
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          status: 429,
          ok: false,
          headers: new Headers({ "Retry-After": "1" }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({ snapshot_id: "snap-after-429" }),
        } as any);

      const res = await addTracksToDestinationPlaylist(userId, "spot-pl-123", ["spotify:track:1"], "mock-token");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(res.addedCount).toBe(1);
      expect(res.snapshotId).toBe("snap-after-429");
    });
  });

  describe("Read-back Verification", () => {
    it("verifies item count via modern GET /playlists/{id}/items (never deprecated /tracks)", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ total: 42 }),
      } as any);

      const res = await verifyDestinationPlaylist(userId, "spot-pl-123", 42, "mock-token");
      expect(res.verified).toBe(true);
      expect(res.actualCount).toBe(42);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe("https://api.spotify.com/v1/playlists/spot-pl-123/items?limit=1");
      expect(calledUrl).not.toContain("/tracks");
    });

    it("reads all ordered track URIs handling pagination and preserving duplicate occurrences", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { track: { uri: "spotify:track:track1", id: "track1" } },
              { track: { uri: "spotify:track:track2", id: "track2" } },
            ],
            next: "https://api.spotify.com/v1/playlists/spot-pl-123/items?offset=2",
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              { track: { uri: "spotify:track:track1", id: "track1" } }, // Duplicate track1 preserved!
              { track: { uri: "spotify:track:track3", id: "track3" } },
            ],
            next: null,
          }),
        } as any);

      const uris = await getDestinationPlaylistTrackUris(userId, "spot-pl-123", "mock-token");
      expect(uris).toEqual([
        "spotify:track:track1",
        "spotify:track:track2",
        "spotify:track:track1",
        "spotify:track:track3",
      ]);

      const firstCallUrl = fetchSpy.mock.calls[0][0] as string;
      expect(firstCallUrl).toContain("https://api.spotify.com/v1/playlists/spot-pl-123/items?limit=100");
      expect(firstCallUrl).not.toContain("/tracks");
    });
  });

  describe("Spotify Saved Songs / Library Migration (Official PUT /v1/me/library)", () => {
    it("checks tracks membership using GET /v1/me/library/contains?uris= with max 40 URIs", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [true, false],
      } as any);

      const flags = await checkTracksInLibrary(userId, ["track1", "spotify:track:track2"], "mock-token");
      expect(flags).toEqual([true, false]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const calledUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(calledUrl).toContain("https://api.spotify.com/v1/me/library/contains?uris=");
      expect(calledUrl).not.toContain("/v1/me/tracks");
      expect(decodeURIComponent(calledUrl)).toContain("spotify:track:track1,spotify:track:track2");
    });

    it("saves tracks to library using PUT /v1/me/library?uris= with max 40 URIs and NEVER invokes /v1/me/tracks", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "user-library-modify" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      const calledUrls: string[] = [];
      const calledMethods: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
        calledUrls.push(url.toString());
        calledMethods.push(init?.method || "GET");

        // First call: checkTracksInLibrary -> returns false for all (not yet saved)
        if (url.toString().includes("/me/library/contains")) {
          return {
            ok: true,
            status: 200,
            json: async () => [false, false],
          } as any;
        }

        // Second call: PUT /me/library?uris=...
        if (url.toString().includes("/me/library?uris=")) {
          return {
            ok: true,
            status: 200,
          } as any;
        }

        return { ok: false, status: 404 } as any;
      });

      const res = await saveTracksToUserLibrary(userId, ["trackA", "trackB"], "mock-token");
      expect(res.savedCount).toBe(2);
      expect(res.failedIds).toHaveLength(0);

      // Verify that /v1/me/tracks is NEVER called
      for (const u of calledUrls) {
        expect(u).not.toContain("/v1/me/tracks");
      }

      // Verify PUT /v1/me/library was called
      expect(calledMethods).toContain("PUT");
      const putCall = calledUrls.find((u) => u.includes("/me/library?uris="));
      expect(putCall).toBeDefined();
      expect(decodeURIComponent(putCall!)).toContain("spotify:track:trackA,spotify:track:trackB");
    });

    it("pre-checks membership and skips writing tracks already in the library", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "user-library-modify" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      let putCalled = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
        if (init?.method === "PUT") {
          putCalled = true;
          return { ok: true, status: 200 } as any;
        }
        // contains returns true for both (already saved!)
        return {
          ok: true,
          status: 200,
          json: async () => [true, true],
        } as any;
      });

      const res = await saveTracksToUserLibrary(userId, ["already-saved-1", "already-saved-2"], "mock-token");
      expect(res.savedCount).toBe(2);
      expect(putCalled).toBe(false); // PUT skipped because already in library!
    });

    it("reconciles membership check instead of blindly repeating write on uncertain network error", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "user-library-modify" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      let containsCallCount = 0;
      let putCallCount = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
        if (init?.method === "PUT") {
          putCallCount++;
          // Simulate network drop / timeout after Spotify processed it
          throw new Error("Network socket hung up");
        }

        containsCallCount++;
        if (containsCallCount === 1) {
          // Initial check: not in library
          return {
            ok: true,
            status: 200,
            json: async () => [false],
          } as any;
        } else {
          // Post-error reconciliation check: verified that it actually was saved!
          return {
            ok: true,
            status: 200,
            json: async () => [true],
          } as any;
        }
      });

      const res = await saveTracksToUserLibrary(userId, ["flaky-track-1"], "mock-token");
      expect(putCallCount).toBe(1); // Never blindly repeated the write!
      expect(containsCallCount).toBe(2); // Reconciled via GET /me/library/contains
      expect(res.savedCount).toBe(1); // Reconciled as saved!
      expect(res.failedIds).toHaveLength(0);
    });

    it("partitions requests into batches of max 40 URIs", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "user-library-modify" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      // Generate 50 unique tracks
      const fiftyTracks = Array.from({ length: 50 }, (_, i) => `track_${i}`);
      const putBatches: string[] = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
        if (init?.method === "PUT") {
          putBatches.push(url.toString());
          return { ok: true, status: 200 } as any;
        }
        // contains returns false
        const urlStr = url.toString();
        const uris = decodeURIComponent(urlStr.split("uris=")[1] || "").split(",");
        return {
          ok: true,
          status: 200,
          json: async () => Array(uris.length).fill(false),
        } as any;
      });

      const res = await saveTracksToUserLibrary(userId, fiftyTracks, "mock-token");
      expect(res.savedCount).toBe(50);
      expect(putBatches).toHaveLength(2);

      // Batch 1 has 40 tracks
      const batch1Uris = decodeURIComponent(putBatches[0]!.split("uris=")[1]!).split(",");
      expect(batch1Uris).toHaveLength(40);

      // Batch 2 has 10 tracks
      const batch2Uris = decodeURIComponent(putBatches[1]!.split("uris=")[1]!).split(",");
      expect(batch2Uris).toHaveLength(10);
    });

    it("verifies tracks in user library returning missing URIs and counts", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [true, false, true],
      } as any);

      const verification = await verifyTracksInUserLibrary(
        userId,
        ["track1", "track2", "track3"],
        "mock-token"
      );

      expect(verification.verified).toBe(false);
      expect(verification.actualCount).toBe(2);
      expect(verification.missingUris).toEqual(["spotify:track:track2"]);
    });
  });

  describe("Spotify Official Modern Endpoints vs Deprecated API Regression Suite", () => {
    it("strictly calls modern endpoints and never invokes deprecated playlist or library endpoints", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst").mockResolvedValue({
        id: "acc-1",
        userId,
        provider: "SPOTIFY",
        status: "CONNECTED",
        rawProfile: { scope: "playlist-modify-public user-library-modify playlist-read-private" },
      } as any);

      vi.spyOn(spotifyAuth, "getValidSpotifyAccessToken").mockResolvedValue("mock-token");

      const invokedCalls: Array<{ url: string; method: string }> = [];

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
        const urlStr = url.toString();
        const method = (init?.method || "GET").toUpperCase();
        invokedCalls.push({ url: urlStr, method });

        if (urlStr.includes("/me/playlists") && method === "POST") {
          return {
            ok: true,
            status: 201,
            json: async () => ({ id: "pl-reg-1", uri: "spotify:playlist:pl-reg-1", snapshot_id: "snap-1" }),
          } as any;
        }

        if (urlStr.includes("/playlists/pl-reg-1/items") && method === "POST") {
          return {
            ok: true,
            status: 201,
            json: async () => ({ snapshot_id: "snap-items-added" }),
          } as any;
        }

        if (urlStr.includes("/playlists/pl-reg-1/items") && method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ track: { uri: "spotify:track:t1", id: "t1" } }],
              next: null,
              total: 1,
            }),
          } as any;
        }

        if (urlStr.includes("/me/library/contains") && method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => [false],
          } as any;
        }

        if (urlStr.includes("/me/library") && method === "PUT") {
          return {
            ok: true,
            status: 200,
          } as any;
        }

        return { ok: false, status: 404 } as any;
      });

      // 1. Create Playlist
      await createDestinationPlaylist(userId, "Regression Playlist", "Testing modern endpoints", false, "mock-token");

      // 2. Add Items to Playlist
      await addTracksToDestinationPlaylist(userId, "pl-reg-1", ["spotify:track:t1"], "mock-token");

      // 3. Read Playlist Items
      await getDestinationPlaylistTrackUris(userId, "pl-reg-1", "mock-token");

      // 4. Verify Playlist Items
      await verifyDestinationPlaylist(userId, "pl-reg-1", 1, "mock-token");

      // 5. Check Library Membership
      await checkTracksInLibrary(userId, ["spotify:track:t1"], "mock-token");

      // 6. Save Tracks to Library
      await saveTracksToUserLibrary(userId, ["spotify:track:t1"], "mock-token");

      // Check all invoked endpoints
      expect(invokedCalls.length).toBeGreaterThanOrEqual(6);

      const urls = invokedCalls.map((c) => c.url);

      // Verify modern endpoints were used:
      expect(urls.some((u) => u.includes("https://api.spotify.com/v1/me/playlists"))).toBe(true);
      expect(urls.some((u) => u.includes("https://api.spotify.com/v1/playlists/pl-reg-1/items"))).toBe(true);
      expect(urls.some((u) => u.includes("https://api.spotify.com/v1/me/library/contains?uris="))).toBe(true);
      expect(urls.some((u) => u.includes("https://api.spotify.com/v1/me/library?uris="))).toBe(true);

      // Verify deprecated endpoints were NEVER called:
      for (const call of invokedCalls) {
        expect(call.url).not.toMatch(/\/v1\/playlists\/[^\/]+\/tracks/);
        expect(call.url).not.toMatch(/\/v1\/me\/tracks/);
        expect(call.url).not.toMatch(/\/v1\/users\/[^\/]+\/playlists/);
      }
    });
  });
});
