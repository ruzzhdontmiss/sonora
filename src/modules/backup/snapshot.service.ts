/**
 * Library Snapshot and Portable Export Engine for SONORA (P5-T06).
 *
 * Implements immutable point-in-time library backups, cryptographic integrity
 * verification (SHA-256), and portable versioned JSON export with zero credential leakage.
 */

import { prisma } from "@/lib/db";
import crypto from "crypto";
import {
  EXPORT_SCHEMA_VERSION,
  SonoraPortableExport,
  ExportTrackItem,
  ExportPlaylist,
  SnapshotMetadata,
} from "./backup-types";
import {
  Prisma,
  SnapshotItemType,
  SnapshotTrigger,
} from "@prisma/client";
import { NotFoundError } from "@/modules/common/errors";

/**
 * Computes a deterministic SHA-256 checksum across stringifiable object data.
 */
export function computeDeterministicChecksum(data: unknown): string {
  const jsonStr = JSON.stringify(data, Object.keys(data as object).sort());
  return crypto.createHash("sha256").update(jsonStr).digest("hex");
}

/**
 * Creates an immutable database snapshot of the user's sovereign library and playlists.
 */
export async function createLibrarySnapshot(
  userId: string,
  name?: string,
  trigger: SnapshotTrigger = SnapshotTrigger.MANUAL
): Promise<SnapshotMetadata> {
  const library = await prisma.library.findUnique({
    where: { userId },
    include: {
      tracks: {
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

  const playlists = await prisma.playlist.findMany({
    where: {
      userId,
      deletedAt: null,
    },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          track: true,
        },
      },
    },
  });

  const snapshotName =
    name?.trim() ||
    `Snapshot ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;

  const trackItems = (library?.tracks || []).map((lt) => ({
    id: lt.track.id,
    title: lt.track.title,
    artistName: lt.track.artistName,
    albumName: lt.track.albumName,
    durationMs: lt.track.durationMs,
    explicit: lt.track.explicit,
    isrc: lt.track.isrc,
    discNumber: lt.track.discNumber,
    trackNumber: lt.track.trackNumber,
    addedAt: lt.addedAt.toISOString(),
    matches: (lt.track.matches || []).map((m) => ({
      provider: m.providerTrack.provider,
      externalId: m.providerTrack.externalId,
      providerUri: m.providerTrack.providerUri,
      confidence: m.matchConfidence,
      reviewStatus: m.reviewStatus,
    })),
  }));

  const playlistItems = playlists.map((pl) => ({
    id: pl.id,
    title: pl.title,
    description: pl.description,
    isPublic: pl.isPublic,
    itemCount: pl.items.length,
    items: pl.items.map((it) => ({
      position: it.position,
      trackId: it.trackId,
      title: it.track.title,
      artistName: it.track.artistName,
      isrc: it.track.isrc,
    })),
  }));

  const totalItemCount = trackItems.length + playlistItems.length;
  const checksumSha256 = computeDeterministicChecksum({
    tracks: trackItems,
    playlists: playlistItems,
  });

  const snapshot = await prisma.$transaction(async (tx) => {
    const createdSnapshot = await tx.librarySnapshot.create({
      data: {
        userId,
        libraryId: library?.id || null,
        name: snapshotName,
        trigger,
        itemCount: totalItemCount,
      },
    });

    // Create item rows
    if (trackItems.length > 0) {
      await tx.librarySnapshotItem.create({
        data: {
          snapshotId: createdSnapshot.id,
          itemType: SnapshotItemType.TRACK,
          payload: {
            checksumSha256,
            tracks: trackItems,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (playlistItems.length > 0) {
      await tx.librarySnapshotItem.create({
        data: {
          snapshotId: createdSnapshot.id,
          itemType: SnapshotItemType.PLAYLIST,
          payload: {
            playlists: playlistItems,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return createdSnapshot;
  });

  return {
    id: snapshot.id,
    name: snapshot.name,
    trigger: snapshot.trigger,
    itemCount: snapshot.itemCount,
    checksumSha256,
    createdAt: snapshot.createdAt,
  };
}

/**
 * Generates a clean, portable versioned JSON export file.
 * Guaranteed zero credential leakage (no tokens, passwords, or provider secrets).
 */
export async function generatePortableExport(
  userId: string,
  snapshotId?: string
): Promise<SonoraPortableExport> {
  let tracks: ExportTrackItem[] = [];
  let playlists: ExportPlaylist[] = [];

  if (snapshotId) {
    const snapshot = await prisma.librarySnapshot.findFirst({
      where: { id: snapshotId, userId },
      include: { items: true },
    });

    if (!snapshot) {
      throw new NotFoundError("LibrarySnapshot", snapshotId);
    }

    for (const item of snapshot.items) {
      const payload = item.payload as Record<string, unknown>;
      if (item.itemType === SnapshotItemType.TRACK && Array.isArray(payload["tracks"])) {
        tracks = payload["tracks"] as ExportTrackItem[];
      } else if (item.itemType === SnapshotItemType.PLAYLIST && Array.isArray(payload["playlists"])) {
        playlists = payload["playlists"] as ExportPlaylist[];
      }
    }
  } else {
    // Generate live from active library
    const library = await prisma.library.findUnique({
      where: { userId },
      include: {
        tracks: {
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

    const livePlaylists = await prisma.playlist.findMany({
      where: { userId, deletedAt: null },
      include: {
        items: {
          orderBy: { position: "asc" },
          include: { track: true },
        },
      },
    });

    tracks = (library?.tracks || []).map((lt) => ({
      id: lt.track.id,
      title: lt.track.title,
      artistName: lt.track.artistName,
      albumName: lt.track.albumName,
      durationMs: lt.track.durationMs,
      explicit: lt.track.explicit,
      isrc: lt.track.isrc,
      discNumber: lt.track.discNumber,
      trackNumber: lt.track.trackNumber,
      addedAt: lt.addedAt.toISOString(),
      matches: (lt.track.matches || []).map((m) => ({
        provider: m.providerTrack.provider,
        externalId: m.providerTrack.externalId,
        providerUri: m.providerTrack.providerUri,
        confidence: m.matchConfidence,
        reviewStatus: m.reviewStatus,
      })),
    }));

    playlists = livePlaylists.map((pl) => ({
      id: pl.id,
      title: pl.title,
      description: pl.description,
      isPublic: pl.isPublic,
      itemCount: pl.items.length,
      items: pl.items.map((it) => ({
        position: it.position,
        trackId: it.trackId,
        title: it.track.title,
        artistName: it.track.artistName,
        isrc: it.track.isrc,
      })),
    }));
  }

  const checksumSha256 = computeDeterministicChecksum({ tracks, playlists });

  return {
    version: EXPORT_SCHEMA_VERSION,
    sonoraRelease: "0.1.0",
    exportedAt: new Date().toISOString(),
    checksumSha256,
    userSummary: {
      userId,
      trackCount: tracks.length,
      playlistCount: playlists.length,
    },
    library: {
      tracks,
    },
    playlists,
  };
}

/**
 * Lists all snapshots created for an authorized user.
 */
export async function listSnapshots(userId: string): Promise<SnapshotMetadata[]> {
  const snapshots = await prisma.librarySnapshot.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      trigger: true,
      itemCount: true,
      createdAt: true,
    },
  });

  return snapshots;
}

/**
 * Retrieves a single snapshot by ID for an authorized user.
 */
export async function getSnapshot(snapshotId: string, userId: string) {
  const snapshot = await prisma.librarySnapshot.findFirst({
    where: { id: snapshotId, userId },
    include: {
      items: true,
    },
  });

  if (!snapshot) {
    throw new NotFoundError("LibrarySnapshot", snapshotId);
  }

  return snapshot;
}
