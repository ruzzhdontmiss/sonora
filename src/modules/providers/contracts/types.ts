/**
 * Explicit capability flags for music streaming providers.
 * Unsupported operations must be explicitly flagged and rejected at runtime.
 */
export interface ProviderCapabilities {
  canReadPlaylists: boolean;
  canWritePlaylists: boolean;
  canReadLikedTracks: boolean;
  canWriteLikedTracks: boolean;
  canReadSavedAlbums: boolean;
  canWriteSavedAlbums: boolean;
  canSearchCatalog: boolean;
  supportsIncrementalSync: boolean;
  rateLimitQuotaPerMinute?: number;
}

/**
 * Normalized canonical track metadata extracted from provider responses.
 */
export interface NormalizedTrack {
  externalId: string;
  isrc?: string | null;
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  explicit?: boolean;
  discNumber?: number;
  trackNumber?: number | null;
  uri?: string;
  rawMetadata?: Record<string, unknown>;
}

/**
 * Normalized playlist metadata extracted from provider responses.
 */
export interface NormalizedPlaylist {
  externalId: string;
  title: string;
  description?: string | null;
  isPublic?: boolean;
  itemCount: number;
  snapshotId?: string | null;
  rawMetadata?: Record<string, unknown>;
}

/**
 * Normalized playlist item with sequence position.
 */
export interface NormalizedPlaylistItem {
  externalId: string;
  track: NormalizedTrack;
  position: number;
  addedAt?: Date;
}

/**
 * Normalized paginated container.
 */
export interface NormalizedPaginatedResponse<T> {
  items: T[];
  total?: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

/**
 * Normalized outcome of a write/mutation operation against a provider.
 */
export interface ProviderWriteResult {
  success: boolean;
  externalId?: string;
  snapshotId?: string;
  itemsAffected?: number;
  message?: string;
}

/**
 * Normalized user profile info from OAuth provider.
 */
export interface ProviderUserProfile {
  providerUserId: string;
  displayName: string;
  email?: string | null;
  rawProfile?: Record<string, unknown>;
}
