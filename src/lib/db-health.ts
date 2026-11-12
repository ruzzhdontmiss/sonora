import { prisma } from "./db";

export interface DatabaseHealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Checks database connectivity via a lightweight query.
 * Safe to call from health check routes and monitoring scripts.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealthResult> {
  const start = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const latencyMs = Math.round(performance.now() - start);
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      latencyMs,
      error: err instanceof Error ? err.message : "Database connection failed",
    };
  }
}
