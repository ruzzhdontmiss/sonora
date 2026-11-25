import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import {
  createSyncRule,
  listSyncRules,
} from "@/modules/sync/sync-rule.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rules = await listSyncRules(session.user.id);
    return NextResponse.json({ rules });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list sync rules";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const rule = await createSyncRule(session.user.id, body);
    return NextResponse.json({ success: true, rule }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create sync rule";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
