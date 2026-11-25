import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  updateSyncRule,
  deleteSyncRule,
} from "@/modules/sync/sync-rule.service";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json();
    const updated = await updateSyncRule(session.user.id, id, body);
    return NextResponse.json({ success: true, rule: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to update sync rule";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    await deleteSyncRule(session.user.id, id);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to delete sync rule";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
