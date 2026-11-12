import { ProviderType } from "@prisma/client";
import {
  ProviderCapabilities,
  NormalizedTrack,
  NormalizedPlaylist,
  NormalizedPlaylistItem,
  NormalizedPaginatedResponse,
  ProviderWriteResult,
  ProviderUserProfile,
} from "./types";

/**
 * Common contract for all music streaming provider adapters.
 * Business logic and sync jobs interact exclusively through this interface,
 * preventing coupling to provider-specific SDKs or HTTP payload structures.
 */
export interface MusicProviderAdapter {
  readonly provider: ProviderType;

  /**
   * Returns the explicit runtime capabilities of this provider.
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Fetches the authenticated user's external profile.
   */
  getProfile(accessToken: string): Promise<ProviderUserProfile>;

  /**
   * Fetches the user's external playlists in paginated chunks.
   */
  getUserPlaylists(
    accessToken: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylist>>;

  /**
   * Fetches items for an external playlist in sequence order.
   */
  getPlaylistItems(
    accessToken: string,
    playlistExternalId: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylistItem>>;

  /**
   * Fetches the user's liked / saved tracks in paginated chunks.
   */
  getUserLikedTracks(
    accessToken: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedTrack>>;

  /**
   * Creates an external playlist on the provider.
   */
  createPlaylist(
    accessToken: string,
    input: { title: string; description?: string; isPublic?: boolean }
  ): Promise<ProviderWriteResult>;

  /**
   * Appends tracks to an external playlist.
   */
  addTracksToPlaylist(
    accessToken: string,
    playlistExternalId: string,
    trackExternalIds: string[]
  ): Promise<ProviderWriteResult>;

  /**
   * Searches the provider catalog for matching tracks.
   */
  searchTracks(
    accessToken: string,
    query: string,
    limit?: number
  ): Promise<NormalizedTrack[]>;
}

