import { NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";
import { cancelMigrationJob } from "@/modules/jobs/migration-orchestrator";
import { NotFoundError } from "@/modules/common/errors";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: jobId } = await props.params;

  try {
    const job = await prisma.syncJob.findFirst({
      where: { id: jobId, userId: session.user.id },
      include: {
        operations: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Migration job not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, job });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request, props: RouteParams) {
  const session = await getCurrentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: jobId } = await props.params;

  try {
    const cancelled = await cancelMigrationJob(session.user.id, jobId);
    return NextResponse.json({ success: true, job: cancelled });
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "Migration job not found" }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : "Failed to cancel migration job";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
