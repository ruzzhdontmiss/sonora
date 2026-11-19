import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as jose from "jose";
import { prisma } from "@/lib/db";
import {
  getAppleDeveloperToken,
  resetAppleTokenCache,
  getAppleConfigStatus,
} from "@/modules/providers/apple/apple-token.service";
import {
  saveAppleMusicUserToken,
  getValidAppleMusicUserToken,
  disconnectAppleMusicAccount,
} from "@/modules/providers/apple/apple-auth.service";
import {
  normalizeAppleTrack,
  normalizeApplePlaylist,
  AppleMusicImporterService,
} from "@/modules/providers/apple/apple-importer.service";
import {
  ProviderNotConfiguredError,
  ProviderAuthenticationError,
} from "@/modules/providers/errors";
import { ForbiddenError } from "@/modules/common/errors";
import { decryptToken } from "@/lib/encryption";
import {
  ProviderType,
  ProviderAccountStatus,
  SyncJobType,
  SyncJobStatus,
} from "@prisma/client";

describe("Apple Music Token Service, Auth & Importer (Unit & DB Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000030";
  let testPrivateKeyPem: string;

  beforeEach(async () => {
    // Generate an ephemeral ES256 P-256 private key for unit testing
    const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    testPrivateKeyPem = await jose.exportPKCS8(privateKey);

    process.env.APPLE_TEAM_ID = "TEAM123456";
    process.env.APPLE_MUSIC_KEY_ID = "KEY1234567";
    process.env.APPLE_MUSIC_PRIVATE_KEY = testPrivateKeyPem;
    delete process.env.APPLE_MUSIC_PRIVATE_KEY_PATH;

    resetAppleTokenCache();

    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { userId: testUserId } } });
    await prisma.providerPlaylist.deleteMany({ where: { userId: testUserId } });
    await prisma.playlist.deleteMany({ where: { userId: testUserId } });
    await prisma.libraryTrack.deleteMany({ where: { library: { userId: testUserId } } });
    await prisma.providerTrack.deleteMany({ where: { provider: ProviderType.APPLE_MUSIC, providerAccount: { userId: testUserId } } });
    await prisma.providerLibraryItem.deleteMany({ where: { providerAccount: { userId: testUserId } } });
    await prisma.providerAccount.deleteMany({ where: { userId: testUserId } });
    await prisma.library.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, "ee000000-0000-0000-0000-000000000099"] } } });

    await prisma.user.create({
      data: {
        id: testUserId,
        email: "apple-test@example.com",
        displayName: "Apple Tester",
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetAppleTokenCache();
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: testUserId } } });
    await prisma.syncJob.deleteMany({ where: { userId: testUserId } });
    await prisma.playlistItem.deleteMany({ where: { playlist: { userId: testUserId } } });
    await prisma.providerPlaylist.deleteMany({ where: { userId: testUserId } });
    await prisma.playlist.deleteMany({ where: { userId: testUserId } });
    await prisma.libraryTrack.deleteMany({ where: { library: { userId: testUserId } } });
    await prisma.providerTrack.deleteMany({ where: { provider: ProviderType.APPLE_MUSIC, providerAccount: { userId: testUserId } } });
    await prisma.providerLibraryItem.deleteMany({ where: { providerAccount: { userId: testUserId } } });
    await prisma.providerAccount.deleteMany({ where: { userId: testUserId } });
    await prisma.library.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, "ee000000-0000-0000-0000-000000000099"] } } });
  });

  describe("Apple Developer Token Service", () => {
    it("signs a valid ES256 Developer Token containing required headers and claims", async () => {
      const token = await getAppleDeveloperToken();
      expect(token).toBeDefined();

      const decodedHeader = jose.decodeProtectedHeader(token);
      expect(decodedHeader.alg).toBe("ES256");
      expect(decodedHeader.kid).toBe("KEY1234567");

      const decodedPayload = jose.decodeJwt(token);
      expect(decodedPayload.iss).toBe("TEAM123456");
      expect(decodedPayload.iat).toBeDefined();
      expect(decodedPayload.exp).toBeDefined();
      expect(decodedPayload.exp! - decodedPayload.iat!).toBe(24 * 60 * 60);
    });

    it("reuses cached developer token without re-signing on consecutive calls", async () => {
      const token1 = await getAppleDeveloperToken();
      const token2 = await getAppleDeveloperToken();
      expect(token1).toBe(token2);
    });

    it("fails with ProviderNotConfiguredError when credentials are missing", async () => {
      delete process.env.APPLE_TEAM_ID;
      resetAppleTokenCache();

      await expect(getAppleDeveloperToken()).rejects.toThrow(ProviderNotConfiguredError);
    });
  });

  describe("Apple Music User Authorization", () => {
    it("validates MUT via storefront, encrypts MUT at rest, and saves ProviderAccount", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/me/storefront")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: "us",
                  type: "storefronts",
                  attributes: {
                    name: "United States",
                    defaultLanguageTag: "en-US",
                    supportedLanguageTags: ["en-US"],
                  },
                },
              ],
            }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await saveAppleMusicUserToken(testUserId, "test-music-user-token-abc");

      expect(account).toBeDefined();
      expect(account.provider).toBe(ProviderType.APPLE_MUSIC);
      expect(account.status).toBe(ProviderAccountStatus.CONNECTED);
      expect(account.displayName).toContain("United States");

      // Verify token encrypted at rest
      expect(account.encryptedAccessToken).not.toBe("test-music-user-token-abc");
      expect(decryptToken(account.encryptedAccessToken)).toBe("test-music-user-token-abc");

      // Retrieve via helper
      const decrypted = await getValidAppleMusicUserToken(account.id, testUserId);
      expect(decrypted).toBe("test-music-user-token-abc");
    });

    it("rejects invalid or expired MUT with ProviderAuthenticationError", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ message: "Subscription inactive" }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(saveAppleMusicUserToken(testUserId, "expired-mut")).rejects.toThrow(
        ProviderAuthenticationError
      );
    });

    it("disconnects Apple Music account, wipes encrypted token, and preserves canonical data", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "us", attributes: { name: "United States" } }],
          }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await saveAppleMusicUserToken(testUserId, "mut-to-disconnect");
      await disconnectAppleMusicAccount(account.id, testUserId);

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(updated?.status).toBe(ProviderAccountStatus.DISCONNECTED);
      expect(updated?.encryptedAccessToken).toBe("");

      // User record preserved
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).not.toBeNull();
    });

    it("updates existing account on re-authorization rather than creating duplicate accounts", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "us", attributes: { name: "United States" } }],
          }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const firstAccount = await saveAppleMusicUserToken(testUserId, "initial-token");
      expect(firstAccount.status).toBe(ProviderAccountStatus.CONNECTED);

      // User re-authorizes, generating a new MUT
      const secondAccount = await saveAppleMusicUserToken(testUserId, "newly-issued-token");
      expect(secondAccount.id).toBe(firstAccount.id);

      // Verify only 1 Apple Music account exists for user
      const count = await prisma.providerAccount.count({
        where: { userId: testUserId, provider: ProviderType.APPLE_MUSIC },
      });
      expect(count).toBe(1);

      const decrypted = await getValidAppleMusicUserToken(firstAccount.id, testUserId);
      expect(decrypted).toBe("newly-issued-token");
    });

    it("rejects attempt by another user to connect an already active token with ForbiddenError", async () => {
      const otherUserId = "ee000000-0000-0000-0000-000000000099";
      await prisma.user.create({
        data: {
          id: otherUserId,
          email: "other-user@example.com",
          displayName: "Other User",
        },
      });

      try {
        const mockFetch = vi.fn().mockImplementation(() => {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: "us", attributes: { name: "United States" } }],
            }),
          });
        });
        vi.stubGlobal("fetch", mockFetch);

        await saveAppleMusicUserToken(testUserId, "shared-token");

        // Other user attempts to attach the same active token
        await expect(saveAppleMusicUserToken(otherUserId, "shared-token")).rejects.toThrow(
          ForbiddenError
        );
      } finally {
        await prisma.providerAccount.deleteMany({ where: { userId: otherUserId } });
        await prisma.user.deleteMany({ where: { id: otherUserId } });
      }
    });
  });

  describe("Apple Music Normalization", () => {
    it("normalizes Apple Music song preserving attributes", () => {
      const rawSong = {
        id: "i.apple-track-1",
        type: "library-songs",
        attributes: {
          name: "Symphony No. 5",
          artistName: "Ludwig van Beethoven",
          albumName: "Beethoven: The Symphonies",
          durationInMillis: 432000,
          isrc: "us-b01-23-45678",
          discNumber: 1,
          trackNumber: 1,
          contentRating: "clean",
          releaseDate: "1995-10-01",
        },
      };

      const normalized = normalizeAppleTrack(rawSong);
      expect(normalized).not.toBeNull();
      expect(normalized?.externalId).toBe("i.apple-track-1");
      expect(normalized?.title).toBe("Symphony No. 5");
      expect(normalized?.artistName).toBe("Ludwig van Beethoven");
      expect(normalized?.albumName).toBe("Beethoven: The Symphonies");
      expect(normalized?.durationMs).toBe(432000);
      expect(normalized?.isrc).toBe("US-B01-23-45678");
      expect(normalized?.explicit).toBe(false);
    });

    it("normalizes Apple Music playlist", () => {
      const rawPlaylist = {
        id: "p.apple-pl-1",
        type: "library-playlists",
        attributes: {
          name: "Classical Morning",
          description: { standard: "Gentle classical pieces" },
          isPublic: true,
        },
        relationships: {
          tracks: {
            data: [{ id: "i.1" } as any, { id: "i.2" } as any],
          },
        },
      };

      const normalized = normalizeApplePlaylist(rawPlaylist);
      expect(normalized.externalId).toBe("p.apple-pl-1");
      expect(normalized.title).toBe("Classical Morning");
      expect(normalized.description).toBe("Gentle classical pieces");
      expect(normalized.isPublic).toBe(true);
      expect(normalized.itemCount).toBe(2);
    });
  });

  describe("Apple Music Importer Execution", () => {
    it("imports songs and playlists preserving playlist order and duplicates", async () => {
      // Mock storefront check for account creation
      const mockStorefrontFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/me/storefront")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: "us", attributes: { name: "United States" } }] }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockStorefrontFetch);

      const account = await saveAppleMusicUserToken(testUserId, "mut-for-importer");

      const syncJob = await prisma.syncJob.create({
        data: {
          userId: testUserId,
          jobType: SyncJobType.IMPORT,
          sourceProvider: "APPLE_MUSIC",
          targetProvider: "SONORA",
          status: SyncJobStatus.RUNNING,
        },
      });

      // Mock Apple Music API library songs & playlists
      const mockSongsPage = {
        data: [
          {
            id: "i.apple-song-1",
            type: "library-songs",
            attributes: {
              name: "Gymnopédie No. 1",
              artistName: "Erik Satie",
              albumName: "Piano Works",
              durationInMillis: 185000,
              isrc: "FRSAT0000001",
            },
          },
        ],
      };

      const mockPlaylistsPage = {
        data: [
          {
            id: "p.apple-playlist-1",
            type: "library-playlists",
            attributes: {
              name: "Peaceful Piano",
              description: { standard: "Calm piano pieces" },
              isPublic: false,
            },
          },
        ],
      };

      const mockPlaylistTracksPage = {
        data: [
          {
            id: "i.apple-song-1",
            type: "library-songs",
            attributes: {
              name: "Gymnopédie No. 1",
              artistName: "Erik Satie",
              durationInMillis: 185000,
              isrc: "FRSAT0000001",
            },
          },
          {
            id: "i.apple-song-2",
            type: "library-songs",
            attributes: {
              name: "Nocturne Op. 9 No. 2",
              artistName: "Frédéric Chopin",
              durationInMillis: 270000,
              isrc: "PLCHP0000002",
            },
          },
          // DUPLICATE OCCURRENCE at position 2
          {
            id: "i.apple-song-1",
            type: "library-songs",
            attributes: {
              name: "Gymnopédie No. 1",
              artistName: "Erik Satie",
              durationInMillis: 185000,
              isrc: "FRSAT0000001",
            },
          },
        ],
      };

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/me/library/songs")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockSongsPage });
        }
        if (url.includes("/me/library/playlists/p.apple-playlist-1/tracks")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockPlaylistTracksPage });
        }
        if (url.includes("/me/library/playlists")) {
          return Promise.resolve({ ok: true, status: 200, json: async () => mockPlaylistsPage });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const importer = new AppleMusicImporterService();
      const result = await importer.importLibrary({
        userId: testUserId,
        providerAccountId: account.id,
        syncJobId: syncJob.id,
      });

      expect(result.songsImported).toBe(1);
      expect(result.playlistsImported).toBe(1);
      expect(result.playlistItemsImported).toBe(3);
      expect(result.totalFailed).toBe(0);

      // Verify canonical playlist items: 3 items, positions 0, 1, 2
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
      expect(playlist?.items.length).toBe(3);
      expect(playlist?.items[0].position).toBe(0);
      expect(playlist?.items[0].track.title).toBe("Gymnopédie No. 1");
      expect(playlist?.items[1].position).toBe(1);
      expect(playlist?.items[1].track.title).toBe("Nocturne Op. 9 No. 2");
      expect(playlist?.items[2].position).toBe(2);
      expect(playlist?.items[2].track.title).toBe("Gymnopédie No. 1");
      expect(playlist?.items[2].trackId).toBe(playlist?.items[0].trackId);
    });
  });
});
