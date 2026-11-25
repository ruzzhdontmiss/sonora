import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { generatePortableExport } from "@/modules/backup/snapshot.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const snapshotId = searchParams.get("snapshotId") || undefined;

    const exportData = await generatePortableExport(session.user.id, snapshotId);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `sonora-library-export-${dateStr}.json`;

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to generate portable export";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
