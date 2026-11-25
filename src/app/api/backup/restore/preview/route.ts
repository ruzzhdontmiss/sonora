import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { previewRestoreBackup } from "@/modules/backup/restore.service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const preview = await previewRestoreBackup(session.user.id, body);
    return NextResponse.json({ success: true, preview });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Restore preview failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
