import { ProviderType } from "@prisma/client";
import { MusicProviderAdapter } from "../contracts/adapter.interface";
import {
  ProviderCapabilities,
  NormalizedTrack,
  NormalizedPlaylist,
  NormalizedPlaylistItem,
  NormalizedPaginatedResponse,
  ProviderWriteResult,
  ProviderUserProfile,
} from "../contracts/types";
import { UnsupportedOperationError } from "@/modules/common/errors";

export interface FakeAdapterOptions {
  provider?: ProviderType;
  capabilities?: Partial<ProviderCapabilities>;
  cannedPlaylists?: NormalizedPlaylist[];
  cannedPlaylistItems?: Record<string, NormalizedPlaylistItem[]>;
  cannedLikedTracks?: NormalizedTrack[];
}

export class FakeMusicProviderAdapter implements MusicProviderAdapter {
  public readonly provider: ProviderType;
  private capabilities: ProviderCapabilities;

  public cannedPlaylists: NormalizedPlaylist[];
  public cannedPlaylistItems: Record<string, NormalizedPlaylistItem[]>;
  public cannedLikedTracks: NormalizedTrack[];

  constructor(options: FakeAdapterOptions = {}) {
    this.provider = options.provider ?? ProviderType.SPOTIFY;
    this.capabilities = {
      canReadPlaylists: true,
      canWritePlaylists: true,
      canReadLikedTracks: true,
      canWriteLikedTracks: true,
      canReadSavedAlbums: true,
      canWriteSavedAlbums: true,
      canSearchCatalog: true,
      supportsIncrementalSync: true,
      rateLimitQuotaPerMinute: 60,
      ...options.capabilities,
    };

    this.cannedPlaylists = options.cannedPlaylists ?? [];
    this.cannedPlaylistItems = options.cannedPlaylistItems ?? {};
    this.cannedLikedTracks = options.cannedLikedTracks ?? [];
  }

  public setCapability(key: keyof ProviderCapabilities, value: boolean): void {
    (this.capabilities as unknown as Record<keyof ProviderCapabilities, boolean>)[key] = value;
  }

  public getCapabilities(): ProviderCapabilities {
    return { ...this.capabilities };
  }

  public async getProfile(accessToken: string): Promise<ProviderUserProfile> {
    if (!accessToken) throw new Error("Missing access token");
    return {
      providerUserId: `fake_${this.provider.toLowerCase()}_user_01`,
      displayName: `Fake ${this.provider} User`,
      email: `fake-${this.provider.toLowerCase()}@example.com`,
    };
  }

  public async getUserPlaylists(
    accessToken: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylist>> {
    void accessToken;
    void cursor;
    void limit;
    if (!this.capabilities.canReadPlaylists) {
      throw new UnsupportedOperationError(this.provider, "canReadPlaylists");
    }
    return {
      items: this.cannedPlaylists,
      total: this.cannedPlaylists.length,
      nextCursor: null,
      hasMore: false,
    };
  }

  public async getPlaylistItems(
    accessToken: string,
    playlistExternalId: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylistItem>> {
    void accessToken;
    void cursor;
    void limit;
    if (!this.capabilities.canReadPlaylists) {
      throw new UnsupportedOperationError(this.provider, "canReadPlaylists");
    }
    const items = this.cannedPlaylistItems[playlistExternalId] ?? [];
    return {
      items,
      total: items.length,
      nextCursor: null,
      hasMore: false,
    };
  }

  public async getUserLikedTracks(
    accessToken: string,
    cursor?: string,
    limit?: number
  ): Promise<NormalizedPaginatedResponse<NormalizedTrack>> {
    void accessToken;
    void cursor;
    void limit;
    if (!this.capabilities.canReadLikedTracks) {
      throw new UnsupportedOperationError(this.provider, "canReadLikedTracks");
    }
    return {
      items: this.cannedLikedTracks,
      total: this.cannedLikedTracks.length,
      nextCursor: null,
      hasMore: false,
    };
  }

  public async createPlaylist(
    accessToken: string,
    input: { title: string; description?: string; isPublic?: boolean }
  ): Promise<ProviderWriteResult> {
    void accessToken;
    if (!this.capabilities.canWritePlaylists) {
      throw new UnsupportedOperationError(this.provider, "canWritePlaylists");
    }
    const newId = `fake_playlist_${Date.now()}`;
    const newPlaylist: NormalizedPlaylist = {
      externalId: newId,
      title: input.title,
      description: input.description,
      isPublic: input.isPublic,
      itemCount: 0,
      snapshotId: "snap_001",
    };
    this.cannedPlaylists.push(newPlaylist);
    return { success: true, externalId: newId, snapshotId: "snap_001" };
  }

  public async addTracksToPlaylist(
    accessToken: string,
    playlistExternalId: string,
    trackExternalIds: string[]
  ): Promise<ProviderWriteResult> {
    void accessToken;
    if (!this.capabilities.canWritePlaylists) {
      throw new UnsupportedOperationError(this.provider, "canWritePlaylists");
    }
    const current = this.cannedPlaylistItems[playlistExternalId] ?? [];
    const startIndex = current.length;

    const newItems: NormalizedPlaylistItem[] = trackExternalIds.map((tid, idx) => ({
      externalId: `item_${Date.now()}_${idx}`,
      position: startIndex + idx,
      track: {
        externalId: tid,
        title: `Track ${tid}`,
        artistName: "Fake Artist",
        durationMs: 180000,
      },
    }));

    this.cannedPlaylistItems[playlistExternalId] = [...current, ...newItems];

    return {
      success: true,
      itemsAffected: trackExternalIds.length,
      snapshotId: `snap_${Date.now()}`,
    };
  }

  public async searchTracks(
    accessToken: string,
    query: string,
    limit?: number
  ): Promise<NormalizedTrack[]> {
    void accessToken;
    void limit;
    if (!this.capabilities.canSearchCatalog) {
      throw new UnsupportedOperationError(this.provider, "canSearchCatalog");
    }
    return [
      {
        externalId: `search_res_${encodeURIComponent(query)}`,
        title: `Search Result for ${query}`,
        artistName: "Artist",
        durationMs: 200000,
      },
    ];
  }
}
