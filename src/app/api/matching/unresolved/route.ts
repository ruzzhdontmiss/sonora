import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { TrackMatchReviewStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));

  try {
    // Retrieve track matches that need review or are in conflict for tracks owned by user or in user's library
    const matches = await prisma.trackMatch.findMany({
      where: {
        reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
        canonicalTrack: {
          libraryTracks: {
            some: {
              library: {
                userId,
              },
            },
          },
        },
      },
      include: {
        canonicalTrack: true,
        providerTrack: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({
      success: true,
      count: matches.length,
      matches: matches.map((m) => ({
        id: m.id,
        canonicalTrackId: m.canonicalTrackId,
        providerTrackId: m.providerTrackId,
        matchConfidence: m.matchConfidence,
        matchMethod: m.matchMethod,
        reviewStatus: m.reviewStatus,
        conflictReason: m.conflictReason,
        conflictingTrackId: m.conflictingTrackId,
        evidence: m.evidence,
        createdAt: m.createdAt.toISOString(),
        canonicalTrack: {
          id: m.canonicalTrack.id,
          title: m.canonicalTrack.title,
          artistName: m.canonicalTrack.artistName,
          albumName: m.canonicalTrack.albumName,
          durationMs: m.canonicalTrack.durationMs,
          isrc: m.canonicalTrack.isrc,
          explicit: m.canonicalTrack.explicit,
        },
        providerTrack: {
          id: m.providerTrack.id,
          provider: m.providerTrack.provider,
          externalId: m.providerTrack.externalId,
          title: m.providerTrack.title,
          artistName: m.providerTrack.artistName,
          albumName: m.providerTrack.albumName,
          durationMs: m.providerTrack.durationMs,
          isrc: m.providerTrack.isrc,
          providerUri: m.providerTrack.providerUri,
        },
      })),
    });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json(
      { error: "Failed to fetch unresolved matches", details },
      { status: 500 }
    );
  }
}
