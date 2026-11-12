import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sessionContext = await getCurrentSession(request);

  if (!sessionContext) {
    return NextResponse.json({ authenticated: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    authenticated: true,
    user: sessionContext.user,
  });
}
