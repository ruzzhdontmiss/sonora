import { Redis } from "ioredis";
import { getEnv } from "@/config/env";

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const env = getEnv();
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy(times) {
        // Bounded reconnect backoff: max 3 seconds
        return Math.min(times * 100, 3000);
      },
    });

    redisClient.on("error", (err) => {
      // Log connection error without crashing web process
      console.error("⚠️ Redis Client Error:", err.message);
    });
  }

  return redisClient;
}

export async function checkRedisHealth(): Promise<{ status: "healthy" | "unhealthy"; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const redis = getRedisClient();
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect();
    }
    const pong = await redis.ping();
    if (pong === "PONG") {
      return { status: "healthy", latencyMs: Date.now() - start };
    }
    return { status: "unhealthy", error: `Unexpected ping response: ${pong}` };
  } catch (err) {
    return {
      status: "unhealthy",
      error: err instanceof Error ? err.message : "Redis connection failed",
    };
  }
}

