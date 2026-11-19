import { prisma } from "@/lib/db";
import {
  ProviderType,
  SyncJob,
  SyncJobStatus,
  SyncJobType,
  SyncOperationAction,
  SyncOperationStatus,
  TrackMatchReviewStatus,
} from "@prisma/client";
import {
  NotFoundError,
  ForbiddenError,
  ValidationError,
} from "@/modules/common/errors";
import {
  createDestinationPlaylist as createSpotifyPlaylist,
  addTracksToDestinationPlaylist as addSpotifyTracks,
  verifyDestinationPlaylist as verifySpotifyPlaylist,
  saveTracksToUserLibrary as saveSpotifyLikedTracks,
  getDestinationPlaylistTrackUris as getSpotifyPlaylistTracks,
} from "@/modules/providers/spotify/spotify-writer.service";
import {
  createLibraryPlaylist as createApplePlaylist,
  addTracksToLibraryPlaylist as addAppleTracks,
  verifyLibraryPlaylist as verifyApplePlaylist,
  saveTracksToAppleLibrary as saveAppleLikedTracks,
  getLibraryPlaylistTrackIds as getApplePlaylistTracks,
} from "@/modules/providers/apple/apple-writer.service";

export interface MigrationPreviewItem {
  canonicalTrackId: string;
  title: string;
  artistName: string;
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  matchStatus: "EXACT" | "HIGH" | "NEEDS_REVIEW" | "UNMATCHED";
  confidence: number;
  matchedDestinationId?: string | null;
  conflictReason?: string | null;
}

export interface LikedSongsPreviewSummary {
  total: number;
  matched: number;
  unmatched: number;
  destinationSemantic: string;
  requiredScope: string;
  warningNote?: string;
  untransferableItems: Array<{
    title: string;
    artistName: string;
    reason: string;
  }>;
}

export interface MigrationPreviewPlan {
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  totalItems: number;
  exactMatchesCount: number;
  highConfidenceCount: number;
  needsReviewCount: number;
  unmatchedCount: number;
  estimatedDurationSeconds: number;
  playlists: Array<{ id: string; title: string; trackCount: number }>;
  includesLikedSongs: boolean;
  likedSongsSummary?: LikedSongsPreviewSummary;
  sampleItems: MigrationPreviewItem[];
}

export interface CreateMigrationJobInput {
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  playlistIds?: string[];
  migrateLikedSongs?: boolean;
  confirmed: boolean;
  userPreferences?: {
    preserveDuplicates?: boolean;
    autoResolveHighConfidence?: boolean;
  };
}

export interface MigrationJobPayload {
  syncJobId: string;
  userId: string;
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  playlistIds: string[];
  migrateLikedSongs: boolean;
}

export interface PlaylistPrefixVerification {
  valid: boolean;
  resumableIndex: number;
  existingCount: number;
  intendedCount: number;
  error?: string;
}

/**
 * Validates the existing destination playlist items against the intended source prefix.
 *
 * Guarantees:
 * 1. Checks item identities in exact ordered positions: destination[i] === intended[i].
 * 2. Compares provider track identities and strictly preserves duplicate occurrences.
 * 3. Confirms ordering, not merely membership or count.
 * 4. Rejects if destination has more items than intended (K > N).
 * 5. Rejects immediately on any out-of-order item, foreign track, or mismatched duplicate.
 * 6. Resumes only after verifying the prefix, returning resumableIndex K.
 */
export function verifyPlaylistPrefix(
  existingItems: string[],
  intendedItems: string[]
): PlaylistPrefixVerification {
  const K = existingItems.length;
  const N = intendedItems.length;

  if (K > N) {
    return {
      valid: false,
      resumableIndex: 0,
      existingCount: K,
      intendedCount: N,
      error: `Destination playlist contains ${K} items, exceeding intended total of ${N} tracks. Destination may contain unexpected additions or foreign items.`,
    };
  }

  for (let i = 0; i < K; i++) {
    const existing = existingItems[i];
    const intended = intendedItems[i];

    if (existing !== intended) {
      return {
        valid: false,
        resumableIndex: i,
        existingCount: K,
        intendedCount: N,
        error: `Destination playlist item mismatch at position ${i}: expected intended track '${intended}', but destination contains '${existing}'. Ordering, track identity, or duplicate occurrence differs.`,
      };
    }
  }

  return {
    valid: true,
    resumableIndex: K,
    existingCount: K,
    intendedCount: N,
  };
}

/**
 * Validates that user has active connected provider accounts for both source and destination.
 */
async function assertConnectedAccounts(
  userId: string,
  sourceProvider: ProviderType,
  destinationProvider: ProviderType
) {
  const [sourceAcc, destAcc] = await Promise.all([
    prisma.providerAccount.findFirst({
      where: { userId, provider: sourceProvider, status: "CONNECTED" },
    }),
    prisma.providerAccount.findFirst({
      where: { userId, provider: destinationProvider, status: "CONNECTED" },
    }),
  ]);

  if (!sourceAcc) {
    throw new ForbiddenError(
      `Source provider ${sourceProvider} is not connected. Please connect it first.`
    );
  }
  if (!destAcc) {
    throw new ForbiddenError(
      `Destination provider ${destinationProvider} is not connected. Please connect it first.`
    );
  }

  return { sourceAcc, destAcc };
}

/**
 * Generates an idempotent, read-only preview of the migration without mutating destination services.
 */
export async function generateMigrationPreview(
  userId: string,
  input: {
    sourceProvider: ProviderType;
    destinationProvider: ProviderType;
    playlistIds?: string[];
    migrateLikedSongs?: boolean;
  }
): Promise<MigrationPreviewPlan> {
  const { sourceProvider, destinationProvider, playlistIds = [], migrateLikedSongs = false } = input;

  if (sourceProvider === destinationProvider) {
    throw new ValidationError("Source and destination providers must be different.");
  }

  await assertConnectedAccounts(userId, sourceProvider, destinationProvider);

  // 1. Fetch targeted playlists
  const playlists = await prisma.playlist.findMany({
    where: {
      id: { in: playlistIds },
      library: { userId },
      deletedAt: null,
    },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          track: {
            include: {
              matches: {
                include: { providerTrack: true },
              },
            },
          },
        },
      },
    },
  });

  // 2. Fetch liked songs if requested
  const likedTracks = migrateLikedSongs
    ? await prisma.libraryTrack.findMany({
        where: { library: { userId } },
        include: {
          track: {
            include: {
              matches: {
                include: { providerTrack: true },
              },
            },
          },
        },
      })
    : [];

  const previewItems: MigrationPreviewItem[] = [];
  let exactCount = 0;
  let highCount = 0;
  let needsReviewCount = 0;
  let unmatchedCount = 0;

  interface TrackWithMatches {
    id: string;
    title: string;
    artistName: string;
    matches?: Array<{
      matchConfidence: number;
      reviewStatus: TrackMatchReviewStatus;
      conflictReason: string | null;
      providerTrack: {
        provider: ProviderType;
        externalId: string;
      } | null;
    }>;
  }

  // Helper to categorize track match against destination provider
  const processTrack = (track: TrackWithMatches) => {
    // Find if track has an existing match for the destination provider
    const destMatch = track.matches?.find(
      (m) => m.providerTrack?.provider === destinationProvider
    );

    let matchStatus: "EXACT" | "HIGH" | "NEEDS_REVIEW" | "UNMATCHED";
    let confidence = 0;
    let matchedDestinationId: string | null = null;
    let conflictReason: string | null = null;

    if (!destMatch) {
      matchStatus = "UNMATCHED";
      unmatchedCount++;
    } else {
      confidence = destMatch.matchConfidence;
      matchedDestinationId = destMatch.providerTrack?.externalId || null;
      conflictReason = destMatch.conflictReason;

      if (
        destMatch.reviewStatus === TrackMatchReviewStatus.NEEDS_REVIEW ||
        destMatch.conflictReason !== null
      ) {
        matchStatus = "NEEDS_REVIEW";
        needsReviewCount++;
      } else if (confidence >= 0.95) {
        matchStatus = "EXACT";
        exactCount++;
      } else if (confidence >= 0.82) {
        matchStatus = "HIGH";
        highCount++;
      } else {
        matchStatus = "NEEDS_REVIEW";
        needsReviewCount++;
      }
    }

    previewItems.push({
      canonicalTrackId: track.id,
      title: track.title,
      artistName: track.artistName,
      sourceProvider,
      destinationProvider,
      matchStatus,
      confidence,
      matchedDestinationId,
      conflictReason,
    });
  };

  for (const pl of playlists) {
    for (const item of pl.items) {
      processTrack(item.track);
    }
  }

  for (const lt of likedTracks) {
    processTrack(lt.track);
  }

  let likedSongsSummary: LikedSongsPreviewSummary | undefined;

  if (migrateLikedSongs) {
    let likedMatched = 0;
    let likedUnmatched = 0;
    const untransferableItems: Array<{ title: string; artistName: string; reason: string }> = [];

    for (const lt of likedTracks) {
      const destMatch = lt.track.matches?.find(
        (m) => m.providerTrack?.provider === destinationProvider
      );
      if (
        destMatch?.providerTrack?.externalId &&
        destMatch.reviewStatus !== TrackMatchReviewStatus.REJECTED
      ) {
        likedMatched++;
      } else {
        likedUnmatched++;
        untransferableItems.push({
          title: lt.track.title,
          artistName: lt.track.artistName,
          reason: "No matched catalog track found on destination provider",
        });
      }
    }

    const destinationSemantic =
      destinationProvider === ProviderType.SPOTIFY
        ? "Spotify 'Liked Songs' collection (PUT /v1/me/library?uris=...)"
        : "Apple Music Cloud Library (POST /v1/me/library?ids[songs]=...)";

    const requiredScope =
      destinationProvider === ProviderType.SPOTIFY
        ? "user-library-modify"
        : "MusicKit Music-User-Token (Cloud Library write)";

    const warningNote =
      destinationProvider === ProviderType.APPLE_MUSIC
        ? "Note: Apple Music Cloud Library addition is distinct from track ratings (Favorites/Love). MusicKit adds songs to your library without altering star/favorite ratings."
        : undefined;

    likedSongsSummary = {
      total: likedTracks.length,
      matched: likedMatched,
      unmatched: likedUnmatched,
      destinationSemantic,
      requiredScope,
      warningNote,
      untransferableItems: untransferableItems.slice(0, 20),
    };
  }

  const totalItems = previewItems.length;
  // Estimate ~1.2s per 50 tracks plus playlist creation overhead
  const estimatedDurationSeconds = Math.max(5, Math.ceil(totalItems * 0.25) + playlists.length * 2);

  return {
    sourceProvider,
    destinationProvider,
    totalItems,
    exactMatchesCount: exactCount,
    highConfidenceCount: highCount,
    needsReviewCount,
    unmatchedCount,
    estimatedDurationSeconds,
    playlists: playlists.map((p) => ({
      id: p.id,
      title: p.title,
      trackCount: p.items.length,
    })),
    includesLikedSongs: migrateLikedSongs,
    likedSongsSummary,
    sampleItems: previewItems.slice(0, 20),
  };
}

/**
 * Creates a durable migration SyncJob guarded by the explicit confirmation gate.
 */
export async function createMigrationJob(
  userId: string,
  input: CreateMigrationJobInput
): Promise<SyncJob> {
  // STRICT EXPLICIT CONFIRMATION GATE
  if (!input.confirmed) {
    throw new ValidationError(
      "Migration execution requires explicit user confirmation. Inspect preview before executing."
    );
  }

  const { sourceProvider, destinationProvider, playlistIds = [], migrateLikedSongs = false } = input;

  if (sourceProvider === destinationProvider) {
    throw new ValidationError("Source and destination providers must be different.");
  }

  await assertConnectedAccounts(userId, sourceProvider, destinationProvider);

  // Check for existing running migration job for this user
  const activeJob = await prisma.syncJob.findFirst({
    where: {
      userId,
      jobType: SyncJobType.EXPORT,
      status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] },
    },
  });

  if (activeJob) {
    throw new ValidationError("A migration job is already currently in progress for this account.");
  }

  // Count items to migrate
  const playlists = await prisma.playlist.findMany({
    where: { id: { in: playlistIds }, library: { userId }, deletedAt: null },
    include: { _count: { select: { items: true } } },
  });

  let totalItemsCount = playlists.reduce((acc, p) => acc + p._count.items, 0);

  if (migrateLikedSongs) {
    const likedCount = await prisma.libraryTrack.count({
      where: { library: { userId } },
    });
    totalItemsCount += likedCount;
  }

  return await prisma.$transaction(async (tx) => {
    // 1. Create durable SyncJob
    const job = await tx.syncJob.create({
      data: {
        userId,
        jobType: SyncJobType.EXPORT,
        sourceProvider,
        targetProvider: destinationProvider,
        status: SyncJobStatus.QUEUED,
        confirmedAt: new Date(),
        totalItems: totalItemsCount,
        processedItems: 0,
        failedItems: 0,
      },
    });

    // 2. Create pending SyncOperation records for each playlist
    for (const pl of playlists) {
      await tx.syncOperation.create({
        data: {
          syncJobId: job.id,
          itemType: "PLAYLIST",
          sourceId: pl.id,
          action: SyncOperationAction.CREATED,
          status: SyncOperationStatus.WARNING,
        },
      });
    }

    if (migrateLikedSongs) {
      await tx.syncOperation.create({
        data: {
          syncJobId: job.id,
          itemType: "LIKED_SONGS",
          sourceId: `liked_${userId}`,
          action: SyncOperationAction.CREATED,
          status: SyncOperationStatus.WARNING,
        },
      });
    }

    // 3. Emit transactional outbox event
    await tx.outboxEvent.create({
      data: {
        eventType: "MIGRATION_JOB_DISPATCH",
        payload: {
          syncJobId: job.id,
          userId,
          sourceProvider,
          destinationProvider,
          playlistIds,
          migrateLikedSongs,
        },
      },
    });

    return job;
  });
}

/**
 * Worker execution handler for MIGRATION_JOB_DISPATCH outbox events.
 * Executes batches with checkpoint resumption, per-item accounting, and cancellation checks.
 */
export async function executeMigrationJob(payload: unknown): Promise<void> {
  const data = payload as MigrationJobPayload;
  if (!data?.syncJobId || !data?.userId) {
    throw new ValidationError("Invalid migration job payload: missing syncJobId or userId");
  }

  const { syncJobId, userId, destinationProvider, playlistIds = [], migrateLikedSongs = false } = data;

  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
  });

  if (!job) {
    throw new NotFoundError("SyncJob", syncJobId);
  }

  // Check cancellation before start
  if (job.cancelledAt || job.status === SyncJobStatus.CANCELLED) {
    return;
  }

  // Update status to RUNNING
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: SyncJobStatus.RUNNING, startedAt: new Date() },
  });

  let processedCount = job.processedItems;
  let failedCount = job.failedItems;

  try {
    // 1. Process Playlists
    for (const playlistId of playlistIds) {
      // Check cancellation checkpoint before each playlist
      const checkJob = await prisma.syncJob.findUnique({
        where: { id: syncJobId },
        select: { cancelledAt: true, status: true },
      });
      if (checkJob?.cancelledAt || checkJob?.status === SyncJobStatus.CANCELLED) {
        return;
      }

      const playlist = await prisma.playlist.findUnique({
        where: { id: playlistId },
        include: {
          items: {
            orderBy: { position: "asc" },
            include: {
              track: {
                include: {
                  matches: {
                    where: { reviewStatus: { not: TrackMatchReviewStatus.REJECTED } },
                    include: { providerTrack: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!playlist) continue;

      const validUris: string[] = [];
      const validAppleSongIds: string[] = [];

      for (const item of playlist.items) {
        const destMatch = item.track.matches.find(
          (m) => m.providerTrack.provider === destinationProvider
        );

        if (destMatch && destMatch.providerTrack) {
          if (destinationProvider === ProviderType.SPOTIFY) {
            validUris.push(destMatch.providerTrack.providerUri || `spotify:track:${destMatch.providerTrack.externalId}`);
          } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
            validAppleSongIds.push(destMatch.providerTrack.externalId);
          }
        } else {
          failedCount++;
        }
      }

      // Check if playlist operation was already started or completed
      const existingOp = await prisma.syncOperation.findFirst({
        where: {
          syncJobId,
          itemType: "PLAYLIST",
          sourceId: playlistId,
        },
      });

      if (existingOp?.status === SyncOperationStatus.SUCCESS) {
        // Already successfully transferred in a prior execution cycle, skip safely
        continue;
      }

      const wasAlreadyCreated = Boolean(existingOp?.targetId);
      let createdExternalId = existingOp?.targetId || "";

      // 1. Create destination playlist if not already created in a previous attempt
      if (!createdExternalId) {
        if (destinationProvider === ProviderType.SPOTIFY) {
          const created = await createSpotifyPlaylist(
            userId,
            playlist.title,
            playlist.description || undefined
          );
          createdExternalId = created.externalId;
        } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
          const created = await createApplePlaylist(
            userId,
            playlist.title,
            playlist.description || undefined
          );
          createdExternalId = created.externalId;
        }

        // Immediately persist targetId checkpoint in database so retry never creates duplicate playlist!
        await prisma.syncOperation.updateMany({
          where: {
            syncJobId,
            itemType: "PLAYLIST",
            sourceId: playlistId,
          },
          data: {
            targetId: createdExternalId,
          },
        });
      }

      // Determine intended ordered items for this playlist
      const intendedItems = destinationProvider === ProviderType.SPOTIFY ? validUris : validAppleSongIds;

      // 2. Safe Prefix Recovery Algorithm:
      // Reads actual ordered destination items, compares prefix, preserves duplicates and order,
      // and resumes from resumableIndex K if and only if destination[0..K-1] is verified.
      let resumableIndex = 0;
      if (wasAlreadyCreated) {
        let existingItems: string[] = [];
        try {
          if (destinationProvider === ProviderType.SPOTIFY) {
            existingItems = await getSpotifyPlaylistTracks(userId, createdExternalId);
          } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
            existingItems = await getApplePlaylistTracks(userId, createdExternalId);
          }
        } catch (readErr: unknown) {
          const readErrMsg = readErr instanceof Error ? readErr.message : "Failed to read destination playlist";
          await prisma.syncOperation.updateMany({
            where: {
              syncJobId,
              itemType: "PLAYLIST",
              sourceId: playlistId,
            },
            data: {
              status: SyncOperationStatus.ERROR,
              errorMessage: `Recovery halted: Destination playlist '${createdExternalId}' could not be read reliably (${readErrMsg}). Stopping for manual reconciliation to prevent corruption.`,
            },
          });
          failedCount += intendedItems.length;
          continue;
        }

        const prefixVerification = verifyPlaylistPrefix(existingItems, intendedItems);

        if (!prefixVerification.valid) {
          // Destination differs, has out-of-order items, or contains unexpected items -> Stop safely!
          await prisma.syncOperation.updateMany({
            where: {
              syncJobId,
              itemType: "PLAYLIST",
              sourceId: playlistId,
            },
            data: {
              status: SyncOperationStatus.ERROR,
              errorMessage: `Recovery halted: ${prefixVerification.error}. Manual reconciliation required to prevent playlist corruption.`,
            },
          });
          failedCount += intendedItems.length;
          continue;
        }

        resumableIndex = prefixVerification.resumableIndex;
      }

      // Account for items already verified in destination from a prior attempt before checkpoint
      const newlyAccounted = Math.max(0, resumableIndex - job.processedItems);
      processedCount += newlyAccounted;

      // 3. Append remaining items from verified resumableIndex
      let playlistVerificationStatus: "VERIFIED" | "ACCEPTED_PENDING" | "MISMATCH" = "VERIFIED";
      let verifyError: string | null = null;

      if (destinationProvider === ProviderType.SPOTIFY) {
        const remainingUris = validUris.slice(resumableIndex);
        if (remainingUris.length > 0) {
          const writeRes = await addSpotifyTracks(userId, createdExternalId, remainingUris);
          processedCount += writeRes.addedCount;
          failedCount += writeRes.failedUris.length;

          // Read-back verification
          const verifyRes = await verifySpotifyPlaylist(userId, createdExternalId, validUris.length);
          if (!verifyRes.verified) {
            playlistVerificationStatus = "MISMATCH";
            verifyError = `Destination playlist verification incomplete: expected ${validUris.length} tracks, but read-back verified ${verifyRes.actualCount} tracks.`;
          }
        }
      } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
        const remainingAppleSongIds = validAppleSongIds.slice(resumableIndex);
        if (remainingAppleSongIds.length > 0) {
          const writeRes = await addAppleTracks(userId, createdExternalId, remainingAppleSongIds);
          processedCount += writeRes.addedCount;
          failedCount += writeRes.failedIds.length;

          // Read-back verification with propagation delay tolerance
          const verifyRes = await verifyApplePlaylist(userId, createdExternalId, validAppleSongIds.length);
          if (verifyRes.status === "ACCEPTED_PENDING") {
            playlistVerificationStatus = "ACCEPTED_PENDING";
            verifyError = `ACCEPTED_PENDING: Playlist tracks accepted by Apple Music (${verifyRes.actualCount}/${validAppleSongIds.length} tracks visible). Pending propagation across devices.`;
          } else if (!verifyRes.verified) {
            playlistVerificationStatus = "MISMATCH";
            verifyError = `Destination playlist verification incomplete: expected ${validAppleSongIds.length} tracks, but read-back verified ${verifyRes.actualCount} tracks.`;
          }
        }
      }

      // Record playlist operation status (ERROR if mismatch, WARNING if accepted/pending, SUCCESS if verified)
      let opStatus: SyncOperationStatus = SyncOperationStatus.SUCCESS;
      let opErrorMessage: string | null = null;

      if (playlistVerificationStatus === "MISMATCH") {
        opStatus = SyncOperationStatus.ERROR;
        opErrorMessage = verifyError;
      } else if (playlistVerificationStatus === "ACCEPTED_PENDING") {
        opStatus = SyncOperationStatus.WARNING;
        opErrorMessage = verifyError;
      }

      await prisma.syncOperation.updateMany({
        where: {
          syncJobId,
          itemType: "PLAYLIST",
          sourceId: playlistId,
        },
        data: {
          status: opStatus,
          targetId: createdExternalId,
          errorMessage: opErrorMessage,
        },
      });

      // Update incremental progress on SyncJob
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          processedItems: processedCount,
          failedItems: failedCount,
        },
      });
    }

    // 2. Process Liked Songs if requested
    if (migrateLikedSongs) {
      const checkJob = await prisma.syncJob.findUnique({
        where: { id: syncJobId },
        select: { cancelledAt: true, status: true },
      });
      if (checkJob?.cancelledAt || checkJob?.status === SyncJobStatus.CANCELLED) {
        return;
      }

      // Check if LIKED_SONGS operation was already completed (for idempotent retry)
      const existingOp = await prisma.syncOperation.findFirst({
        where: { syncJobId, itemType: "LIKED_SONGS" },
      });

      if (existingOp?.status !== SyncOperationStatus.SUCCESS) {
        const likedTracks = await prisma.libraryTrack.findMany({
          where: { library: { userId } },
          include: {
            track: {
              include: {
                matches: {
                  where: { reviewStatus: { not: TrackMatchReviewStatus.REJECTED } },
                  include: { providerTrack: true },
                },
              },
            },
          },
        });

        const destTrackIds: string[] = [];
        const untransferableItems: Array<{ id: string; title: string; reason: string }> = [];

        for (const lt of likedTracks) {
          const destMatch = lt.track.matches.find(
            (m) => m.providerTrack.provider === destinationProvider
          );
          if (destMatch?.providerTrack?.externalId) {
            destTrackIds.push(destMatch.providerTrack.externalId);
          } else {
            failedCount++;
            untransferableItems.push({
              id: lt.track.id,
              title: lt.track.title,
              reason: "No destination catalog match available",
            });
          }
        }

        // Deduplicate destination track IDs safely before writing
        const uniqueDestTrackIds = Array.from(new Set(destTrackIds));

        let appleSaveStatus: "ACCEPTED" | "VERIFIED" | "FAILED" | null = null;
        if (uniqueDestTrackIds.length > 0) {
          if (destinationProvider === ProviderType.SPOTIFY) {
            const saveRes = await saveSpotifyLikedTracks(userId, uniqueDestTrackIds);
            processedCount += saveRes.savedCount;
            failedCount += saveRes.failedIds.length;
          } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
            const saveRes = await saveAppleLikedTracks(userId, uniqueDestTrackIds);
            processedCount += saveRes.savedCount;
            failedCount += saveRes.failedIds.length;
            appleSaveStatus = saveRes.status;
          }
        }

        let opErrorMessage: string | null = null;
        let opStatus: SyncOperationStatus = SyncOperationStatus.SUCCESS;

        if (failedCount > 0 && processedCount === 0) {
          opStatus = SyncOperationStatus.ERROR;
          opErrorMessage = `${failedCount} items had no destination catalog match or failed write`;
        } else if (failedCount > 0) {
          opStatus = SyncOperationStatus.WARNING;
          opErrorMessage = `${failedCount} items had no destination catalog match or failed write`;
          if (appleSaveStatus === "ACCEPTED") {
            opErrorMessage += " (Apple Cloud Library status: ACCEPTED_PENDING - propagating across devices)";
          }
        } else if (appleSaveStatus === "ACCEPTED") {
          // Explicitly represented as ACCEPTED / PENDING (WARNING status in Prisma enum), NOT verified SUCCESS
          opStatus = SyncOperationStatus.WARNING;
          opErrorMessage = "ACCEPTED_PENDING: Accepted by Apple Music for Cloud Library ingestion (HTTP 202). Song membership is pending device propagation.";
        }

        await prisma.syncOperation.updateMany({
          where: {
            syncJobId,
            itemType: "LIKED_SONGS",
          },
          data: {
            status: opStatus,
            errorMessage: opErrorMessage,
          },
        });
      }
    }

    // Mark Job Completed, storing pending cloud sync checkpoint if applicable
    const hasPendingCloudSync = (job.checkpoint as Record<string, unknown> | null)?.pendingCloudLibrarySync === true;
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.COMPLETED,
        completedAt: new Date(),
        processedItems: processedCount,
        failedItems: failedCount,
        checkpoint: {
          ...((job.checkpoint as Record<string, unknown>) || {}),
          pendingCloudLibrarySync: hasPendingCloudSync,
        },
      },
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Migration job failed";
    // Record error state on SyncJob
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.FAILED,
        completedAt: new Date(),
        checkpoint: { error: errMsg },
        processedItems: processedCount,
        failedItems: failedCount,
      },
    });
    throw err;
  }
}

/**
 * Cancels an in-flight or queued migration job.
 */
export async function cancelMigrationJob(userId: string, syncJobId: string): Promise<SyncJob> {
  const job = await prisma.syncJob.findFirst({
    where: { id: syncJobId, userId },
  });

  if (!job) {
    throw new NotFoundError("SyncJob", syncJobId);
  }

  if (job.status === SyncJobStatus.COMPLETED) {
    throw new ValidationError("Cannot cancel an already completed migration job.");
  }

  return await prisma.syncJob.update({
    where: { id: syncJobId },
    data: {
      status: SyncJobStatus.CANCELLED,
      cancelledAt: new Date(),
    },
  });
}
