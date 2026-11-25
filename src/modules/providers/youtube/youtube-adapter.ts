/**
 * YouTube Music Provider Adapter.
 * Conforms to MusicProviderAdapter contract.
 *
 * Implements real service invocations for OAuth profile, Importer, Catalog Search, and Destination Writer.
 */

import { ProviderType } from "@prisma/client";
import { MusicProviderAdapter } from "../contracts/adapter.interface";
import {
  NormalizedPaginatedResponse,
  NormalizedPlaylist,
  NormalizedPlaylistItem,
  NormalizedTrack,
  ProviderCapabilities,
  ProviderUserProfile,
  ProviderWriteResult,
} from "../contracts/types";
import { providerRegistry } from "../registry";
import { YOUTUBE_MUSIC_CAPABILITIES } from "./youtube-capabilities";
import { getUserProfile } from "./youtube-auth.service";
import {
  youTubeImporter,
  normalizeYouTubeTrack,
  normalizeYouTubePlaylist,
} from "./youtube-importer.service";
import {
  createDestinationPlaylist,
  addTracksToDestinationPlaylist,
} from "./youtube-writer.service";
import { searchYouTubeCatalog } from "@/modules/matching/matching-engine";

export class YouTubeMusicProviderAdapter implements MusicProviderAdapter {
  public readonly provider = ProviderType.YOUTUBE_MUSIC;

  public getCapabilities(): ProviderCapabilities {
    return { ...YOUTUBE_MUSIC_CAPABILITIES };
  }

  public async getProfile(accessToken: string): Promise<ProviderUserProfile> {
    const profile = await getUserProfile(accessToken);
    return {
      providerUserId: profile.sub,
      displayName: profile.name || "YouTube User",
      email: profile.email,
      rawProfile: profile as unknown as Record<string, unknown>,
    };
  }

  public async getUserPlaylists(
    accessToken: string,
    cursor?: string,
    limit = 50
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylist>> {
    const response = await youTubeImporter.fetchPlaylistsPage(accessToken, cursor, limit);
    const items = (response.items || []).map((raw) => normalizeYouTubePlaylist(raw));

    return {
      items,
      nextCursor: response.nextPageToken || null,
      total: response.pageInfo?.totalResults,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  public async getPlaylistItems(
    accessToken: string,
    playlistExternalId: string,
    cursor?: string,
    limit = 50
  ): Promise<NormalizedPaginatedResponse<NormalizedPlaylistItem>> {
    const response = await youTubeImporter.fetchPlaylistItemsPage(
      accessToken,
      playlistExternalId,
      cursor,
      limit
    );

    const videoIds = (response.items || [])
      .map((it) => {
        const snip = it["snippet"] as Record<string, unknown> | undefined;
        const resId = snip?.["resourceId"] as Record<string, unknown> | undefined;
        return String(resId?.["videoId"] || "");
      })
      .filter(Boolean);

    const videoDetailsMap = await youTubeImporter.batchFetchVideos(accessToken, videoIds);

    const items: NormalizedPlaylistItem[] = [];
    let position = 0;

    for (const rawItem of response.items || []) {
      const snip = (rawItem["snippet"] || {}) as Record<string, unknown>;
      const resId = (snip["resourceId"] || {}) as Record<string, unknown>;
      const videoId = String(resId["videoId"] || "");

      const detailed = videoDetailsMap.get(videoId);
      const normalizedTrack = normalizeYouTubeTrack(detailed || rawItem);

      if (normalizedTrack) {
        items.push({
          externalId: `${playlistExternalId}:${position}`,
          track: normalizedTrack,
          position,
        });
        position++;
      }
    }

    return {
      items,
      nextCursor: response.nextPageToken || null,
      total: response.pageInfo?.totalResults,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  public async getUserLikedTracks(
    accessToken: string,
    cursor?: string,
    limit = 50
  ): Promise<NormalizedPaginatedResponse<NormalizedTrack>> {
    const response = await youTubeImporter.fetchLikedVideosPage(accessToken, cursor, limit);
    const items: NormalizedTrack[] = [];

    for (const raw of response.items || []) {
      const snippet = (raw["snippet"] || {}) as Record<string, unknown>;
      if (String(snippet["categoryId"]) === "10") {
        const track = normalizeYouTubeTrack(raw);
        if (track) {
          items.push(track);
        }
      }
    }

    return {
      items,
      nextCursor: response.nextPageToken || null,
      total: response.pageInfo?.totalResults,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  public async createPlaylist(
    accessToken: string,
    input: { title: string; description?: string; isPublic?: boolean }
  ): Promise<ProviderWriteResult> {
    const created = await createDestinationPlaylist(
      "system",
      input.title,
      input.description,
      input.isPublic,
      accessToken
    );

    return {
      success: true,
      externalId: created.externalId,
      message: `Created playlist at ${created.url}`,
    };
  }

  public async addTracksToPlaylist(
    accessToken: string,
    playlistExternalId: string,
    trackExternalIds: string[]
  ): Promise<ProviderWriteResult> {
    const res = await addTracksToDestinationPlaylist(
      "system",
      playlistExternalId,
      trackExternalIds,
      accessToken
    );

    return {
      success: res.failedVideoIds.length === 0,
      itemsAffected: res.addedCount,
      message:
        res.failedVideoIds.length > 0
          ? `Failed items: ${res.failedVideoIds.map((f) => f.videoId).join(", ")}`
          : undefined,
    };
  }

  public async searchTracks(
    accessToken: string,
    query: string,
    limit = 10
  ): Promise<NormalizedTrack[]> {
    const candidates = await searchYouTubeCatalog(query, {
      accessToken,
      limit,
    });

    return candidates.map((cand) => ({
      externalId: cand.id,
      title: cand.title,
      artistName: cand.artistName,
      albumName: cand.albumName,
      durationMs: cand.durationMs,
      explicit: cand.explicit,
      isrc: cand.isrc,
      uri: cand.uri || undefined,
      rawMetadata: cand.rawMetadata,
    }));
  }
}

export const youTubeMusicProviderAdapter = new YouTubeMusicProviderAdapter();

/**
 * Registers the YouTube Music provider adapter with the global provider registry.
 */
export function registerYouTubeMusicProvider(): void {
  providerRegistry.register(youTubeMusicProviderAdapter);
}
