import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { executeRestoreBackup } from "@/modules/backup/restore.service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const result = await executeRestoreBackup(session.user.id, body);
    return NextResponse.json({ success: true, result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Restore execution failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
