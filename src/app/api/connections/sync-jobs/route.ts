import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const syncJobs = await prisma.syncJob.findMany({
      where: {
        userId: auth.user.id,
      },
      include: {
        _count: {
          select: { operations: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return NextResponse.json({
      syncJobs,
    });
  } catch (err: unknown) {
    console.error("Sync jobs list error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to retrieve sync jobs." },
      { status: 500 }
    );
  }
}
