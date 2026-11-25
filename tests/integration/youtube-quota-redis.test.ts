import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-super-secret-auth-key-16-bytes-min";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://sonora:sonoradev@localhost:5432/sonora";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

import { getRedisClient } from "@/lib/redis";
import { ProviderQuotaExhaustedError } from "@/modules/providers/errors";
import {
  DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
  DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
  getPacificTimeResetWindow,
} from "@/modules/providers/youtube/quota/youtube-quota-constants";
import { YouTubeQuotaManager } from "@/modules/providers/youtube/quota/youtube-quota-manager";
import { RedisYouTubeQuotaStore } from "@/modules/providers/youtube/quota/youtube-quota-redis-store";

describe("Redis Concurrency-Safe YouTube Quota Store (Integration)", () => {
  const redis = getRedisClient();
  const testProjectId = `integration-test-project-${Date.now()}`;
  let redisStore: RedisYouTubeQuotaStore;
  let manager: YouTubeQuotaManager;

  beforeEach(() => {
    redisStore = new RedisYouTubeQuotaStore(redis, testProjectId);
    manager = new YouTubeQuotaManager(redisStore, testProjectId);
  });

  afterEach(async () => {
    await redisStore.reset(testProjectId);
  });

  afterAll(async () => {
    await redisStore.reset(testProjectId);
  });

  it("atomically reserves quota in Redis and sets TTL matching Pacific Time window", async () => {
    const res = await manager.reserveQuota({
      generalUnits: 500,
      searchCalls: 5,
      projectId: testProjectId,
    });

    expect(res.success).toBe(true);
    expect(res.remainingGeneralUnits).toBe(9500);
    expect(res.remainingSearchCalls).toBe(95);

    const { pacificDate } = getPacificTimeResetWindow();
    const generalKey = `sonora:quota:youtube:${testProjectId}:${pacificDate}:general:reserved`;
    const searchKey = `sonora:quota:youtube:${testProjectId}:${pacificDate}:search:reserved`;

    const [genVal, seaVal, genTtl, seaTtl] = await Promise.all([
      redis.get(generalKey),
      redis.get(searchKey),
      redis.ttl(generalKey),
      redis.ttl(searchKey),
    ]);

    expect(genVal).toBe("500");
    expect(seaVal).toBe("5");
    // TTL should be positive and set
    expect(genTtl).toBeGreaterThan(0);
    expect(seaTtl).toBeGreaterThan(0);
  });

  it("handles high-concurrency contention with atomic Lua script without over-allocating", async () => {
    // We allow a custom limit of 2,000 units
    const customLimit = 2000;
    const unitPerRequest = 100;
    // 30 concurrent workers competing for 20 slots (20 * 100 = 2000 units)
    const totalWorkers = 30;

    const promises = Array.from({ length: totalWorkers }, () =>
      manager.reserveQuota({
        generalUnits: unitPerRequest,
        customGeneralLimit: customLimit,
        projectId: testProjectId,
      }).then(
        (r) => ({ success: true, res: r }),
        (err) => ({ success: false, err })
      )
    );

    const outcomes = await Promise.all(promises);

    const successes = outcomes.filter((o) => o.success);
    const failures = outcomes.filter((o) => !o.success);

    // Exactly 20 requests must succeed (20 * 100 = 2000)
    expect(successes.length).toBe(20);
    // Exactly 10 requests must be rejected
    expect(failures.length).toBe(10);

    for (const f of failures) {
      expect((f as { err: unknown }).err).toBeInstanceOf(ProviderQuotaExhaustedError);
    }

    const status = await redisStore.getStatus(testProjectId);
    expect(status.reservedGeneralUnits).toBe(customLimit);
    expect(status.remainingGeneralUnits).toBe(DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT - customLimit);
  });

  it("atomically releases unspent quota back to Redis", async () => {
    await manager.reserveQuota({
      generalUnits: 1500,
      searchCalls: 10,
      projectId: testProjectId,
    });

    let status = await manager.getStatus(testProjectId);
    expect(status.remainingGeneralUnits).toBe(DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT - 1500);

    // Release 1000 general units and 5 search calls
    await manager.releaseQuota({
      generalUnits: 1000,
      searchCalls: 5,
      projectId: testProjectId,
    });

    status = await manager.getStatus(testProjectId);
    expect(status.remainingGeneralUnits).toBe(DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT - 500);
    expect(status.remainingSearchCalls).toBe(DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT - 5);
  });

  it("throws ProviderQuotaExhaustedError when search quota is exhausted in Redis", async () => {
    const customSearchLimit = 5;

    await manager.reserveQuota({
      generalUnits: 50,
      searchCalls: 5,
      customSearchLimit,
      projectId: testProjectId,
    });

    await expect(
      manager.reserveQuota({
        generalUnits: 50,
        searchCalls: 1,
        customSearchLimit,
        projectId: testProjectId,
      })
    ).rejects.toThrow(ProviderQuotaExhaustedError);
  });
});
