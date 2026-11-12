import { prisma } from "@/lib/db";
import crypto from "crypto";
import {
  Track,
  ProviderTrack,
  TrackMatch,
  MatchMethod,
  ProviderType,
  TrackMatchReviewStatus,
  Prisma,
} from "@prisma/client";

export interface TrackInput {
  isrc?: string | null;
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  explicit?: boolean;
  discNumber?: number;
  trackNumber?: number | null;
}

export interface ProviderTrackSource {
  provider: ProviderType;
  externalId: string;
  providerAccountId?: string | null;
  providerUri?: string | null;
  rawMetadata?: Prisma.InputJsonValue;
}

export interface TrackMatchResolution {
  track: Track;
  isNew: boolean;
  matchMethod?: MatchMethod;
  isConflict?: boolean;
  conflictingTrackId?: string;
  conflictReason?: string;
}

export interface TrackVersionInfo {
  isLive: boolean;
  isRemix: boolean;
  isAcoustic: boolean;
  isRemastered: boolean;
  isInstrumental: boolean;
  isRadioEdit: boolean;
}

/**
 * Normalizes title and artist strings for deterministic matching comparison.
 * Strips punctuation, excess whitespace, and lowercases.
 */
export function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Inspects a track title for version-specific modifiers.
 * Ensures Live, Remix, Acoustic, Remastered, and Instrumental versions
 * are never conflated with original studio masters.
 */
export function extractVersionInfo(title: string): TrackVersionInfo {
  const lower = title.toLowerCase();
  return {
    isLive: /\b(live|concert|tour|unplugged)\b/i.test(lower),
    isRemix:
      /\b(remix|mix|bootleg|dub|rework|club mix|extended mix)\b/i.test(lower) &&
      !/\b(radio edit)\b/i.test(lower),
    isAcoustic: /\b(acoustic|unplugged|stripped)\b/i.test(lower),
    isRemastered: /\b(remaster|remastered|re-master|anniversary|deluxe)\b/i.test(lower),
    isInstrumental: /\b(instrumental|karaoke|backing track)\b/i.test(lower),
    isRadioEdit: /\b(radio edit|clean|censored)\b/i.test(lower),
  };
}

/**
 * Checks whether two tracks have matching version characteristics.
 */
export function areVersionTagsCompatible(
  infoA: TrackVersionInfo,
  infoB: TrackVersionInfo
): boolean {
  return (
    infoA.isLive === infoB.isLive &&
    infoA.isRemix === infoB.isRemix &&
    infoA.isAcoustic === infoB.isAcoustic &&
    infoA.isRemastered === infoB.isRemastered &&
    infoA.isInstrumental === infoB.isInstrumental &&
    infoA.isRadioEdit === infoB.isRadioEdit
  );
}

/**
 * Determines whether an incoming track has materially contradictory metadata
 * compared to an existing track matching the same ISRC.
 */
export function isMaterialContradiction(
  input: TrackInput,
  candidate: Track
): boolean {
  const normInputTitle = normalizeString(input.title);
  const normCandidateTitle = normalizeString(candidate.title);

  const normInputArtist = normalizeString(input.artistName);
  const normCandidateArtist = normalizeString(candidate.artistName);

  // 1. Material artist contradiction (different primary artist)
  if (normInputArtist !== normCandidateArtist) {
    return true;
  }

  // 2. Material title contradiction (completely different song title)
  if (normInputTitle !== normCandidateTitle) {
    return true;
  }

  // 3. Material duration contradiction (> 15,000ms difference)
  if (Math.abs(input.durationMs - candidate.durationMs) > 15000) {
    return true;
  }

  // 4. Material explicit contradiction (clean edit vs explicit version)
  if (candidate.explicit !== (input.explicit ?? false)) {
    return true;
  }

  // 5. Version tag contradiction (e.g. Live vs Studio, Remix vs Original)
  const inputVersion = extractVersionInfo(input.title);
  const candidateVersion = extractVersionInfo(candidate.title);
  if (!areVersionTagsCompatible(inputVersion, candidateVersion)) {
    return true;
  }

  return false;
}

/**
 * Creates a separate canonical Track without attaching the conflicting ISRC,
 * marking it durably for manual review so ambiguous tracks are never silently merged.
 */
async function createSeparatedConflictTrack(
  tx: Prisma.TransactionClient | typeof prisma,
  input: TrackInput,
  conflictingTrack: Track,
  cleanIsrc: string
): Promise<TrackMatchResolution> {
  const cleanTitle = input.title.trim();
  const cleanArtist = input.artistName.trim();
  const reason = `Material contradiction on ISRC ${cleanIsrc} against canonical track ${conflictingTrack.id} ("${conflictingTrack.artistName} - ${conflictingTrack.title}")`;

  const conflictTrack = await tx.track.create({
    data: {
      isrc: null, // Null to protect catalog uniqueness while flagged for review
      title: cleanTitle,
      artistName: cleanArtist,
      albumName: input.albumName?.trim() || null,
      durationMs: input.durationMs,
      explicit: input.explicit ?? false,
      discNumber: input.discNumber ?? 1,
      trackNumber: input.trackNumber ?? null,
      needsReview: true,
      conflictReason: reason,
    },
  });

  return {
    track: conflictTrack,
    isNew: true,
    matchMethod: MatchMethod.MANUAL_OVERRIDE,
    isConflict: true,
    conflictingTrackId: conflictingTrack.id,
    conflictReason: reason,
  };
}

/**
 * Resolves an existing canonical track that lost a concurrent ISRC insert race.
 * Always verifies material metadata compatibility before reusing the existing track.
 */
async function resolveConcurrentIsrcCollision(
  tx: Prisma.TransactionClient | typeof prisma,
  input: TrackInput,
  cleanIsrc: string
): Promise<TrackMatchResolution | null> {
  const existing = await tx.track.findUnique({
    where: { isrc: cleanIsrc },
  });

  if (!existing) {
    return null;
  }

  if (isMaterialContradiction(input, existing)) {
    return await createSeparatedConflictTrack(tx, input, existing, cleanIsrc);
  }

  return {
    track: existing,
    isNew: false,
    matchMethod: MatchMethod.EXACT_ISRC,
  };
}

/**
 * Deterministically finds an existing canonical track or creates a new one.
 *
 * Concurrency & Conflict Invariants:
 * 1. Exact ISRC match: checks isMaterialContradiction(input, match) before accepting.
 * 2. Strict Metadata match: exact normalized title+artist, matching explicitness, compatible versions,
 *    and duration delta <= 2,000ms.
 * 3. Concurrent ISRC creation: uses PostgreSQL `ON CONFLICT (isrc) DO NOTHING` (safe inside active
 *    SQL transactions without triggering 25P02 aborted-transaction errors) plus P2002 handling.
 *    Always executes isMaterialContradiction(input, existing) on the recovered canonical track.
 */
export async function findOrCreateCanonicalTrack(
  input: TrackInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<TrackMatchResolution> {
  const cleanTitle = input.title.trim();
  const cleanArtist = input.artistName.trim();
  const cleanIsrc = input.isrc ? input.isrc.trim().toUpperCase() : null;
  const inputExplicit = input.explicit ?? false;
  const inputVersionInfo = extractVersionInfo(cleanTitle);

  // 1. Exact ISRC lookup
  if (cleanIsrc) {
    const isrcMatch = await tx.track.findFirst({
      where: { isrc: cleanIsrc },
    });

    if (isrcMatch) {
      if (isMaterialContradiction(input, isrcMatch)) {
        return await createSeparatedConflictTrack(tx, input, isrcMatch, cleanIsrc);
      }

      return { track: isrcMatch, isNew: false, matchMethod: MatchMethod.EXACT_ISRC };
    }
  }

  // 2. Strict Metadata match
  const candidates = await tx.track.findMany({
    where: {
      title: { equals: cleanTitle, mode: "insensitive" },
      artistName: { equals: cleanArtist, mode: "insensitive" },
    },
  });

  for (const candidate of candidates) {
    if (candidate.isrc && cleanIsrc && candidate.isrc !== cleanIsrc) {
      continue;
    }
    if (candidate.explicit !== inputExplicit) {
      continue;
    }
    const candidateVersionInfo = extractVersionInfo(candidate.title);
    if (!areVersionTagsCompatible(inputVersionInfo, candidateVersionInfo)) {
      continue;
    }
    if (Math.abs(candidate.durationMs - input.durationMs) <= 2000) {
      return { track: candidate, isNew: false, matchMethod: MatchMethod.METADATA_EXACT };
    }
  }

  // 3. Create new sovereign canonical track
  if (cleanIsrc) {
    // Use INSERT ... ON CONFLICT ("isrc") DO NOTHING RETURNING * so concurrent
    // transactions block cleanly on the index lock without aborting the enclosing transaction (25P02).
    const newId = crypto.randomUUID();
    const albumName = input.albumName?.trim() || null;
    const discNumber = input.discNumber ?? 1;
    const trackNumber = input.trackNumber ?? null;

    const inserted = await tx.$queryRaw<Track[]>`
      INSERT INTO tracks (
        id, isrc, title, "artistName", "albumName", "durationMs", explicit, "discNumber", "trackNumber", "needsReview", "conflictReason", "createdAt", "updatedAt"
      )
      VALUES (
        ${newId},
        ${cleanIsrc},
        ${cleanTitle},
        ${cleanArtist},
        ${albumName},
        ${input.durationMs},
        ${inputExplicit},
        ${discNumber},
        ${trackNumber},
        false,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT ("isrc") DO NOTHING
      RETURNING *;
    `;

    if (inserted.length > 0) {
      return { track: inserted[0], isNew: true };
    }

    // Lost concurrent race: fetch existing canonical track and strictly verify metadata compatibility
    const resolved = await resolveConcurrentIsrcCollision(tx, input, cleanIsrc);
    if (resolved) {
      return resolved;
    }
  }

  // Non-ISRC creation (or defensive fallback) with P2002 recovery + material contradiction check
  try {
    const newTrack = await tx.track.create({
      data: {
        isrc: cleanIsrc,
        title: cleanTitle,
        artistName: cleanArtist,
        albumName: input.albumName?.trim() || null,
        durationMs: input.durationMs,
        explicit: inputExplicit,
        discNumber: input.discNumber ?? 1,
        trackNumber: input.trackNumber ?? null,
      },
    });

    return { track: newTrack, isNew: true };
  } catch (err: unknown) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      cleanIsrc
    ) {
      const resolved = await resolveConcurrentIsrcCollision(tx, input, cleanIsrc);
      if (resolved) {
        return resolved;
      }
    }
    throw err;
  }
}

/**
 * Durably persists a ProviderTrack record and TrackMatch audit row within the caller's transaction.
 * Preserves raw provider metadata (including conflicting ISRC) while recording reviewStatus = NEEDS_REVIEW
 * when material contradictions prevented auto-merging.
 */
export async function persistProviderTrackMatch(
  tx: Prisma.TransactionClient | typeof prisma,
  resolution: TrackMatchResolution,
  input: TrackInput,
  providerSource: ProviderTrackSource,
  verifiedByUserId?: string
): Promise<{ providerTrack: ProviderTrack; trackMatch: TrackMatch }> {
  const cleanIsrc = input.isrc ? input.isrc.trim().toUpperCase() : null;
  const cleanTitle = input.title.trim();
  const cleanArtist = input.artistName.trim();

  const providerTrack = await tx.providerTrack.upsert({
    where: {
      provider_externalId: {
        provider: providerSource.provider,
        externalId: providerSource.externalId,
      },
    },
    update: {
      providerAccountId: providerSource.providerAccountId ?? undefined,
      matchedTrackId: resolution.track.id,
      isrc: cleanIsrc,
      title: cleanTitle,
      artistName: cleanArtist,
      albumName: input.albumName?.trim() || null,
      durationMs: input.durationMs,
      providerUri: providerSource.providerUri ?? undefined,
      rawMetadata: providerSource.rawMetadata ?? undefined,
    },
    create: {
      provider: providerSource.provider,
      externalId: providerSource.externalId,
      providerAccountId: providerSource.providerAccountId ?? null,
      matchedTrackId: resolution.track.id,
      isrc: cleanIsrc,
      title: cleanTitle,
      artistName: cleanArtist,
      albumName: input.albumName?.trim() || null,
      durationMs: input.durationMs,
      providerUri: providerSource.providerUri ?? null,
      rawMetadata: providerSource.rawMetadata ?? undefined,
    },
  });

  const isConflict = resolution.isConflict === true;
  const matchMethod =
    resolution.matchMethod ??
    (isConflict ? MatchMethod.MANUAL_OVERRIDE : MatchMethod.METADATA_EXACT);
  const matchConfidence = isConflict
    ? 0.0
    : matchMethod === MatchMethod.EXACT_ISRC
      ? 1.0
      : 0.95;
  const reviewStatus = isConflict
    ? TrackMatchReviewStatus.NEEDS_REVIEW
    : TrackMatchReviewStatus.AUTO_MATCHED;

  const trackMatch = await tx.trackMatch.upsert({
    where: {
      canonicalTrackId_providerTrackId: {
        canonicalTrackId: resolution.track.id,
        providerTrackId: providerTrack.id,
      },
    },
    update: {
      matchConfidence,
      matchMethod,
      reviewStatus,
      conflictReason: resolution.conflictReason ?? null,
      conflictingTrackId: resolution.conflictingTrackId ?? null,
      verifiedByUserId: verifiedByUserId ?? null,
    },
    create: {
      canonicalTrackId: resolution.track.id,
      providerTrackId: providerTrack.id,
      matchConfidence,
      matchMethod,
      reviewStatus,
      conflictReason: resolution.conflictReason ?? null,
      conflictingTrackId: resolution.conflictingTrackId ?? null,
      verifiedByUserId: verifiedByUserId ?? null,
    },
  });

  return { providerTrack, trackMatch };
}

/**
 * Queries persisted TrackMatch conflict entries requiring human review.
 * Ensures conflicting or ambiguous mappings survive restarts cleanly.
 */
export async function getTrackMatchesNeedingReview(options?: {
  userId?: string;
  limit?: number;
}) {
  const limit = Math.min(100, Math.max(1, options?.limit ?? 50));

  return await prisma.trackMatch.findMany({
    where: {
      reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
      ...(options?.userId
        ? {
            providerTrack: {
              providerAccount: {
                userId: options.userId,
              },
            },
          }
        : {}),
    },
    include: {
      canonicalTrack: true,
      providerTrack: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
