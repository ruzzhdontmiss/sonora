import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  createLibrarySnapshot,
  listSnapshots,
} from "@/modules/backup/snapshot.service";
import { SnapshotTrigger } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshots = await listSnapshots(session.user.id);
    return NextResponse.json({ snapshots });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list snapshots";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === "string" ? body.name : undefined;

    const snapshot = await createLibrarySnapshot(
      session.user.id,
      name,
      SnapshotTrigger.MANUAL
    );

    return NextResponse.json({
      success: true,
      snapshot,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create snapshot";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
