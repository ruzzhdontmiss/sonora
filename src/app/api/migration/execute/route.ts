import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { createMigrationJob } from "@/modules/jobs/migration-orchestrator";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      sourceProvider,
      destinationProvider,
      playlistIds,
      migrateLikedSongs,
      confirmed,
      userPreferences,
    } = body;

    const job = await createMigrationJob(session.user.id, {
      sourceProvider,
      destinationProvider,
      playlistIds,
      migrateLikedSongs,
      confirmed: Boolean(confirmed),
      userPreferences,
    });

    return NextResponse.json({ success: true, job }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to execute migration";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
