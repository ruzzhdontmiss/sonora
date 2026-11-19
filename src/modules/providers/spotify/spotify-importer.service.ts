import { prisma } from "@/lib/db";
import {
  NormalizedTrack,
  NormalizedPlaylist,
} from "../contracts/types";
import {
  getValidSpotifyAccessToken,
} from "./spotify-auth.service";
import {
  ProviderRateLimitError,
  ProviderAuthenticationError,
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
  LibrarySourceProvenance,
  Prisma,
  ProviderItemStatus,
  ProviderItemType,
  ProviderType,
  SyncOperationAction,
  SyncOperationStatus,
} from "@prisma/client";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export interface SpotifyPagingObject<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

export interface SpotifyTrackRaw {
  id: string;
  name: string;
  uri?: string;
  duration_ms: number;
  explicit?: boolean;
  disc_number?: number;
  track_number?: number;
  is_local?: boolean;
  external_ids?: {
    isrc?: string;
    ean?: string;
    upc?: string;
  };
  artists?: Array<{ id: string; name: string }>;
  album?: {
    id: string;
    name: string;
    release_date?: string;
    images?: Array<{ url: string; height?: number; width?: number }>;
  };
}

export interface SpotifyPlaylistTrackRaw {
  added_at: string;
  track: SpotifyTrackRaw | null;
}

export interface SpotifyPlaylistRaw {
  id: string;
  name: string;
  description: string | null;
  public: boolean;
  snapshot_id: string;
  tracks: {
    total: number;
    href: string;
  };
  owner?: {
    id: string;
    display_name?: string;
  };
}

export interface SpotifySavedTrackRaw {
  added_at: string;
  track: SpotifyTrackRaw;
}

export interface ImportCheckpoint {
  stage: "LIKED_TRACKS" | "PLAYLISTS" | "COMPLETED";
  likedTracksOffset: number;
  playlistIndex: number;
  playlistTracksOffset: number;
  currentPlaylistExternalId?: string;
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
}

export interface ImportProgress {
  stage: string;
  processed: number;
  failed: number;
  skipped: number;
  currentItem?: string;
}

export interface ImportResult {
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
  likedTracksImported: number;
  playlistsImported: number;
  playlistItemsImported: number;
}

/**
 * Executes a Spotify Web API request with bounded retry logic and HTTP 429 Retry-After compliance.
 */
export async function spotifyFetch<T>(
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
        console.warn(`⏳ [Spotify] 429 Rate limit encountered. Sleeping for ${waitMs}ms before retry ${attempt + 1}...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return spotifyFetch<T>(url, accessToken, attempt + 1);
      }

      throw new ProviderRateLimitError("SPOTIFY", retryAfterSec);
    }

    if (res.status === 401) {
      throw new ProviderAuthenticationError("SPOTIFY", "Spotify access token expired or revoked.");
    }

    if (res.status >= 500 && attempt < maxAttempts) {
      const jitterMs = Math.floor(Math.random() * 500);
      const backoffMs = Math.pow(2, attempt) * 1000 + jitterMs;
      console.warn(`⚠️ [Spotify] 5xx Server Error (${res.status}). Retrying in ${backoffMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return spotifyFetch<T>(url, accessToken, attempt + 1);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new ProviderError(
        "SPOTIFY",
        `API request failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`
      );
    }

    return (await res.json()) as T;
  } catch (err: unknown) {
    if (err instanceof ProviderError) throw err;
    if (attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return spotifyFetch<T>(url, accessToken, attempt + 1);
    }
    throw new ProviderError(
      "SPOTIFY",
      `Network failure connecting to Spotify: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Normalizes a raw Spotify track into SONORA's canonical format.
 * Returns null if the track is null (e.g. deleted or region-restricted) or local.
 */
export function normalizeSpotifyTrack(track: SpotifyTrackRaw | null): NormalizedTrack | null {
  if (!track || !track.id || track.is_local) {
    return null;
  }

  const isrc = track.external_ids?.isrc ? track.external_ids.isrc.trim().toUpperCase() : null;
  const artistName = track.artists?.map((a) => a.name).join(", ") || "Unknown Artist";
  const albumName = track.album?.name || null;

  return {
    externalId: track.id,
    isrc: isrc && isrc.length > 0 ? isrc : null,
    title: track.name || "Untitled Track",
    artistName,
    albumName,
    durationMs: track.duration_ms || 0,
    explicit: track.explicit ?? false,
    discNumber: track.disc_number ?? 1,
    trackNumber: track.track_number ?? null,
    uri: track.uri,
    rawMetadata: {
      spotifyId: track.id,
      albumId: track.album?.id,
      releaseDate: track.album?.release_date,
      images: track.album?.images,
    },
  };
}

/**
 * Normalizes a raw Spotify playlist into SONORA's canonical playlist format.
 */
export function normalizeSpotifyPlaylist(playlist: SpotifyPlaylistRaw): NormalizedPlaylist {
  return {
    externalId: playlist.id,
    title: playlist.name || "Untitled Playlist",
    description: playlist.description || null,
    isPublic: playlist.public ?? false,
    itemCount: playlist.tracks?.total || 0,
    snapshotId: playlist.snapshot_id || null,
    rawMetadata: {
      spotifyId: playlist.id,
      ownerId: playlist.owner?.id,
    },
  };
}

export class SpotifyImporterService {
  /**
   * Fetches a paginated chunk of the current user's saved (liked) tracks.
   */
  public async fetchLikedTracksPage(
    accessToken: string,
    offset = 0,
    limit = 50
  ): Promise<SpotifyPagingObject<SpotifySavedTrackRaw>> {
    const url = `${SPOTIFY_API_BASE}/me/tracks?limit=${limit}&offset=${offset}`;
    return spotifyFetch<SpotifyPagingObject<SpotifySavedTrackRaw>>(url, accessToken);
  }

  /**
   * Fetches a paginated chunk of the current user's playlists.
   */
  public async fetchPlaylistsPage(
    accessToken: string,
    offset = 0,
    limit = 50
  ): Promise<SpotifyPagingObject<SpotifyPlaylistRaw>> {
    const url = `${SPOTIFY_API_BASE}/me/playlists?limit=${limit}&offset=${offset}`;
    return spotifyFetch<SpotifyPagingObject<SpotifyPlaylistRaw>>(url, accessToken);
  }

  /**
   * Fetches items for a specific Spotify playlist.
   * Uses modern official GET /v1/playlists/{id}/items (replaces deprecated /tracks).
   */
  public async fetchPlaylistTracksPage(
    accessToken: string,
    playlistId: string,
    offset = 0,
    limit = 100
  ): Promise<SpotifyPagingObject<SpotifyPlaylistTrackRaw>> {
    const url = `${SPOTIFY_API_BASE}/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`;
    return spotifyFetch<SpotifyPagingObject<SpotifyPlaylistTrackRaw>>(url, accessToken);
  }

  /**
   * Runs the complete read-only library and playlist import for an authorized user.
   * Supports persistent checkpointing, re-entrancy, and granular per-item sync operations.
   */
  public async importLibrary(options: {
    userId: string;
    providerAccountId: string;
    syncJobId?: string;
    checkpoint?: ImportCheckpoint;
    onProgress?: (progress: ImportProgress) => Promise<void>;
  }): Promise<ImportResult> {
    const { userId, providerAccountId, syncJobId, onProgress } = options;

    let accessToken = await getValidSpotifyAccessToken(providerAccountId, userId);

    const checkpoint: ImportCheckpoint = options.checkpoint || {
      stage: "LIKED_TRACKS",
      likedTracksOffset: 0,
      playlistIndex: 0,
      playlistTracksOffset: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalSkipped: 0,
    };

    let likedTracksImported = 0;
    let playlistsImported = 0;
    let playlistItemsImported = 0;

    // Helper to log sync operations
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

    // Helper to update sync job metrics and checkpoint
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
    // Stage 1: Liked / Saved Tracks Import
    // =========================================================================
    if (checkpoint.stage === "LIKED_TRACKS") {
      let hasMoreLiked = true;

      while (hasMoreLiked) {
        // Refresh token if needed before network request
        accessToken = await getValidSpotifyAccessToken(providerAccountId, userId);

        const page = await this.fetchLikedTracksPage(
          accessToken,
          checkpoint.likedTracksOffset,
          50
        );

        if (!page.items || page.items.length === 0) {
          hasMoreLiked = false;
          break;
        }

        for (const item of page.items) {
          const normalized = normalizeSpotifyTrack(item.track);

          if (!normalized) {
            checkpoint.totalSkipped++;
            await logOp(
              "TRACK",
              item.track?.id || "unknown-local",
              SyncOperationAction.SKIPPED,
              SyncOperationStatus.WARNING,
              undefined,
              "Skipped unavailable or local track."
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
              sourceProvenance: LibrarySourceProvenance.SPOTIFY_IMPORT,
              providerSource: {
                provider: ProviderType.SPOTIFY,
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
            likedTracksImported++;

            const action =
              added.matchResolution.isNew
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
            console.error(`Failed to import Spotify liked track [${normalized.externalId}]:`, err);
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

        checkpoint.likedTracksOffset += page.items.length;
        hasMoreLiked = page.next !== null;

        await saveCheckpoint();
        if (onProgress) {
          await onProgress({
            stage: "Liked Tracks",
            processed: checkpoint.totalProcessed,
            failed: checkpoint.totalFailed,
            skipped: checkpoint.totalSkipped,
          });
        }
      }

      // Transition to Stage 2: Playlists
      checkpoint.stage = "PLAYLISTS";
      checkpoint.playlistIndex = 0;
      checkpoint.playlistTracksOffset = 0;
      await saveCheckpoint();
    }

    // =========================================================================
    // Stage 2: Playlists & Playlist Items Import
    // =========================================================================
    if (checkpoint.stage === "PLAYLISTS") {
      let hasMorePlaylists = true;
      let playlistsOffset = checkpoint.playlistIndex;

      // Ensure sovereign Library exists
      const library = await prisma.library.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });

      while (hasMorePlaylists) {
        accessToken = await getValidSpotifyAccessToken(providerAccountId, userId);
        const playlistsPage = await this.fetchPlaylistsPage(accessToken, playlistsOffset, 50);

        if (!playlistsPage.items || playlistsPage.items.length === 0) {
          hasMorePlaylists = false;
          break;
        }

        for (const rawPlaylist of playlistsPage.items) {
          const normalizedPlaylist = normalizeSpotifyPlaylist(rawPlaylist);

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
            // Update metadata
            await prisma.playlist.update({
              where: { id: playlistId },
              data: {
                title: normalizedPlaylist.title,
                description: normalizedPlaylist.description,
              },
            });
            await prisma.providerPlaylist.update({
              where: { id: canonicalPlaylist.id },
              data: {
                snapshotId: normalizedPlaylist.snapshotId,
                lastSyncedAt: new Date(),
              },
            });
          } else {
            // Create sovereign canonical playlist
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
                snapshotId: normalizedPlaylist.snapshotId,
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

          // 2. Fetch Playlist Tracks Page by Page
          let hasMorePlaylistTracks = true;
          let tracksOffset = checkpoint.playlistTracksOffset;
          let currentPosition = tracksOffset;

          while (hasMorePlaylistTracks) {
            accessToken = await getValidSpotifyAccessToken(providerAccountId, userId);
            const tracksPage = await this.fetchPlaylistTracksPage(
              accessToken,
              normalizedPlaylist.externalId,
              tracksOffset,
              100
            );

            if (!tracksPage.items || tracksPage.items.length === 0) {
              hasMorePlaylistTracks = false;
              break;
            }

            for (const item of tracksPage.items) {
              const normalizedTrack = normalizeSpotifyTrack(item.track);

              if (!normalizedTrack) {
                checkpoint.totalSkipped++;
                await logOp(
                  "PLAYLIST_ITEM",
                  item.track?.id || "unplayable",
                  SyncOperationAction.SKIPPED,
                  SyncOperationStatus.WARNING,
                  undefined,
                  "Skipped unplayable or unavailable track in playlist."
                );
                currentPosition++;
                continue;
              }

              try {
                // Find or create canonical track & persist mapping in transaction
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
                      provider: ProviderType.SPOTIFY,
                      externalId: normalizedTrack.externalId,
                      providerAccountId,
                      providerUri: normalizedTrack.uri,
                      rawMetadata: normalizedTrack.rawMetadata as unknown as Prisma.InputJsonValue,
                    }
                  );

                  return resolution.track;
                });

                // Add to playlist at exact contiguous position
                // Idempotently upsert playlist item at (playlistId, position)
                await prisma.playlistItem.upsert({
                  where: {
                    playlistId_position: {
                      playlistId,
                      position: currentPosition,
                    },
                  },
                  create: {
                    playlistId,
                    trackId: canonicalTrack.id,
                    position: currentPosition,
                    addedAt: item.added_at ? new Date(item.added_at) : new Date(),
                  },
                  update: {
                    trackId: canonicalTrack.id,
                  },
                });

                playlistItemsImported++;
                checkpoint.totalProcessed++;

                await logOp(
                  "PLAYLIST_ITEM",
                  `${normalizedPlaylist.externalId}:${currentPosition}`,
                  SyncOperationAction.MATCHED,
                  SyncOperationStatus.SUCCESS,
                  canonicalTrack.id
                );
              } catch (err: unknown) {
                checkpoint.totalFailed++;
                console.error(
                  `Failed to import playlist item at position ${currentPosition} for playlist ${normalizedPlaylist.externalId}:`,
                  err
                );
                await logOp(
                  "PLAYLIST_ITEM",
                  `${normalizedPlaylist.externalId}:${currentPosition}`,
                  SyncOperationAction.FAILED,
                  SyncOperationStatus.ERROR,
                  undefined,
                  err instanceof Error ? err.message : String(err)
                );
              }

              currentPosition++;
            }

            tracksOffset += tracksPage.items.length;
            checkpoint.playlistTracksOffset = tracksOffset;
            hasMorePlaylistTracks = tracksPage.next !== null;

            await saveCheckpoint();
          }

          // Reset playlist tracks offset for next playlist
          checkpoint.playlistTracksOffset = 0;
          checkpoint.playlistIndex++;
          await saveCheckpoint();

          if (onProgress) {
            await onProgress({
              stage: `Playlist: ${normalizedPlaylist.title}`,
              processed: checkpoint.totalProcessed,
              failed: checkpoint.totalFailed,
              skipped: checkpoint.totalSkipped,
            });
          }
        }

        playlistsOffset += playlistsPage.items.length;
        hasMorePlaylists = playlistsPage.next !== null;
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

export const spotifyImporter = new SpotifyImporterService();
