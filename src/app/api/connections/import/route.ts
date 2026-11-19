import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/modules/auth/service";
import { triggerImportJob } from "@/modules/jobs/import-orchestrator";
import { z } from "zod";

const importSchema = z.object({
  providerAccountId: z.string().uuid("Invalid provider account identifier"),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getCurrentSession(request);
    if (!auth) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const parseResult = importSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request payload", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const job = await triggerImportJob(auth.user.id, parseResult.data.providerAccountId);

    return NextResponse.json({
      success: true,
      syncJobId: job.id,
      status: job.status,
      message: "Import job queued successfully via durable transactional outbox.",
    });
  } catch (err: unknown) {
    console.error("Trigger import error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to queue import job." },
      { status: 500 }
    );
  }
}
