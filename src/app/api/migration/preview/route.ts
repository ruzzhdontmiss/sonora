import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { generateMigrationPreview } from "@/modules/jobs/migration-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { sourceProvider, destinationProvider, playlistIds, migrateLikedSongs } = body;

    const plan = await generateMigrationPreview(session.user.id, {
      sourceProvider,
      destinationProvider,
      playlistIds,
      migrateLikedSongs,
    });

    return NextResponse.json({ success: true, plan });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to generate preview";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
