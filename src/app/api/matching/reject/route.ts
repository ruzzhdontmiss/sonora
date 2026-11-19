import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { TrackMatchReviewStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { canonicalTrackId, providerTrackId, reason } = body;

    if (!canonicalTrackId || !providerTrackId) {
      return NextResponse.json(
        { error: "canonicalTrackId and providerTrackId are required" },
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

      // 2. Unlink provider track matchedTrackId if it was pointing to this canonical track
      await tx.providerTrack.updateMany({
        where: {
          id: providerTrackId,
          matchedTrackId: canonicalTrackId,
        },
        data: { matchedTrackId: null },
      });

      // 3. Mark TrackMatch as REJECTED
      const updatedMatch = await tx.trackMatch.upsert({
        where: {
          canonicalTrackId_providerTrackId: {
            canonicalTrackId,
            providerTrackId,
          },
        },
        update: {
          reviewStatus: TrackMatchReviewStatus.REJECTED,
          conflictReason: reason || "User manually rejected match candidate",
          verifiedByUserId: userId,
        },
        create: {
          canonicalTrackId,
          providerTrackId,
          matchConfidence: 0.0,
          matchMethod: "MANUAL_OVERRIDE",
          reviewStatus: TrackMatchReviewStatus.REJECTED,
          conflictReason: reason || "User manually rejected match candidate",
          verifiedByUserId: userId,
        },
      });

      return updatedMatch;
    });

    return NextResponse.json({
      success: true,
      match: result,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to reject match";
    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}
