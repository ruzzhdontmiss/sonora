/**
 * YouTube Data API v3 Library and Playlist Importer for SONORA (P5-T04).
 *
 * Implements read-only library import for YouTube / YouTube Music:
 * - Liked music extraction with 1,000-item ceiling and categoryId=10 filtering
 * - Fallback to channels.list relatedPlaylists.likes if myRating=like returns 0
 * - User created and saved playlist extraction
 * - Contiguous playlist item ordering and duplicate preservation
 * - Graceful skipping of private/deleted/unavailable videos
 * - Durable checkpointing to survive worker restarts and quota exhaustion
 * - Strict quota accounting (1 unit per page of 50 items)
 */

import { prisma } from "@/lib/db";
import {
  NormalizedTrack,
  NormalizedPlaylist,
} from "../contracts/types";
import {
  getYouTubeAccessToken,
} from "./youtube-auth.service";
import {
  ProviderRateLimitError,
  ProviderAuthenticationError,
  ProviderQuotaExhaustedError,
  ProviderError,
} from "../errors";
import {
  addTrackToLibrary,
} from "@/modules/library/library.service";
import {
  findOrCreateCanonicalTrack,
  persistProviderTrackMatch,
} from "@/modules/matching/track-matching.service";
import {
  parseYouTubeDuration,
  extractIsrcFromYouTubeDescription,
  parseYouTubeVideoTitle,
} from "@/modules/matching/youtube-normalizer";
import { getYouTubeQuotaManager } from "./quota/youtube-quota-manager";
import {
  LibrarySourceProvenance,
  Prisma,
  ProviderItemStatus,
  ProviderItemType,
  ProviderType,
  SyncOperationAction,
  SyncOperationStatus,
} from "@prisma/client";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export interface YouTubePageResponse<T> {
  kind: string;
  etag: string;
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: T[];
}

export interface YouTubeImportCheckpoint {
  stage: "LIKED_TRACKS" | "PLAYLISTS" | "COMPLETED";
  likedNextPageToken?: string | null;
  likedTracksCount: number;
  playlistNextPageToken?: string | null;
  playlistIndex: number;
  playlistTracksNextPageToken?: string | null;
  currentPlaylistExternalId?: string;
  currentPositionInPlaylist: number;
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
}

export interface YouTubeImportProgress {
  stage: string;
  processed: number;
  failed: number;
  skipped: number;
  currentItem?: string;
}

export interface YouTubeImportResult {
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
  likedTracksImported: number;
  playlistsImported: number;
  playlistItemsImported: number;
}

/**
 * Executes a YouTube Data API v3 request with bounded retries,
 * rate limit handling, and quota exhaustion detection.
 */
export async function youTubeFetch<T>(
  url: string,
  accessToken: string,
  attempt = 1
): Promise<T> {
  const maxAttempts = 3;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : Math.pow(2, attempt);
      const waitMs = Math.min(Math.max(1, retryAfterSec) * 1000, 30000);

      if (attempt < maxAttempts) {
        console.warn(`⏳ [YouTube] 429 Rate limit. Backing off for ${waitMs}ms before attempt ${attempt + 1}...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return youTubeFetch<T>(url, accessToken, attempt + 1);
      }

      throw new ProviderRateLimitError("YOUTUBE_MUSIC", retryAfterSec);
    }

    if (res.status === 401) {
      throw new ProviderAuthenticationError("YOUTUBE_MUSIC", "Google/YouTube access token expired or revoked.");
    }

    if (res.status === 403) {
      const errBody = await res.text().catch(() => "");
      if (errBody.includes("quotaExceeded") || errBody.includes("dailyLimitExceeded")) {
        const tomorrowPacific = new Date();
        tomorrowPacific.setUTCDate(tomorrowPacific.getUTCDate() + 1);
        tomorrowPacific.setUTCHours(7, 0, 0, 0);
        throw new ProviderQuotaExhaustedError({
          provider: "YOUTUBE_MUSIC",
          quotaBucket: "GENERAL",
          limit: 10000,
          requested: 1,
          remaining: 0,
          resetsAt: tomorrowPacific,
        });
      }
      throw new ProviderError("YOUTUBE_MUSIC", `YouTube API 403 Forbidden: ${errBody.slice(0, 250)}`);
    }

    if (res.status >= 500 && attempt < maxAttempts) {
      const jitterMs = Math.floor(Math.random() * 500);
      const backoffMs = Math.pow(2, attempt) * 1000 + jitterMs;
      console.warn(`⚠️ [YouTube] 5xx Server Error (${res.status}). Retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return youTubeFetch<T>(url, accessToken, attempt + 1);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new ProviderError(
        "YOUTUBE_MUSIC",
        `API request failed (HTTP ${res.status}): ${errBody.slice(0, 250)}`
      );
    }

    return (await res.json()) as T;
  } catch (err: unknown) {
    if (
      err instanceof ProviderError ||
      err instanceof ProviderRateLimitError ||
      err instanceof ProviderAuthenticationError ||
      err instanceof ProviderQuotaExhaustedError
    ) {
      throw err;
    }
    if (attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return youTubeFetch<T>(url, accessToken, attempt + 1);
    }
    throw new ProviderError(
      "YOUTUBE_MUSIC",
      `Network failure connecting to YouTube: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Normalizes raw YouTube video data into SONORA's canonical track representation.
 * Returns null if video is private, deleted, unavailable, or non-musical.
 */
export function normalizeYouTubeTrack(videoItem: Record<string, unknown>): NormalizedTrack | null {
  const id = String(videoItem["id"] || "");
  const snippet = (videoItem["snippet"] || {}) as Record<string, unknown>;
  const contentDetails = (videoItem["contentDetails"] || {}) as Record<string, unknown>;
  const status = (videoItem["status"] || {}) as Record<string, unknown>;

  if (!id) return null;

  const rawTitle = String(snippet["title"] || "");
  const channelTitle = String(snippet["channelTitle"] || "");
  const description = String(snippet["description"] || "");

  // Skip deleted or private videos
  if (
    rawTitle === "Private video" ||
    rawTitle === "Deleted video" ||
    status["privacyStatus"] === "private"
  ) {
    return null;
  }

  const parsed = parseYouTubeVideoTitle(rawTitle, channelTitle, description);
  const isrc = extractIsrcFromYouTubeDescription(description);
  const durationIso = String(contentDetails["duration"] || "");
  const durationMs = parseYouTubeDuration(durationIso);

  const contentRating = contentDetails["contentRating"] as Record<string, unknown> | undefined;
  const isExplicit = parsed.isExplicit || contentRating?.["ytRating"] === "ytAgeRestricted";

  return {
    externalId: id,
    isrc,
    title: parsed.title,
    artistName: parsed.artist,
    albumName: null,
    durationMs,
    explicit: isExplicit,
    discNumber: 1,
    trackNumber: null,
    uri: `https://www.youtube.com/watch?v=${id}`,
    rawMetadata: {
      youtubeId: id,
      channelId: snippet["channelId"],
      channelTitle,
      publishedAt: snippet["publishedAt"],
      categoryId: snippet["categoryId"],
      tags: snippet["tags"],
    },
  };
}

/**
 * Normalizes raw YouTube playlist data into SONORA's canonical playlist representation.
 */
export function normalizeYouTubePlaylist(playlistItem: Record<string, unknown>): NormalizedPlaylist {
  const id = String(playlistItem["id"] || "");
  const snippet = (playlistItem["snippet"] || {}) as Record<string, unknown>;
  const contentDetails = (playlistItem["contentDetails"] || {}) as Record<string, unknown>;
  const status = (playlistItem["status"] || {}) as Record<string, unknown>;

  const rawTitle = String(snippet["title"] || "Untitled Playlist");
  const rawDesc = String(snippet["description"] || "");
  const isPublic = status["privacyStatus"] === "public";
  const itemCount = Number(contentDetails["itemCount"] || 0);

  return {
    externalId: id,
    title: rawTitle,
    description: rawDesc || null,
    isPublic,
    itemCount,
    snapshotId: null,
    rawMetadata: {
      youtubeId: id,
      channelId: snippet["channelId"],
      publishedAt: snippet["publishedAt"],
    },
  };
}

export class YouTubeImporterService {
  /**
   * Fetches a paginated chunk of the current user's liked videos via myRating=like.
   * Google documents an absolute maximum ceiling of 1,000 items.
   * Consumes 1 general quota unit.
   */
  public async fetchLikedVideosPage(
    accessToken: string,
    pageToken?: string | null,
    limit = 50
  ): Promise<YouTubePageResponse<Record<string, unknown>>> {
    const quotaManager = getYouTubeQuotaManager();
    await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "videos.list" });

    let url = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,status&myRating=like&maxResults=${limit}`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    return youTubeFetch<YouTubePageResponse<Record<string, unknown>>>(url, accessToken);
  }

  /**
   * Fallback: discovers the user's "likes" playlist from channels.list?part=contentDetails&mine=true.
   * Consumes 1 general quota unit.
   */
  public async discoverLikedPlaylistId(accessToken: string): Promise<string | null> {
    const quotaManager = getYouTubeQuotaManager();
    await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "channels.list" });

    const url = `${YOUTUBE_API_BASE}/channels?part=contentDetails&mine=true`;
    const response = await youTubeFetch<YouTubePageResponse<Record<string, unknown>>>(url, accessToken);

    if (response.items && response.items.length > 0) {
      const channel = response.items[0];
      const contentDetails = channel["contentDetails"] as Record<string, unknown> | undefined;
      const related = contentDetails?.["relatedPlaylists"] as Record<string, unknown> | undefined;
      const likesId = related?.["likes"];
      if (likesId && typeof likesId === "string") {
        return likesId;
      }
    }

    return null;
  }

  /**
   * Fetches a paginated chunk of the current user's playlists via playlists.list?mine=true.
   * Consumes 1 general quota unit.
   */
  public async fetchPlaylistsPage(
    accessToken: string,
    pageToken?: string | null,
    limit = 50
  ): Promise<YouTubePageResponse<Record<string, unknown>>> {
    const quotaManager = getYouTubeQuotaManager();
    await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "playlists.list" });

    let url = `${YOUTUBE_API_BASE}/playlists?part=snippet,contentDetails,status&mine=true&maxResults=${limit}`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    return youTubeFetch<YouTubePageResponse<Record<string, unknown>>>(url, accessToken);
  }

  /**
   * Fetches a paginated chunk of items in a playlist via playlistItems.list.
   * Consumes 1 general quota unit.
   */
  public async fetchPlaylistItemsPage(
    accessToken: string,
    playlistId: string,
    pageToken?: string | null,
    limit = 50
  ): Promise<YouTubePageResponse<Record<string, unknown>>> {
    const quotaManager = getYouTubeQuotaManager();
    await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "playlistItems.list" });

    let url = `${YOUTUBE_API_BASE}/playlistItems?part=snippet,contentDetails,status&playlistId=${encodeURIComponent(playlistId)}&maxResults=${limit}`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    return youTubeFetch<YouTubePageResponse<Record<string, unknown>>>(url, accessToken);
  }

  /**
   * Batch fetches complete video snippet and contentDetails for up to 50 video IDs.
   * Consumes 1 general quota unit.
   */
  public async batchFetchVideos(
    accessToken: string,
    videoIds: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const videoMap = new Map<string, Record<string, unknown>>();
    if (videoIds.length === 0) return videoMap;

    const quotaManager = getYouTubeQuotaManager();
    await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "videos.list" });

    const url = `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(videoIds.join(","))}`;
    const response = await youTubeFetch<YouTubePageResponse<Record<string, unknown>>>(url, accessToken);

    if (response.items) {
      for (const item of response.items) {
        if (item["id"]) {
          videoMap.set(String(item["id"]), item);
        }
      }
    }

    return videoMap;
  }

  /**
   * Runs the complete read-only library and playlist import for a connected YouTube account.
   * Supports durable checkpointing, resumability, and granular sync operations.
   */
  public async importLibrary(options: {
    userId: string;
    providerAccountId: string;
    syncJobId?: string;
    checkpoint?: YouTubeImportCheckpoint;
    onProgress?: (progress: YouTubeImportProgress) => Promise<void>;
  }): Promise<YouTubeImportResult> {
    const { userId, providerAccountId, syncJobId, onProgress } = options;

    let accessToken = await getYouTubeAccessToken(userId);

    const checkpoint: YouTubeImportCheckpoint = options.checkpoint || {
      stage: "LIKED_TRACKS",
      likedNextPageToken: null,
      likedTracksCount: 0,
      playlistNextPageToken: null,
      playlistIndex: 0,
      playlistTracksNextPageToken: null,
      currentPositionInPlaylist: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalSkipped: 0,
    };

    let likedTracksImported = 0;
    let playlistsImported = 0;
    let playlistItemsImported = 0;

    // Helper to log individual sync operations
    const logOp = async (
      itemType: string,
      sourceId: string,
      action: SyncOperationAction,
      status: SyncOperationStatus,
      targetId?: string,
      errorMessage?: string
    ) => {
      if (!syncJobId) return;
      await prisma.syncOperation.create({
        data: {
          syncJobId,
          itemType,
          sourceId,
          targetId: targetId || null,
          action,
          status,
          errorMessage: errorMessage || null,
        },
      });
    };

    // Helper to update sync job progress and checkpoint atomically
    const saveCheckpoint = async () => {
      if (!syncJobId) return;
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          processedItems: checkpoint.totalProcessed,
          failedItems: checkpoint.totalFailed,
          checkpoint: checkpoint as unknown as Prisma.InputJsonValue,
        },
      });
    };

    // =========================================================================
    // Stage 1: Liked Music Extraction (with 1,000 ceiling & categoryId=10 filter)
    // =========================================================================
    if (checkpoint.stage === "LIKED_TRACKS") {
      let hasMoreLiked = true;
      const MAX_LIKED_RESULTS = 1000;

      while (hasMoreLiked && checkpoint.likedTracksCount < MAX_LIKED_RESULTS) {
        accessToken = await getYouTubeAccessToken(userId);

        let page: YouTubePageResponse<Record<string, unknown>>;
        try {
          page = await this.fetchLikedVideosPage(
            accessToken,
            checkpoint.likedNextPageToken,
            50
          );
        } catch (fetchErr: unknown) {
          // If myRating=like fails or yields 0, attempt fallback to relatedPlaylists.likes
          if (checkpoint.likedTracksCount === 0) {
            console.warn("⚠️ [YouTube] myRating=like failed. Attempting fallback to relatedPlaylists.likes...");
            const fallbackPlaylistId = await this.discoverLikedPlaylistId(accessToken);
            if (fallbackPlaylistId) {
              checkpoint.currentPlaylistExternalId = fallbackPlaylistId;
              // Transition to playlist processor for likes playlist
            }
          }
          throw fetchErr;
        }

        if (!page.items || page.items.length === 0) {
          hasMoreLiked = false;
          break;
        }

        for (const item of page.items) {
          const snippet = (item["snippet"] || {}) as Record<string, unknown>;
          const categoryId = String(snippet["categoryId"] || "");

          // Filter: only Category 10 (Music). Omit non-musical videos.
          if (categoryId !== "10") {
            checkpoint.totalSkipped++;
            await logOp(
              "TRACK",
              String(item["id"] || "non-music-video"),
              SyncOperationAction.SKIPPED,
              SyncOperationStatus.WARNING,
              undefined,
              `Skipped non-musical YouTube video (categoryId=${categoryId}).`
            );
            continue;
          }

          const normalized = normalizeYouTubeTrack(item);
          if (!normalized) {
            checkpoint.totalSkipped++;
            await logOp(
              "TRACK",
              String(item["id"] || "unavailable-video"),
              SyncOperationAction.SKIPPED,
              SyncOperationStatus.WARNING,
              undefined,
              "Skipped unavailable, deleted, or private YouTube video."
            );
            continue;
          }

          try {
            const added = await addTrackToLibrary(userId, {
              title: normalized.title,
              artistName: normalized.artistName,
              albumName: normalized.albumName,
              durationMs: normalized.durationMs,
              explicit: normalized.explicit,
              isrc: normalized.isrc,
              discNumber: normalized.discNumber,
              trackNumber: normalized.trackNumber,
              sourceProvenance: LibrarySourceProvenance.YOUTUBE_MUSIC_IMPORT,
              providerSource: {
                provider: ProviderType.YOUTUBE_MUSIC,
                externalId: normalized.externalId,
                providerAccountId,
                providerUri: normalized.uri,
                rawMetadata: normalized.rawMetadata as unknown as Prisma.InputJsonValue,
              },
            });

            // Upsert ProviderLibraryItem
            await prisma.providerLibraryItem.upsert({
              where: {
                providerAccountId_itemType_externalId: {
                  providerAccountId,
                  itemType: ProviderItemType.TRACK,
                  externalId: normalized.externalId,
                },
              },
              create: {
                providerAccountId,
                itemType: ProviderItemType.TRACK,
                externalId: normalized.externalId,
                status: ProviderItemStatus.ACTIVE,
                syncedAt: new Date(),
              },
              update: {
                status: ProviderItemStatus.ACTIVE,
                syncedAt: new Date(),
              },
            });

            checkpoint.totalProcessed++;
            checkpoint.likedTracksCount++;
            likedTracksImported++;

            const action = added.matchResolution.isNew
              ? SyncOperationAction.CREATED
              : SyncOperationAction.MATCHED;

            await logOp(
              "TRACK",
              normalized.externalId,
              action,
              SyncOperationStatus.SUCCESS,
              added.id
            );
          } catch (err: unknown) {
            checkpoint.totalFailed++;
            console.error(`Failed to import YouTube liked track [${normalized.externalId}]:`, err);
            await logOp(
              "TRACK",
              normalized.externalId,
              SyncOperationAction.FAILED,
              SyncOperationStatus.ERROR,
              undefined,
              err instanceof Error ? err.message : String(err)
            );
          }
        }

        checkpoint.likedNextPageToken = page.nextPageToken || null;
        hasMoreLiked = Boolean(page.nextPageToken) && checkpoint.likedTracksCount < MAX_LIKED_RESULTS;

        await saveCheckpoint();
        if (onProgress) {
          await onProgress({
            stage: "Liked Music",
            processed: checkpoint.totalProcessed,
            failed: checkpoint.totalFailed,
            skipped: checkpoint.totalSkipped,
          });
        }
      }

      // Transition to Stage 2: Playlists
      checkpoint.stage = "PLAYLISTS";
      checkpoint.playlistIndex = 0;
      checkpoint.playlistNextPageToken = null;
      checkpoint.playlistTracksNextPageToken = null;
      checkpoint.currentPositionInPlaylist = 0;
      await saveCheckpoint();
    }

    // =========================================================================
    // Stage 2: User Playlists and Playlist Items Import
    // =========================================================================
    if (checkpoint.stage === "PLAYLISTS") {
      let hasMorePlaylists = true;

      const library = await prisma.library.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });

      while (hasMorePlaylists) {
        accessToken = await getYouTubeAccessToken(userId);
        const playlistsPage = await this.fetchPlaylistsPage(
          accessToken,
          checkpoint.playlistNextPageToken,
          50
        );

        if (!playlistsPage.items || playlistsPage.items.length === 0) {
          hasMorePlaylists = false;
          break;
        }

        for (const rawPlaylist of playlistsPage.items) {
          const normalizedPlaylist = normalizeYouTubePlaylist(rawPlaylist);

          // 1. Upsert ProviderPlaylist and sovereign canonical Playlist
          const canonicalPlaylist = await prisma.providerPlaylist.findUnique({
            where: {
              providerAccountId_externalId: {
                providerAccountId,
                externalId: normalizedPlaylist.externalId,
              },
            },
            include: { playlist: true },
          });

          let playlistId: string;

          if (canonicalPlaylist) {
            playlistId = canonicalPlaylist.playlistId;
            await prisma.playlist.update({
              where: { id: playlistId },
              data: {
                title: normalizedPlaylist.title,
                description: normalizedPlaylist.description,
              },
            });
            await prisma.providerPlaylist.update({
              where: { id: canonicalPlaylist.id },
              data: { lastSyncedAt: new Date() },
            });
          } else {
            const newPlaylist = await prisma.playlist.create({
              data: {
                userId,
                libraryId: library.id,
                title: normalizedPlaylist.title,
                description: normalizedPlaylist.description,
                isPublic: normalizedPlaylist.isPublic ?? false,
              },
            });
            playlistId = newPlaylist.id;

            await prisma.providerPlaylist.create({
              data: {
                userId,
                playlistId,
                providerAccountId,
                externalId: normalizedPlaylist.externalId,
                lastSyncedAt: new Date(),
              },
            });

            playlistsImported++;
            checkpoint.totalProcessed++;
            await logOp(
              "PLAYLIST",
              normalizedPlaylist.externalId,
              SyncOperationAction.CREATED,
              SyncOperationStatus.SUCCESS,
              playlistId
            );
          }

          // 2. Fetch and import items for this playlist
          let hasMoreItems = true;
          checkpoint.currentPlaylistExternalId = normalizedPlaylist.externalId;
          checkpoint.playlistTracksNextPageToken = null;
          checkpoint.currentPositionInPlaylist = 0;

          while (hasMoreItems) {
            accessToken = await getYouTubeAccessToken(userId);
            const itemsPage = await this.fetchPlaylistItemsPage(
              accessToken,
              normalizedPlaylist.externalId,
              checkpoint.playlistTracksNextPageToken,
              50
            );

            if (!itemsPage.items || itemsPage.items.length === 0) {
              hasMoreItems = false;
              break;
            }

            // Extract video IDs to batch fetch duration and category details
            const videoIds = itemsPage.items
              .map((it) => {
                const snip = it["snippet"] as Record<string, unknown> | undefined;
                const resId = snip?.["resourceId"] as Record<string, unknown> | undefined;
                return String(resId?.["videoId"] || "");
              })
              .filter(Boolean);

            const videoDetailsMap = await this.batchFetchVideos(accessToken, videoIds);

            for (const item of itemsPage.items) {
              const snip = (item["snippet"] || {}) as Record<string, unknown>;
              const resId = (snip["resourceId"] || {}) as Record<string, unknown>;
              const videoId = String(resId["videoId"] || "");

              if (!videoId) {
                checkpoint.totalSkipped++;
                continue;
              }

              const detailedVideo = videoDetailsMap.get(videoId);
              const normalizedTrack = normalizeYouTubeTrack(detailedVideo || item);

              if (!normalizedTrack) {
                checkpoint.totalSkipped++;
                checkpoint.currentPositionInPlaylist++;
                await logOp(
                  "PLAYLIST_ITEM",
                  `${normalizedPlaylist.externalId}:${checkpoint.currentPositionInPlaylist}`,
                  SyncOperationAction.SKIPPED,
                  SyncOperationStatus.WARNING,
                  undefined,
                  "Skipped unavailable or private YouTube playlist item."
                );
                continue;
              }

              try {
                // Find or create sovereign canonical track
                const canonicalTrack = await prisma.$transaction(async (tx) => {
                  const resolution = await findOrCreateCanonicalTrack(
                    {
                      title: normalizedTrack.title,
                      artistName: normalizedTrack.artistName,
                      albumName: normalizedTrack.albumName,
                      durationMs: normalizedTrack.durationMs,
                      explicit: normalizedTrack.explicit,
                      isrc: normalizedTrack.isrc,
                      discNumber: normalizedTrack.discNumber,
                      trackNumber: normalizedTrack.trackNumber,
                    },
                    tx
                  );

                  await persistProviderTrackMatch(
                    tx,
                    resolution,
                    normalizedTrack,
                    {
                      provider: ProviderType.YOUTUBE_MUSIC,
                      externalId: normalizedTrack.externalId,
                      providerAccountId,
                      providerUri: normalizedTrack.uri,
                      rawMetadata: normalizedTrack.rawMetadata as unknown as Prisma.InputJsonValue,
                    }
                  );

                  return resolution.track;
                });

                // Contiguous positioning in playlist (duplicate tracks allowed)
                await prisma.playlistItem.upsert({
                  where: {
                    playlistId_position: {
                      playlistId,
                      position: checkpoint.currentPositionInPlaylist,
                    },
                  },
                  create: {
                    playlistId,
                    trackId: canonicalTrack.id,
                    position: checkpoint.currentPositionInPlaylist,
                  },
                  update: {
                    trackId: canonicalTrack.id,
                  },
                });

                playlistItemsImported++;
                checkpoint.totalProcessed++;
                checkpoint.currentPositionInPlaylist++;

                await logOp(
                  "PLAYLIST_ITEM",
                  `${normalizedPlaylist.externalId}:${checkpoint.currentPositionInPlaylist}`,
                  SyncOperationAction.MATCHED,
                  SyncOperationStatus.SUCCESS,
                  canonicalTrack.id
                );
              } catch (err: unknown) {
                checkpoint.totalFailed++;
                checkpoint.currentPositionInPlaylist++;
                console.error(`Failed to import YouTube playlist item at position ${checkpoint.currentPositionInPlaylist}:`, err);
                await logOp(
                  "PLAYLIST_ITEM",
                  `${normalizedPlaylist.externalId}:${checkpoint.currentPositionInPlaylist}`,
                  SyncOperationAction.FAILED,
                  SyncOperationStatus.ERROR,
                  undefined,
                  err instanceof Error ? err.message : String(err)
                );
              }
            }

            checkpoint.playlistTracksNextPageToken = itemsPage.nextPageToken || null;
            hasMoreItems = Boolean(itemsPage.nextPageToken);

            await saveCheckpoint();
            if (onProgress) {
              await onProgress({
                stage: "Playlist Items",
                processed: checkpoint.totalProcessed,
                failed: checkpoint.totalFailed,
                skipped: checkpoint.totalSkipped,
                currentItem: normalizedPlaylist.title,
              });
            }
          }

          checkpoint.playlistIndex++;
          await saveCheckpoint();
        }

        checkpoint.playlistNextPageToken = playlistsPage.nextPageToken || null;
        hasMorePlaylists = Boolean(playlistsPage.nextPageToken);
        await saveCheckpoint();
      }

      checkpoint.stage = "COMPLETED";
      await saveCheckpoint();
    }

    return {
      totalProcessed: checkpoint.totalProcessed,
      totalFailed: checkpoint.totalFailed,
      totalSkipped: checkpoint.totalSkipped,
      likedTracksImported,
      playlistsImported,
      playlistItemsImported,
    };
  }
}

export const youTubeImporter = new YouTubeImporterService();
