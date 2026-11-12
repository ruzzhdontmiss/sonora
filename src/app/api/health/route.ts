import { NextResponse } from "next/server";
import { checkDatabaseHealth } from "@/lib/db-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const dbHealth = await checkDatabaseHealth();

  const isHealthy = dbHealth.ok;
  return NextResponse.json(
    {
      status: isHealthy ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth,
      },
    },
    { status: isHealthy ? 200 : 503 }
  );
}
