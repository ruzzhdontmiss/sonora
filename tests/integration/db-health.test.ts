import { describe, it, expect, afterAll } from "vitest";
import { checkDatabaseHealth } from "@/lib/db-health";
import { prisma } from "@/lib/db";

describe("Database Health Check (P1-T05)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("successfully connects to local postgres and returns healthy status", async () => {
    const health = await checkDatabaseHealth();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.error).toBeUndefined();
  });
});
