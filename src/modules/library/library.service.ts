import { prisma } from "@/lib/db";
import { LibrarySourceProvenance, Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/modules/common/errors";
import {
  findOrCreateCanonicalTrack,
  persistProviderTrackMatch,
  ProviderTrackSource,
  TrackInput,
} from "@/modules/matching/track-matching.service";

export type LibraryTrackWithTrack = Prisma.LibraryTrackGetPayload<{
  include: { track: true };
}>;

export interface PaginationOptions {
  page?: number;
  limit?: number;
  search?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Retrieves the user's sovereign canonical library or creates one if it does not exist yet.
 */
export async function getOrCreateUserLibrary(userId: string) {
  const library = await prisma.library.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  return library;
}

/**
 * Retrieves paginated tracks from the user's canonical library.
 * Bounded query limits strictly enforce maximum memory footprint.
 */
export async function getLibraryTracks(
  userId: string,
  options: PaginationOptions = {}
): Promise<PaginatedResult<LibraryTrackWithTrack>> {
  const MAX_PAGE = 10000;
  const rawPage = options.page ?? 1;
  if (!Number.isFinite(rawPage) || rawPage < 1 || rawPage > MAX_PAGE) {
    throw new ValidationError(`Page parameter must be an integer between 1 and ${MAX_PAGE}.`);
  }

  const MAX_LIMIT = 100;
  const rawLimit = options.limit ?? 25;
  if (!Number.isFinite(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new ValidationError(`Limit parameter must be an integer between 1 and ${MAX_LIMIT}.`);
  }

  const page = Math.floor(rawPage);
  const limit = Math.floor(rawLimit);
  const skip = (page - 1) * limit;

  const library = await getOrCreateUserLibrary(userId);

  const whereClause: Prisma.LibraryTrackWhereInput = {
    libraryId: library.id,
  };

  if (options.search?.trim()) {
    const search = options.search.trim().slice(0, 100);
    whereClause.track = {
      OR: [
        { title: { contains: search, mode: "insensitive" } },
        { artistName: { contains: search, mode: "insensitive" } },
        { albumName: { contains: search, mode: "insensitive" } },
      ],
    };
  }

  const [total, items] = await Promise.all([
    prisma.libraryTrack.count({ where: whereClause }),
    prisma.libraryTrack.findMany({
      where: whereClause,
      include: {
        track: true,
      },
      orderBy: [{ addedAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
  ]);

  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

async function assertProviderAccountOwnershipIfSet(
  userId: string,
  providerSource: ProviderTrackSource | undefined,
  tx: Prisma.TransactionClient | typeof prisma
) {
  if (!providerSource?.providerAccountId) {
    return;
  }

  const account = await tx.providerAccount.findUnique({
    where: { id: providerSource.providerAccountId },
    select: { userId: true },
  });

  if (!account) {
    throw new NotFoundError("ProviderAccount", providerSource.providerAccountId);
  }
  if (account.userId !== userId) {
    throw new ForbiddenError("ProviderAccount does not belong to authenticated user.");
  }
}

/**
 * Adds a track to the user's canonical library.
 * If the track does not yet exist in the canonical catalog, it is deterministically matched or created.
 * When providerSource metadata is provided, durably persists ProviderTrack and TrackMatch
 * (including manual-review conflict status on ISRC contradictions).
 */
export async function addTrackToLibrary(
  userId: string,
  input: TrackInput & {
    sourceProvenance?: LibrarySourceProvenance;
    userNotes?: string;
    providerSource?: ProviderTrackSource;
  }
) {
  if (!input.title?.trim() || !input.artistName?.trim()) {
    throw new ValidationError("Track title and artistName are required.");
  }
  if (input.durationMs <= 0) {
    throw new ValidationError("Track duration must be greater than 0 ms.");
  }

  const library = await getOrCreateUserLibrary(userId);

  return await prisma.$transaction(async (tx) => {
    await assertProviderAccountOwnershipIfSet(userId, input.providerSource, tx);

    const resolution = await findOrCreateCanonicalTrack(input, tx);

    let providerMapping: Awaited<ReturnType<typeof persistProviderTrackMatch>> | undefined;
    if (input.providerSource) {
      providerMapping = await persistProviderTrackMatch(
        tx,
        resolution,
        input,
        input.providerSource
      );
    }

    const libraryTrack = await tx.libraryTrack.upsert({
      where: {
        libraryId_trackId: {
          libraryId: library.id,
          trackId: resolution.track.id,
        },
      },
      update: {
        userNotes: input.userNotes ?? undefined,
      },
      create: {
        libraryId: library.id,
        trackId: resolution.track.id,
        sourceProvenance: input.sourceProvenance ?? LibrarySourceProvenance.MANUAL,
        userNotes: input.userNotes,
      },
      include: {
        track: true,
      },
    });

    return {
      ...libraryTrack,
      matchResolution: resolution,
      providerMapping,
    };
  });
}

/**
 * Removes a track from the user's canonical library.
 * Does NOT delete the canonical Track from the global catalog, maintaining sovereignty and playlist integrity.
 */
export async function removeTrackFromLibrary(userId: string, trackId: string) {
  const library = await prisma.library.findUnique({
    where: { userId },
  });

  if (!library) {
    throw new NotFoundError("Library", userId);
  }

  const existing = await prisma.libraryTrack.findUnique({
    where: {
      libraryId_trackId: {
        libraryId: library.id,
        trackId,
      },
    },
  });

  if (!existing) {
    throw new NotFoundError("LibraryTrack", trackId);
  }

  await prisma.libraryTrack.delete({
    where: {
      libraryId_trackId: {
        libraryId: library.id,
        trackId,
      },
    },
  });

  return { success: true };
}

/**
 * Transactional batch import of tracks into the user's library.
 * Guarantees idempotency: re-running the same batch does not create duplicate entries.
 */
export async function importCanonicalTracks(
  userId: string,
  trackInputs: Array<
    TrackInput & {
      sourceProvenance?: LibrarySourceProvenance;
      userNotes?: string;
      providerSource?: ProviderTrackSource;
    }
  >
) {
  const library = await getOrCreateUserLibrary(userId);

  return await prisma.$transaction(async (tx) => {
    let addedCount = 0;
    let existingCount = 0;
    let newTracksCreated = 0;
    let conflictCount = 0;

    for (const input of trackInputs) {
      await assertProviderAccountOwnershipIfSet(userId, input.providerSource, tx);

      const resolution = await findOrCreateCanonicalTrack(input, tx);
      if (resolution.isNew) {
        newTracksCreated++;
      }
      if (resolution.isConflict) {
        conflictCount++;
      }

      if (input.providerSource) {
        await persistProviderTrackMatch(
          tx,
          resolution,
          input,
          input.providerSource
        );
      }

      const existingInLibrary = await tx.libraryTrack.findUnique({
        where: {
          libraryId_trackId: {
            libraryId: library.id,
            trackId: resolution.track.id,
          },
        },
      });

      if (existingInLibrary) {
        existingCount++;
      } else {
        await tx.libraryTrack.upsert({
          where: {
            libraryId_trackId: {
              libraryId: library.id,
              trackId: resolution.track.id,
            },
          },
          update: {},
          create: {
            libraryId: library.id,
            trackId: resolution.track.id,
            sourceProvenance: input.sourceProvenance ?? LibrarySourceProvenance.MANUAL,
            userNotes: input.userNotes,
          },
        });
        addedCount++;
      }
    }

    return {
      totalProcessed: trackInputs.length,
      addedCount,
      existingCount,
      newTracksCreated,
      conflictCount,
    };
  });
}
