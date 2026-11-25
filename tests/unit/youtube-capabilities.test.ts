import { describe, it, expect } from "vitest";
import { ProviderType } from "@prisma/client";
import { providerRegistry } from "@/modules/providers/registry";
import { UnsupportedOperationError } from "@/modules/common/errors";
import {
  YOUTUBE_MUSIC_CAPABILITIES,
  YOUTUBE_DATA_API_CAPABILITIES,
  YOUTUBE_MUSIC_NATIVE_NON_PARITY,
  GOOGLE_DATA_PORTABILITY_CAPABILITIES,
  YouTubeMusicProviderAdapter,
  registerYouTubeMusicProvider,
} from "@/modules/providers/youtube";

describe("YouTube Provider Capability Registry Foundations (P5-T01)", () => {
  describe("Standard Provider Capabilities Architecture", () => {
    it("exposes capabilities consistent with the common Sonora provider contract", () => {
      expect(YOUTUBE_MUSIC_CAPABILITIES.canReadPlaylists).toBe(true);
      expect(YOUTUBE_MUSIC_CAPABILITIES.canWritePlaylists).toBe(true);
      expect(YOUTUBE_MUSIC_CAPABILITIES.canReadLikedTracks).toBe(true);
      expect(YOUTUBE_MUSIC_CAPABILITIES.canWriteLikedTracks).toBe(true);
      expect(YOUTUBE_MUSIC_CAPABILITIES.canSearchCatalog).toBe(true);
      // Unsupported operations must be explicitly flagged as false
      expect(YOUTUBE_MUSIC_CAPABILITIES.canReadSavedAlbums).toBe(false);
      expect(YOUTUBE_MUSIC_CAPABILITIES.canWriteSavedAlbums).toBe(false);
      expect(YOUTUBE_MUSIC_CAPABILITIES.supportsIncrementalSync).toBe(false);
      expect(YOUTUBE_MUSIC_CAPABILITIES.rateLimitQuotaPerMinute).toBe(60);
    });

    it("registers the YouTube adapter in providerRegistry and asserts supported capabilities", () => {
      registerYouTubeMusicProvider();
      expect(providerRegistry.has(ProviderType.YOUTUBE_MUSIC)).toBe(true);

      const adapter = providerRegistry.get(ProviderType.YOUTUBE_MUSIC);
      expect(adapter.provider).toBe(ProviderType.YOUTUBE_MUSIC);

      // Supported capabilities succeed
      expect(() =>
        providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "canReadPlaylists")
      ).not.toThrow();

      expect(() =>
        providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "canWritePlaylists")
      ).not.toThrow();
    });

    it("fails fast with typed UnsupportedOperationError for unsupported operations", () => {
      registerYouTubeMusicProvider();

      expect(() =>
        providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "canReadSavedAlbums")
      ).toThrow(UnsupportedOperationError);

      expect(() =>
        providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "canWriteSavedAlbums")
      ).toThrow(UnsupportedOperationError);

      expect(() =>
        providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "supportsIncrementalSync")
      ).toThrow(UnsupportedOperationError);
    });

    it("implements all required MusicProviderAdapter methods post Phase 5 implementation", () => {
      const adapter = new YouTubeMusicProviderAdapter();

      expect(typeof adapter.getProfile).toBe("function");
      expect(typeof adapter.getUserPlaylists).toBe("function");
      expect(typeof adapter.getPlaylistItems).toBe("function");
      expect(typeof adapter.getUserLikedTracks).toBe("function");
      expect(typeof adapter.createPlaylist).toBe("function");
      expect(typeof adapter.addTracksToPlaylist).toBe("function");
      expect(typeof adapter.searchTracks).toBe("function");
    });
  });

  describe("Granular YouTube Data API v3 Capability Matrix", () => {
    it("documents exact operation endpoints, unit costs, and quota buckets", () => {
      const insertCap = YOUTUBE_DATA_API_CAPABILITIES.INSERT_PLAYLIST_ITEM;
      expect(insertCap.status).toBe("SUPPORTED");
      expect(insertCap.httpMethod).toBe("POST");
      expect(insertCap.unitCost).toBe(50);
      expect(insertCap.quotaBucket).toBe("GENERAL");
      expect(insertCap.limitations).toContain(
        "Strictly single-item per HTTP request (no batch insertion API exists)."
      );

      const createCap = YOUTUBE_DATA_API_CAPABILITIES.CREATE_PLAYLIST;
      expect(createCap.status).toBe("SUPPORTED");
      expect(createCap.unitCost).toBe(50);

      const readCap = YOUTUBE_DATA_API_CAPABILITIES.READ_PLAYLIST_ITEMS;
      expect(readCap.status).toBe("SUPPORTED");
      expect(readCap.unitCost).toBe(1);
    });

    it("honestly flags partial operations and documented ceilings", () => {
      const likedCap = YOUTUBE_DATA_API_CAPABILITIES.READ_LIKED_TRACKS;
      expect(likedCap.status).toBe("PARTIAL");
      expect(likedCap.limitations.some((l) => l.includes("1,000 most recent items"))).toBe(true);
      expect(likedCap.limitations.some((l) => l.includes("categoryId === '10'"))).toBe(true);

      const searchCap = YOUTUBE_DATA_API_CAPABILITIES.SEARCH_CATALOG;
      expect(searchCap.status).toBe("PARTIAL");
      expect(searchCap.quotaBucket).toBe("SEARCH");
      expect(searchCap.unitCost).toBe(1);
      expect(searchCap.limitations.some((l) => l.includes("100-call/day"))).toBe(true);
    });

    it("honestly flags unsupported album library operations", () => {
      expect(YOUTUBE_DATA_API_CAPABILITIES.READ_SAVED_ALBUMS.status).toBe("UNSUPPORTED");
      expect(YOUTUBE_DATA_API_CAPABILITIES.WRITE_SAVED_ALBUMS.status).toBe("UNSUPPORTED");
      expect(YOUTUBE_DATA_API_CAPABILITIES.INCREMENTAL_SYNC.status).toBe("UNSUPPORTED");
    });
  });

  describe("Native YouTube Music Non-Parity Declarations", () => {
    it("explicitly documents unsupported native features and Innertube rejection", () => {
      expect(YOUTUBE_MUSIC_NATIVE_NON_PARITY.CLOUD_LOCKER_FILE_UPLOADS.supportedInInteractiveApi).toBe(false);
      expect(YOUTUBE_MUSIC_NATIVE_NON_PARITY.SAVE_ALBUM_TO_LIBRARY.supportedInInteractiveApi).toBe(false);
      expect(YOUTUBE_MUSIC_NATIVE_NON_PARITY.NATIVE_AUTOMIX_ALGORITHM_WEIGHTS.supportedInInteractiveApi).toBe(false);

      expect(YOUTUBE_MUSIC_NATIVE_NON_PARITY.UNOFFICIAL_INNERTUBE_ENDPOINTS.policy).toBe("STRICTLY_REJECTED");
      expect(YOUTUBE_MUSIC_NATIVE_NON_PARITY.UNOFFICIAL_INNERTUBE_ENDPOINTS.reason).toContain("SAPISIDHASH");
    });
  });

  describe("Google Data Portability API Capability Separation", () => {
    it("keeps Data Portability strictly separate from interactive YouTube Data API registry", () => {
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.resourceGroup).toBe("youtube.music");
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.scopeClassification).toBe("SENSITIVE");
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.operationMode).toBe("ASYNCHRONOUS_BATCH_EXPORT");

      // Verify confirmed lifecycle parameters
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.archiveLifecycle.signedUrlExpirationHours).toBe(6);
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.archiveLifecycle.archiveRetentionDays).toBe(14);
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.archiveLifecycle.maxGenerationDurationDays).toBe(7);
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.archiveLifecycle.testingModeTokenExpirationDays).toBe(7);

      // Verify geographic boundaries
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.geographicEligibility.eligibleRegions).toEqual([
        "EEA",
        "UK",
        "CH",
        "US",
      ]);
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.geographicEligibility.excludedRegions).toContain("IN");

      // Verify interactive writes/mutations are unsupported
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.unsupportedOperations.INTERACTIVE_WRITES).toBe(false);
      expect(GOOGLE_DATA_PORTABILITY_CAPABILITIES.unsupportedOperations.PLAYLIST_MUTATIONS).toBe(false);
    });
  });
});
