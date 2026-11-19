import { prisma } from "@/lib/db";
import {
  NormalizedTrack,
  NormalizedPlaylist,
} from "../contracts/types";
import {
  getValidAppleMusicUserToken,
} from "./apple-auth.service";
import {
  getAppleDeveloperToken,
} from "./apple-token.service";
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

const APPLE_MUSIC_API_BASE = "https://api.music.apple.com/v1";

export interface AppleMusicPagingObject<T> {
  data: T[];
  next?: string;
}

export interface AppleMusicSongRaw {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
    trackNumber?: number;
    discNumber?: number;
    contentRating?: string;
    releaseDate?: string;
  };
}

export interface AppleMusicPlaylistRaw {
  id: string;
  type: string;
  attributes?: {
    name?: string;
    description?: {
      standard?: string;
    };
    isPublic?: boolean;
    hasCatalog?: boolean;
  };
  relationships?: {
    tracks?: {
      data?: AppleMusicSongRaw[];
    };
  };
}

export interface AppleImportCheckpoint {
  stage: "SONGS" | "PLAYLISTS" | "COMPLETED";
  songsOffset: number;
  playlistIndex: number;
  playlistTracksOffset: number;
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
}

export interface AppleImportResult {
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
  songsImported: number;
  playlistsImported: number;
  playlistItemsImported: number;
}

/**
 * Executes an Apple Music API request with developer and user tokens,
 * supporting bounded retries and exponential backoff with jitter on HTTP 429.
 */
export async function appleMusicFetch<T>(
  url: string,
  developerToken: string,
  musicUserToken: string,
  attempt = 1
): Promise<T> {
  const maxAttempts = 3;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Music-User-Token": musicUserToken,
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : Math.pow(2, attempt);
      const waitMs = Math.min(Math.max(1, retryAfterSec) * 1000, 30000);

      if (attempt < maxAttempts) {
        console.warn(`⏳ [Apple Music] 429 Rate limit. Backing off for ${waitMs}ms before retry ${attempt + 1}...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return appleMusicFetch<T>(url, developerToken, musicUserToken, attempt + 1);
      }

      throw new ProviderRateLimitError("APPLE_MUSIC", retryAfterSec);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthenticationError(
        "APPLE_MUSIC",
        `Apple Music access rejected (HTTP ${res.status}). User token may be expired or subscription inactive.`
      );
    }

    if (res.status >= 500 && attempt < maxAttempts) {
      const jitterMs = Math.floor(Math.random() * 500);
      const backoffMs = Math.pow(2, attempt) * 1000 + jitterMs;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return appleMusicFetch<T>(url, developerToken, musicUserToken, attempt + 1);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new ProviderError(
        "APPLE_MUSIC",
        `Request failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`
      );
    }

    return (await res.json()) as T;
  } catch (err: unknown) {
    if (err instanceof ProviderError) throw err;
    if (attempt < maxAttempts) {
      const backoffMs = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return appleMusicFetch<T>(url, developerToken, musicUserToken, attempt + 1);
    }
    throw new ProviderError(
      "APPLE_MUSIC",
      `Network failure connecting to Apple Music: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Normalizes an Apple Music song into SONORA's canonical format.
 */
export function normalizeAppleTrack(song: AppleMusicSongRaw | null): NormalizedTrack | null {
  if (!song || !song.id) {
    return null;
  }

  const attrs = song.attributes;
  const isrc = attrs?.isrc ? attrs.isrc.trim().toUpperCase() : null;
  const title = attrs?.name || "Untitled Track";
  const artistName = attrs?.artistName || "Unknown Artist";
  const albumName = attrs?.albumName || null;
  const durationMs = attrs?.durationInMillis || 0;
  const explicit = attrs?.contentRating === "explicit";

  return {
    externalId: song.id,
    isrc: isrc && isrc.length > 0 ? isrc : null,
    title,
    artistName,
    albumName,
    durationMs,
    explicit,
    discNumber: attrs?.discNumber ?? 1,
    trackNumber: attrs?.trackNumber ?? null,
    rawMetadata: {
      appleId: song.id,
      releaseDate: attrs?.releaseDate,
    },
  };
}

/**
 * Normalizes an Apple Music playlist into SONORA's canonical format.
 */
export function normalizeApplePlaylist(playlist: AppleMusicPlaylistRaw): NormalizedPlaylist {
  return {
    externalId: playlist.id,
    title: playlist.attributes?.name || "Untitled Playlist",
    description: playlist.attributes?.description?.standard || null,
    isPublic: playlist.attributes?.isPublic ?? false,
    itemCount: playlist.relationships?.tracks?.data?.length || 0,
    rawMetadata: {
      appleId: playlist.id,
      hasCatalog: playlist.attributes?.hasCatalog,
    },
  };
}

export class AppleMusicImporterService {
  /**
   * Fetches paginated user library songs.
   */
  public async fetchLibrarySongsPage(
    developerToken: string,
    musicUserToken: string,
    offset = 0,
    limit = 100
  ): Promise<AppleMusicPagingObject<AppleMusicSongRaw>> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/songs?limit=${limit}&offset=${offset}`;
    return appleMusicFetch<AppleMusicPagingObject<AppleMusicSongRaw>>(
      url,
      developerToken,
      musicUserToken
    );
  }

  /**
   * Fetches paginated user library playlists.
   */
  public async fetchLibraryPlaylistsPage(
    developerToken: string,
    musicUserToken: string,
    offset = 0,
    limit = 100
  ): Promise<AppleMusicPagingObject<AppleMusicPlaylistRaw>> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists?limit=${limit}&offset=${offset}`;
    return appleMusicFetch<AppleMusicPagingObject<AppleMusicPlaylistRaw>>(
      url,
      developerToken,
      musicUserToken
    );
  }

  /**
   * Fetches items for an Apple Music library playlist.
   */
  public async fetchPlaylistTracksPage(
    developerToken: string,
    musicUserToken: string,
    playlistId: string,
    offset = 0,
    limit = 100
  ): Promise<AppleMusicPagingObject<AppleMusicSongRaw>> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}`;
    return appleMusicFetch<AppleMusicPagingObject<AppleMusicSongRaw>>(
      url,
      developerToken,
      musicUserToken
    );
  }

  /**
   * Imports an authorized user's Apple Music library and playlists.
   */
  public async importLibrary(options: {
    userId: string;
    providerAccountId: string;
    syncJobId?: string;
    checkpoint?: AppleImportCheckpoint;
    onProgress?: (progress: { stage: string; processed: number; failed: number; skipped: number }) => Promise<void>;
  }): Promise<AppleImportResult> {
    const { userId, providerAccountId, syncJobId, onProgress } = options;

    const developerToken = await getAppleDeveloperToken();
    const musicUserToken = await getValidAppleMusicUserToken(providerAccountId, userId);

    const checkpoint: AppleImportCheckpoint = options.checkpoint || {
      stage: "SONGS",
      songsOffset: 0,
      playlistIndex: 0,
      playlistTracksOffset: 0,
      totalProcessed: 0,
      totalFailed: 0,
      totalSkipped: 0,
    };

    let songsImported = 0;
    let playlistsImported = 0;
    let playlistItemsImported = 0;

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
    // Stage 1: Library Songs
    // =========================================================================
    if (checkpoint.stage === "SONGS") {
      let hasMoreSongs = true;

      while (hasMoreSongs) {
        const page = await this.fetchLibrarySongsPage(
          developerToken,
          musicUserToken,
          checkpoint.songsOffset,
          100
        );

        if (!page.data || page.data.length === 0) {
          hasMoreSongs = false;
          break;
        }

        for (const item of page.data) {
          const normalized = normalizeAppleTrack(item);

          if (!normalized) {
            checkpoint.totalSkipped++;
            await logOp(
              "TRACK",
              item.id || "unknown",
              SyncOperationAction.SKIPPED,
              SyncOperationStatus.WARNING,
              undefined,
              "Skipped unavailable Apple Music track."
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
              sourceProvenance: LibrarySourceProvenance.APPLE_MUSIC_IMPORT,
              providerSource: {
                provider: ProviderType.APPLE_MUSIC,
                externalId: normalized.externalId,
                providerAccountId,
                rawMetadata: normalized.rawMetadata as unknown as Prisma.InputJsonValue,
              },
            });

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
            songsImported++;

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
            console.error(`Failed to import Apple Music track [${normalized.externalId}]:`, err);
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

        checkpoint.songsOffset += page.data.length;
        hasMoreSongs = Boolean(page.next);

        await saveCheckpoint();
        if (onProgress) {
          await onProgress({
            stage: "Library Songs",
            processed: checkpoint.totalProcessed,
            failed: checkpoint.totalFailed,
            skipped: checkpoint.totalSkipped,
          });
        }
      }

      checkpoint.stage = "PLAYLISTS";
      checkpoint.playlistIndex = 0;
      checkpoint.playlistTracksOffset = 0;
      await saveCheckpoint();
    }

    // =========================================================================
    // Stage 2: Library Playlists & Tracks
    // =========================================================================
    if (checkpoint.stage === "PLAYLISTS") {
      let hasMorePlaylists = true;
      let playlistsOffset = checkpoint.playlistIndex;

      const library = await prisma.library.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });

      while (hasMorePlaylists) {
        const playlistsPage = await this.fetchLibraryPlaylistsPage(
          developerToken,
          musicUserToken,
          playlistsOffset,
          100
        );

        if (!playlistsPage.data || playlistsPage.data.length === 0) {
          hasMorePlaylists = false;
          break;
        }

        for (const rawPlaylist of playlistsPage.data) {
          const normalizedPlaylist = normalizeApplePlaylist(rawPlaylist);

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

          // Fetch Playlist Tracks
          let hasMorePlaylistTracks = true;
          let tracksOffset = checkpoint.playlistTracksOffset;
          let currentPosition = tracksOffset;

          while (hasMorePlaylistTracks) {
            const tracksPage = await this.fetchPlaylistTracksPage(
              developerToken,
              musicUserToken,
              normalizedPlaylist.externalId,
              tracksOffset,
              100
            );

            if (!tracksPage.data || tracksPage.data.length === 0) {
              hasMorePlaylistTracks = false;
              break;
            }

            for (const item of tracksPage.data) {
              const normalizedTrack = normalizeAppleTrack(item);

              if (!normalizedTrack) {
                checkpoint.totalSkipped++;
                currentPosition++;
                continue;
              }

              try {
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
                      provider: ProviderType.APPLE_MUSIC,
                      externalId: normalizedTrack.externalId,
                      providerAccountId,
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
                      position: currentPosition,
                    },
                  },
                  create: {
                    playlistId,
                    trackId: canonicalTrack.id,
                    position: currentPosition,
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
                console.error(`Failed to import Apple Music playlist item at ${currentPosition}:`, err);
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

            tracksOffset += tracksPage.data.length;
            checkpoint.playlistTracksOffset = tracksOffset;
            hasMorePlaylistTracks = Boolean(tracksPage.next);

            await saveCheckpoint();
          }

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

        playlistsOffset += playlistsPage.data.length;
        hasMorePlaylists = Boolean(playlistsPage.next);
      }

      checkpoint.stage = "COMPLETED";
      await saveCheckpoint();
    }

    return {
      totalProcessed: checkpoint.totalProcessed,
      totalFailed: checkpoint.totalFailed,
      totalSkipped: checkpoint.totalSkipped,
      songsImported,
      playlistsImported,
      playlistItemsImported,
    };
  }
}

export const appleMusicImporter = new AppleMusicImporterService();
