import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { MatchMethod, ProviderType, TrackMatchReviewStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      canonicalTrackId,
      providerTrackId,
      selectedCandidate,
    } = body;

    if (!canonicalTrackId) {
      return NextResponse.json(
        { error: "canonicalTrackId is required" },
        { status: 400 }
      );
    }

    const userId = session.user.id;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Verify user ownership of the canonical track in their library or playlists
      const inLibrary = await tx.libraryTrack.findFirst({
        where: {
          trackId: canonicalTrackId,
          library: { userId },
        },
      });

      const inPlaylist = inLibrary
        ? null
        : await tx.playlistItem.findFirst({
            where: {
              trackId: canonicalTrackId,
              playlist: { userId },
            },
          });

      if (!inLibrary && !inPlaylist) {
        throw new Error("Track not found in user library or playlists, or access denied");
      }

      let targetProviderTrackId = providerTrackId;

      // 2. If user selected a custom candidate from live search
      if (selectedCandidate && selectedCandidate.id && selectedCandidate.provider) {
        const candidateProvider = selectedCandidate.provider as ProviderType;
        const upserted = await tx.providerTrack.upsert({
          where: {
            provider_externalId: {
              provider: candidateProvider,
              externalId: selectedCandidate.id,
            },
          },
          update: {
            title: selectedCandidate.title,
            artistName: selectedCandidate.artistName,
            albumName: selectedCandidate.albumName ?? undefined,
            durationMs: selectedCandidate.durationMs,
            isrc: selectedCandidate.isrc ?? undefined,
            matchedTrackId: canonicalTrackId,
            providerUri: selectedCandidate.uri ?? undefined,
          },
          create: {
            provider: candidateProvider,
            externalId: selectedCandidate.id,
            title: selectedCandidate.title,
            artistName: selectedCandidate.artistName,
            albumName: selectedCandidate.albumName ?? null,
            durationMs: selectedCandidate.durationMs,
            isrc: selectedCandidate.isrc ?? null,
            matchedTrackId: canonicalTrackId,
            providerUri: selectedCandidate.uri ?? null,
          },
        });
        targetProviderTrackId = upserted.id;
      } else if (targetProviderTrackId) {
        // Link existing provider track to canonical track
        await tx.providerTrack.update({
          where: { id: targetProviderTrackId },
          data: { matchedTrackId: canonicalTrackId },
        });
      }

      if (!targetProviderTrackId) {
        throw new Error("Target provider track is required to resolve match");
      }

      // 3. Update or create TrackMatch row
      const resolvedMatch = await tx.trackMatch.upsert({
        where: {
          canonicalTrackId_providerTrackId: {
            canonicalTrackId,
            providerTrackId: targetProviderTrackId,
          },
        },
        update: {
          reviewStatus: TrackMatchReviewStatus.CONFIRMED,
          matchMethod: MatchMethod.MANUAL_OVERRIDE,
          matchConfidence: 1.0,
          conflictReason: null,
          conflictingTrackId: null,
          verifiedByUserId: userId,
        },
        create: {
          canonicalTrackId,
          providerTrackId: targetProviderTrackId,
          reviewStatus: TrackMatchReviewStatus.CONFIRMED,
          matchMethod: MatchMethod.MANUAL_OVERRIDE,
          matchConfidence: 1.0,
          verifiedByUserId: userId,
        },
      });

      // 4. Clear track needsReview flag if no other active conflicts
      const remainingConflicts = await tx.trackMatch.count({
        where: {
          canonicalTrackId,
          reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
        },
      });

      if (remainingConflicts === 0) {
        await tx.track.update({
          where: { id: canonicalTrackId },
          data: { needsReview: false, conflictReason: null },
        });
      }

      return resolvedMatch;
    });

    return NextResponse.json({
      success: true,
      match: result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to resolve match";
    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}
