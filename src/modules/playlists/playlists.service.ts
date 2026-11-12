import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  NotFoundError,
  ValidationError,
} from "@/modules/common/errors";
import { getOrCreateUserLibrary, PaginationOptions, PaginatedResult } from "@/modules/library/library.service";

export type PlaylistWithCount = Prisma.PlaylistGetPayload<{
  include: {
    _count: {
      select: { items: true };
    };
  };
}>;

export interface CreatePlaylistInput {
  title: string;
  description?: string;
  isPublic?: boolean;
}

export interface UpdatePlaylistInput {
  title?: string;
  description?: string;
  isPublic?: boolean;
}

export interface AddPlaylistItemInput {
  trackId: string;
  position?: number;
  notes?: string;
}

/**
 * Asserts that the playlist exists and belongs to the given user's library.
 * Throws NotFoundError if the playlist does not exist or belongs to another user
 * to prevent leaking the existence of other users' resources (RULES.md Section 5).
 */
async function assertPlaylistOwnership(userId: string, playlistId: string) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: { library: true },
  });

  if (!playlist || playlist.deletedAt !== null) {
    throw new NotFoundError("Playlist", playlistId);
  }

  if (playlist.library.userId !== userId) {
    throw new NotFoundError("Playlist", playlistId);
  }

  return playlist;
}

/**
 * Lists paginated playlists belonging to the user's library.
 */
export async function getUserPlaylists(
  userId: string,
  options: PaginationOptions & { includeDeleted?: boolean } = {}
): Promise<PaginatedResult<PlaylistWithCount>> {
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

  const whereClause: Prisma.PlaylistWhereInput = {
    libraryId: library.id,
  };

  if (!options.includeDeleted) {
    whereClause.deletedAt = null;
  }

  if (options.search?.trim()) {
    whereClause.title = { contains: options.search.trim().slice(0, 100), mode: "insensitive" };
  }

  const [total, items] = await Promise.all([
    prisma.playlist.count({ where: whereClause }),
    prisma.playlist.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { items: true },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
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

/**
 * Retrieves a single playlist by ID with its ordered items.
 * Enforces ownership unless the playlist is marked public.
 * Throws NotFoundError if unauthorized to avoid leaking existence.
 */
export async function getPlaylistById(userId: string, playlistId: string) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      library: true,
      items: {
        orderBy: { position: "asc" },
        include: {
          track: true,
        },
      },
      providerPlaylists: true,
    },
  });

  if (!playlist || playlist.deletedAt !== null) {
    throw new NotFoundError("Playlist", playlistId);
  }

  if (playlist.library.userId !== userId && !playlist.isPublic) {
    throw new NotFoundError("Playlist", playlistId);
  }

  return playlist;
}

/**
 * Creates a new canonical playlist for the user.
 */
export async function createPlaylist(userId: string, input: CreatePlaylistInput) {
  if (!input.title?.trim()) {
    throw new ValidationError("Playlist title cannot be empty.");
  }

  const library = await getOrCreateUserLibrary(userId);

  return await prisma.playlist.create({
    data: {
      userId,
      libraryId: library.id,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      isPublic: input.isPublic ?? false,
    },
  });
}

/**
 * Updates playlist metadata.
 */
export async function updatePlaylist(
  userId: string,
  playlistId: string,
  input: UpdatePlaylistInput
) {
  await assertPlaylistOwnership(userId, playlistId);

  return await prisma.playlist.update({
    where: { id: playlistId },
    data: {
      title: input.title !== undefined ? input.title.trim() : undefined,
      description: input.description !== undefined ? input.description?.trim() || null : undefined,
      isPublic: input.isPublic !== undefined ? input.isPublic : undefined,
    },
  });
}

/**
 * Soft deletes a playlist (setting deletedAt timestamp) or permanently removes it.
 * Defaults to soft deletion to prevent destructive data loss.
 */
export async function deletePlaylist(
  userId: string,
  playlistId: string,
  options: { permanent?: boolean } = {}
) {
  await assertPlaylistOwnership(userId, playlistId);

  if (options.permanent) {
    await prisma.playlist.delete({
      where: { id: playlistId },
    });
  } else {
    await prisma.playlist.update({
      where: { id: playlistId },
      data: { deletedAt: new Date() },
    });
  }

  return { success: true };
}

/**
 * Adds an item to a playlist.
 * IMPORTANT: Multiple items in the same playlist MAY reference the same trackId!
 * Positions are contiguous and shifted atomically.
 */
export async function addPlaylistItem(
  userId: string,
  playlistId: string,
  input: AddPlaylistItemInput
) {
  await assertPlaylistOwnership(userId, playlistId);

  // Verify track exists
  const track = await prisma.track.findUnique({
    where: { id: input.trackId },
  });
  if (!track) {
    throw new NotFoundError("Track", input.trackId);
  }

  return await prisma.$transaction(async (tx) => {
    // Acquire row-level lock on playlist to serialize concurrent item additions/reorders
    await tx.$queryRaw`SELECT id FROM playlists WHERE id = ${playlistId} FOR UPDATE`;

    const existingCount = await tx.playlistItem.count({
      where: { playlistId },
    });

    // If target position is omitted or exceeds current count, append to end
    let targetPos = input.position ?? existingCount;
    if (targetPos < 0) targetPos = 0;
    if (targetPos > existingCount) targetPos = existingCount;

    // Shift existing items at or above targetPos by +1 (in descending order to prevent unique constraint collisions)
    if (targetPos < existingCount) {
      const itemsToShift = await tx.playlistItem.findMany({
        where: {
          playlistId,
          position: { gte: targetPos },
        },
        orderBy: { position: "desc" },
      });

      // Temporary negative shift to avoid collisions
      for (let i = 0; i < itemsToShift.length; i++) {
        await tx.playlistItem.update({
          where: { id: itemsToShift[i].id },
          data: { position: -(itemsToShift[i].position + 1000) },
        });
      }

      // Final positive shifted position
      for (let i = 0; i < itemsToShift.length; i++) {
        await tx.playlistItem.update({
          where: { id: itemsToShift[i].id },
          data: { position: itemsToShift[i].position + 1 },
        });
      }
    }

    const newItem = await tx.playlistItem.create({
      data: {
        playlistId,
        trackId: input.trackId,
        position: targetPos,
        notes: input.notes?.trim() || null,
      },
      include: {
        track: true,
      },
    });

    return newItem;
  });
}

/**
 * Removes an item from a playlist by item ID and shifts subsequent positions down.
 */
export async function removePlaylistItem(
  userId: string,
  playlistId: string,
  itemId: string
) {
  await assertPlaylistOwnership(userId, playlistId);

  return await prisma.$transaction(async (tx) => {
    // Acquire row-level lock on playlist to serialize concurrent item updates
    await tx.$queryRaw`SELECT id FROM playlists WHERE id = ${playlistId} FOR UPDATE`;

    const item = await tx.playlistItem.findFirst({
      where: { id: itemId, playlistId },
    });

    if (!item) {
      throw new NotFoundError("PlaylistItem", itemId);
    }

    const removedPos = item.position;

    // Delete the target item
    await tx.playlistItem.delete({
      where: { id: itemId },
    });

    // Shift down all subsequent items
    const itemsToShift = await tx.playlistItem.findMany({
      where: {
        playlistId,
        position: { gt: removedPos },
      },
      orderBy: { position: "asc" },
    });

    for (let i = 0; i < itemsToShift.length; i++) {
      await tx.playlistItem.update({
        where: { id: itemsToShift[i].id },
        data: { position: -(i + 1) },
      });
    }

    for (let i = 0; i < itemsToShift.length; i++) {
      await tx.playlistItem.update({
        where: { id: itemsToShift[i].id },
        data: { position: itemsToShift[i].position - 1 },
      });
    }

    return { success: true };
  });
}

/**
 * Atomically reorders playlist items.
 * Takes an array of PlaylistItem IDs in desired sequence order [id0, id1, id2, ...]
 * Preserves duplicate tracks cleanly because reordering operates strictly on unique PlaylistItem IDs.
 */
export async function reorderPlaylistItems(
  userId: string,
  playlistId: string,
  orderedItemIds: string[]
) {
  await assertPlaylistOwnership(userId, playlistId);

  // Validate duplicate IDs in input array
  const submittedSet = new Set(orderedItemIds);
  if (submittedSet.size !== orderedItemIds.length) {
    throw new ValidationError("Submitted item IDs contain duplicate entries.");
  }

  return await prisma.$transaction(async (tx) => {
    // Acquire row-level lock on playlist to serialize concurrent reorders
    await tx.$queryRaw`SELECT id FROM playlists WHERE id = ${playlistId} FOR UPDATE`;

    const currentItems = await tx.playlistItem.findMany({
      where: { playlistId },
      select: { id: true },
    });

    if (currentItems.length !== orderedItemIds.length) {
      throw new ValidationError(
        `Reorder list length (${orderedItemIds.length}) does not match playlist item count (${currentItems.length}).`
      );
    }

    const currentIdSet = new Set(currentItems.map((i) => i.id));
    for (const id of orderedItemIds) {
      if (!currentIdSet.has(id)) {
        throw new ValidationError(`PlaylistItem ID ${id} does not belong to playlist ${playlistId}.`);
      }
    }

    // Step 1: Assign temporary negative positions scoped by id and playlistId
    for (let idx = 0; idx < orderedItemIds.length; idx++) {
      const res = await tx.playlistItem.updateMany({
        where: { id: orderedItemIds[idx], playlistId },
        data: { position: -(idx + 1) },
      });
      if (res.count === 0) {
        throw new ValidationError(`Failed to stage position for item ${orderedItemIds[idx]}.`);
      }
    }

    // Step 2: Assign final positive sequential positions (0, 1, 2, ... N-1) scoped by id and playlistId
    for (let idx = 0; idx < orderedItemIds.length; idx++) {
      const res = await tx.playlistItem.updateMany({
        where: { id: orderedItemIds[idx], playlistId },
        data: { position: idx },
      });
      if (res.count === 0) {
        throw new ValidationError(`Failed to finalize position for item ${orderedItemIds[idx]}.`);
      }
    }

    return await tx.playlistItem.findMany({
      where: { playlistId },
      orderBy: { position: "asc" },
      include: { track: true },
    });
  });
}
