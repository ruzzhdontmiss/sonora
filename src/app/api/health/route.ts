import { NextResponse } from "next/server";
import { checkDatabaseHealth } from "@/lib/db-health";
import { checkRedisHealth } from "@/lib/redis";
import { youTubeQuotaManager } from "@/modules/providers/youtube/quota/youtube-quota-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  const [dbHealth, redisHealth, quotaStatus] = await Promise.all([
    checkDatabaseHealth().catch((err) => ({ ok: false, error: String(err) })),
    checkRedisHealth().catch((err) => ({ status: "unhealthy" as const, error: String(err) })),
    youTubeQuotaManager.getStatus().catch(() => null),
  ]);

  const isHealthy = dbHealth.ok && redisHealth.status === "healthy";

  return NextResponse.json(
    {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth,
        redis: redisHealth,
        youtubeQuota: quotaStatus
          ? {
              generalUnitsRemaining: quotaStatus.remainingGeneralUnits,
              searchCallsRemaining: quotaStatus.remainingSearchCalls,
              resetsAt: quotaStatus.resetsAt,
            }
          : undefined,
      },
    },
    { status: isHealthy ? 200 : 503 }
  );
}
