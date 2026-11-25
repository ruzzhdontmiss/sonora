import { ProviderCapabilities } from "../contracts/types";

/**
 * Standard ProviderCapabilities for YouTube Music / YouTube Data API v3.
 * Conforms to the common Sonora provider contract (matching Spotify & Apple Music architecture).
 */
export const YOUTUBE_MUSIC_CAPABILITIES: ProviderCapabilities = {
  canReadPlaylists: true,
  canWritePlaylists: true,
  canReadLikedTracks: true, // Partial: 1,000 ceiling, categoryId=10
  canWriteLikedTracks: true, // Partial: POST /videos/rate?rating=like
  canReadSavedAlbums: false, // Unsupported in official Google APIs
  canWriteSavedAlbums: false, // Unsupported in official Google APIs
  canSearchCatalog: true, // Quota-restricted: 100 search calls/day pool
  supportsIncrementalSync: false, // No sync tokens or webhooks
  rateLimitQuotaPerMinute: 60, // Bound by daily project quota (10,000 units/day)
};

export type CapabilityStatus = "SUPPORTED" | "PARTIAL" | "UNSUPPORTED";
export type QuotaBucketType = "GENERAL" | "SEARCH" | "NONE";

export interface YouTubeOperationCapability {
  operation: string;
  status: CapabilityStatus;
  endpoint: string;
  httpMethod: "GET" | "POST" | "PUT" | "DELETE" | "NONE";
  unitCost: number;
  quotaBucket: QuotaBucketType;
  description: string;
  limitations: string[];
}

/**
 * Detailed capability matrix for YouTube Data API v3.
 * Honestly distinguishes official video resource capabilities from consumer YouTube Music expectations.
 */
export const YOUTUBE_DATA_API_CAPABILITIES: Record<string, YouTubeOperationCapability> = {
  READ_PLAYLISTS: {
    operation: "READ_PLAYLISTS",
    status: "SUPPORTED",
    endpoint: "https://www.googleapis.com/youtube/v3/playlists",
    httpMethod: "GET",
    unitCost: 1,
    quotaBucket: "GENERAL",
    description: "Fetches user's created playlists via mine=true parameter.",
    limitations: [
      "Paginated at maximum 50 items per page.",
      "Requires OAuth scope: https://www.googleapis.com/auth/youtube.readonly or youtube",
    ],
  },
  READ_PLAYLIST_ITEMS: {
    operation: "READ_PLAYLIST_ITEMS",
    status: "SUPPORTED",
    endpoint: "https://www.googleapis.com/youtube/v3/playlistItems",
    httpMethod: "GET",
    unitCost: 1,
    quotaBucket: "GENERAL",
    description: "Fetches items in a playlist in ordered sequence.",
    limitations: [
      "Paginated at maximum 50 items per page.",
      "Preserves exact sequence order and duplicate track occurrences.",
    ],
  },
  CREATE_PLAYLIST: {
    operation: "CREATE_PLAYLIST",
    status: "SUPPORTED",
    endpoint: "https://www.googleapis.com/youtube/v3/playlists",
    httpMethod: "POST",
    unitCost: 50,
    quotaBucket: "GENERAL",
    description: "Creates a new playlist resource visible across YouTube and YouTube Music.",
    limitations: [
      "Appearance in YouTube Music is an empirical integration behavior, not backed by a dedicated YTM SLA.",
      "Requires OAuth scope: https://www.googleapis.com/auth/youtube",
    ],
  },
  INSERT_PLAYLIST_ITEM: {
    operation: "INSERT_PLAYLIST_ITEM",
    status: "SUPPORTED",
    endpoint: "https://www.googleapis.com/youtube/v3/playlistItems",
    httpMethod: "POST",
    unitCost: 50,
    quotaBucket: "GENERAL",
    description: "Appends a single track to a playlist.",
    limitations: [
      "Strictly single-item per HTTP request (no batch insertion API exists).",
      "No idempotency-key header or transactional atomicity supported by Google.",
      "Requires uncertain-write prefix recovery verification upon worker crashes or network timeouts.",
    ],
  },
  READ_LIKED_TRACKS: {
    operation: "READ_LIKED_TRACKS",
    status: "PARTIAL",
    endpoint: "https://www.googleapis.com/youtube/v3/videos",
    httpMethod: "GET",
    unitCost: 1,
    quotaBucket: "GENERAL",
    description: "Fetches user's liked videos via myRating=like parameter.",
    limitations: [
      "Strict hard ceiling of 1,000 most recent items enforced by Google documentation.",
      "Requires client-side filtering for categoryId === '10' (Music).",
      "Alternative channel-based relatedPlaylists.likes fails with 403 Forbidden if user channel likes are private.",
    ],
  },
  WRITE_LIKED_TRACKS: {
    operation: "WRITE_LIKED_TRACKS",
    status: "PARTIAL",
    endpoint: "https://www.googleapis.com/youtube/v3/videos/rate",
    httpMethod: "POST",
    unitCost: 50,
    quotaBucket: "GENERAL",
    description: "Rates a video as 'like' on behalf of the authenticated user.",
    limitations: [
      "Adds video to user's YouTube Liked Videos list.",
      "Does NOT guarantee native YouTube Music auto-mix algorithm personalization weights.",
    ],
  },
  SEARCH_CATALOG: {
    operation: "SEARCH_CATALOG",
    status: "PARTIAL",
    endpoint: "https://www.googleapis.com/youtube/v3/search",
    httpMethod: "GET",
    unitCost: 1,
    quotaBucket: "SEARCH",
    description: "Searches YouTube catalog for video candidates matching track metadata.",
    limitations: [
      "Consumes 1 call from the dedicated 100-call/day search bucket and 0 units from the general pool.",
      "Severely quota-constrained; live migrations must prioritize ISRC and exact matching before executing search.",
    ],
  },
  READ_SAVED_ALBUMS: {
    operation: "READ_SAVED_ALBUMS",
    status: "UNSUPPORTED",
    endpoint: "NONE",
    httpMethod: "NONE",
    unitCost: 0,
    quotaBucket: "NONE",
    description: "Reading saved albums directly from YouTube Music library.",
    limitations: [
      "No official Google REST endpoint exists for YouTube Music album library management.",
    ],
  },
  WRITE_SAVED_ALBUMS: {
    operation: "WRITE_SAVED_ALBUMS",
    status: "UNSUPPORTED",
    endpoint: "NONE",
    httpMethod: "NONE",
    unitCost: 0,
    quotaBucket: "NONE",
    description: "Saving an album to the user's YouTube Music library.",
    limitations: [
      "No official Google REST endpoint exists for YouTube Music album library management.",
    ],
  },
  INCREMENTAL_SYNC: {
    operation: "INCREMENTAL_SYNC",
    status: "UNSUPPORTED",
    endpoint: "NONE",
    httpMethod: "NONE",
    unitCost: 0,
    quotaBucket: "NONE",
    description: "Webhook or sync-token based change detection.",
    limitations: [
      "Google does not provide change-data-capture tokens or webhooks for YouTube playlists.",
    ],
  },
};

/**
 * Explicit non-parity registry documenting native YouTube Music consumer features
 * that are NOT supported through official Google APIs.
 */
export const YOUTUBE_MUSIC_NATIVE_NON_PARITY = {
  CLOUD_LOCKER_FILE_UPLOADS: {
    feature: "Cloud Locker File Uploads",
    supportedInInteractiveApi: false,
    reason: "Google provides no public REST API to upload local audio files to the user's personal YouTube Music locker.",
  },
  SAVE_ALBUM_TO_LIBRARY: {
    feature: "Save Album to Library Tab",
    supportedInInteractiveApi: false,
    reason: "YouTube Data API operates on video and playlist resources; it cannot add an official album entity to the YouTube Music Library tab.",
  },
  NATIVE_AUTOMIX_ALGORITHM_WEIGHTS: {
    feature: "Native Auto-mix Personalization Weights",
    supportedInInteractiveApi: false,
    reason: "Rating a video as 'like' populates the liked videos list, but internal YouTube Music auto-mix algorithm weighting is proprietary and undocumented.",
  },
  MUSIC_ARTIST_SUBSCRIPTION_SYNC: {
    feature: "YouTube Music Artist Subscriptions",
    supportedInInteractiveApi: false,
    reason: "Subscribing to a channel via YouTube Data API subscribes on main YouTube, which may not cleanly match YouTube Music artist followings.",
  },
  UNOFFICIAL_INNERTUBE_ENDPOINTS: {
    feature: "Unofficial Innertube / ytmusicapi Endpoints",
    supportedInInteractiveApi: false,
    policy: "STRICTLY_REJECTED",
    reason: "Sonora strictly prohibits reverse-engineered Innertube endpoints (youtubei/v1) and browser-cookie scraping (SAPISIDHASH) to protect user accounts from bans, CAPTCHAs, and Terms of Service violations.",
  },
} as const;

/**
 * Google Data Portability API Capability Registry.
 * KEPT STRICTLY SEPARATE from the standard YouTube Data API capability registry.
 *
 * Applicable ONLY to asynchronous batch archive exports for eligible geographic regions.
 */
export const GOOGLE_DATA_PORTABILITY_CAPABILITIES = {
  resourceGroup: "youtube.music",
  oauthScope: "https://www.googleapis.com/auth/dataportability.youtube.music",
  scopeClassification: "SENSITIVE" as const, // Confirmed Sensitive (NOT Restricted)
  operationMode: "ASYNCHRONOUS_BATCH_EXPORT" as const,
  supportedExtractions: {
    MUSIC_LIBRARY_SONGS: {
      supported: true,
      description: "Exports metadata for user's music library tracks (song title, album title, artist, video ID).",
    },
    CLOUD_LOCKER_UPLOADS: {
      supported: true,
      description: "Exports metadata and original uploaded media files from user's personal cloud locker.",
    },
  },
  unsupportedOperations: {
    INTERACTIVE_READS: false,
    INTERACTIVE_WRITES: false,
    PLAYLIST_MUTATIONS: false,
    REAL_TIME_SYNC: false,
  },
  geographicEligibility: {
    eligibleRegions: ["EEA", "UK", "CH", "US"],
    excludedRegions: ["IN"], // Officially excludes India
    notes: "Restricted to EEA, UK, Switzerland, and United States Google accounts based on applicable data portability regulations.",
  },
  archiveLifecycle: {
    signedUrlExpirationHours: 6, // Google Cloud Storage signed download URLs expire in 6 hours
    archiveRetentionDays: 14, // Completed archives are retained on Google storage for 14 days
    maxGenerationDurationDays: 7, // Google documents generation may take up to 7 days
    recommendedPollingIntervalMinutes: "5 to 60 minutes with exponential backoff",
    automaticAuthorizationResetDays: 14, // ResetAuthorization triggered after 14 days
    testingModeTokenExpirationDays: 7, // Refresh tokens expire after 7 days in Google Cloud Testing mode
  },
} as const;
