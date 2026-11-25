import { describe, it, expect, beforeEach } from "vitest";
import { ProviderQuotaExhaustedError } from "@/modules/providers/errors";
import {
  DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO,
  DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
  DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
  PLANNING_SINGLE_DAY_WRITE_ESTIMATE,
  THEORETICAL_SINGLE_DAY_WRITE_CEILING,
  YOUTUBE_QUOTA_UNIT_COSTS,
  getPacificTimeResetWindow,
} from "@/modules/providers/youtube/quota/youtube-quota-constants";
import { estimateYouTubeQuota } from "@/modules/providers/youtube/quota/youtube-quota-estimator";
import { YouTubeQuotaManager } from "@/modules/providers/youtube/quota/youtube-quota-manager";
import { MemoryYouTubeQuotaStore } from "@/modules/providers/youtube/quota/youtube-quota-memory-store";

describe("YouTube Data API Quota Modeling & Accounting (P5-T01)", () => {
  describe("Pacific Time Reset Window & Date Calculations", () => {
    it("computes the Pacific date in YYYY-MM-DD format", () => {
      const window = getPacificTimeResetWindow();
      expect(window.pacificDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(window.secondsUntilReset).toBeGreaterThan(0);
      expect(window.secondsUntilReset).toBeLessThanOrEqual(86400);
      expect(window.nextMidnightUtc.getTime()).toBeGreaterThan(Date.now());
    });

    it("correctly identifies PST (UTC-8) midnight during winter", () => {
      // 2026-11-24 15:00:00 UTC -> 07:00:00 PST (UTC-8)
      const winterDate = new Date("2026-11-24T15:00:00Z");
      const window = getPacificTimeResetWindow(winterDate);

      expect(window.pacificDate).toBe("2026-11-24");
      // Next midnight PST is 2026-11-25 00:00:00 PST = 2026-11-25 08:00:00 UTC
      expect(window.nextMidnightUtc.toISOString()).toBe("2026-11-25T08:00:00.000Z");
      expect(window.secondsUntilReset).toBe((window.nextMidnightUtc.getTime() - winterDate.getTime()) / 1000);
    });

    it("correctly identifies PDT (UTC-7) midnight during summer daylight saving time", () => {
      // 2026-07-15 15:00:00 UTC -> 08:00:00 PDT (UTC-7)
      const summerDate = new Date("2026-07-15T15:00:00Z");
      const window = getPacificTimeResetWindow(summerDate);

      expect(window.pacificDate).toBe("2026-07-15");
      // Next midnight PDT is 2026-07-16 00:00:00 PDT = 2026-07-16 07:00:00 UTC
      expect(window.nextMidnightUtc.toISOString()).toBe("2026-07-16T07:00:00.000Z");
      expect(window.secondsUntilReset).toBe((window.nextMidnightUtc.getTime() - summerDate.getTime()) / 1000);
    });
  });

  describe("Quota Constants & Unit Costs", () => {
    it("reflects official Google Data API v3 unit costs with zero general units for search", () => {
      expect(YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_ITEM_INSERT).toBe(50);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_CREATE).toBe(50);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.VIDEO_RATE_LIKE).toBe(50);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_ITEMS_LIST).toBe(1);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.PLAYLISTS_LIST).toBe(1);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.VIDEOS_LIST).toBe(1);
      // Corrected: search.list consumes 1 search call and ZERO general bucket units
      expect(YOUTUBE_QUOTA_UNIT_COSTS.SEARCH_LIST_GENERAL_UNITS).toBe(0);
      expect(YOUTUBE_QUOTA_UNIT_COSTS.SEARCH_LIST_CALLS).toBe(1);

      expect(DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT).toBe(10_000);
      expect(DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT).toBe(100);
    });

    it("distinguishes theoretical 199-item ceiling from the 189-item planning estimate", () => {
      expect(THEORETICAL_SINGLE_DAY_WRITE_CEILING).toBe(199);
      expect(PLANNING_SINGLE_DAY_WRITE_ESTIMATE).toBe(189);
      expect(DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO).toBe(0.05);

      const maxPureInserts = Math.floor((10000 - 50) / 50);
      expect(maxPureInserts).toBe(199);

      const plannedInserts = Math.floor(199 / (1 + DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO));
      expect(plannedInserts).toBe(189);
    });
  });

  describe("Mandatory Regression Requirements (1-10)", () => {
    let memoryStore: MemoryYouTubeQuotaStore;
    let manager: YouTubeQuotaManager;
    const testProjectId = "test-google-cloud-project-p5";

    beforeEach(() => {
      memoryStore = new MemoryYouTubeQuotaStore(testProjectId);
      manager = new YouTubeQuotaManager(memoryStore, testProjectId);
    });

    // 1. A search call consumes one Search Queries unit
    it("1. a search call consumes exactly one Search Queries unit", async () => {
      const res = await manager.consumeQuota({
        generalUnits: 0,
        searchCalls: 1,
        projectId: testProjectId,
      });

      expect(res.searchCallsConsumed).toBe(1);
      const status = await manager.getStatus(testProjectId);
      expect(status.usedSearchCalls).toBe(1);
      expect(status.remainingSearchCalls).toBe(99);
    });

    // 2. A search call consumes zero General units
    it("2. a search call consumes exactly zero General units", async () => {
      const res = await manager.consumeQuota({
        generalUnits: 0,
        searchCalls: 1,
        projectId: testProjectId,
      });

      expect(res.generalUnitsConsumed).toBe(0);
      const status = await manager.getStatus(testProjectId);
      expect(status.usedGeneralUnits).toBe(0);
      expect(status.remainingGeneralUnits).toBe(10000);
    });

    // 3. Search bucket exhaustion does not exhaust General quota
    it("3. search bucket exhaustion does not exhaust General quota", async () => {
      // Consume all 100 search calls
      await manager.consumeQuota({
        generalUnits: 0,
        searchCalls: 100,
        projectId: testProjectId,
      });

      const status = await manager.getStatus(testProjectId);
      expect(status.remainingSearchCalls).toBe(0);
      expect(status.remainingGeneralUnits).toBe(10000); // Completely unaffected!

      // Attempting another search call throws ProviderQuotaExhaustedError for SEARCH
      await expect(
        manager.consumeQuota({
          generalUnits: 0,
          searchCalls: 1,
          projectId: testProjectId,
        })
      ).rejects.toThrow(ProviderQuotaExhaustedError);

      // But a general quota write (e.g. 50 units for playlist creation) still succeeds!
      const genRes = await manager.consumeQuota({
        generalUnits: 50,
        searchCalls: 0,
        projectId: testProjectId,
      });
      expect(genRes.success).toBe(true);
      expect(genRes.remainingGeneralUnits).toBe(9950);
    });

    // 4. General bucket exhaustion does not exhaust Search quota
    it("4. general bucket exhaustion does not exhaust Search quota", async () => {
      // Consume all 10,000 general units
      await manager.consumeQuota({
        generalUnits: 10000,
        searchCalls: 0,
        projectId: testProjectId,
      });

      const status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(0);
      expect(status.remainingSearchCalls).toBe(100); // Completely unaffected!

      // Attempting another general write throws ProviderQuotaExhaustedError for GENERAL
      await expect(
        manager.consumeQuota({
          generalUnits: 50,
          searchCalls: 0,
          projectId: testProjectId,
        })
      ).rejects.toThrow(ProviderQuotaExhaustedError);

      // But a search call still succeeds!
      const searchRes = await manager.consumeQuota({
        generalUnits: 0,
        searchCalls: 1,
        projectId: testProjectId,
      });
      expect(searchRes.success).toBe(true);
      expect(searchRes.remainingSearchCalls).toBe(99);
    });

    // 5. Concurrent reservations cannot exceed bucket limits
    it("5. concurrent reservations cannot exceed bucket limits", async () => {
      // 25 concurrent requests, each requesting 400 general units (total 10,000 units)
      const tasks = Array.from({ length: 25 }, () =>
        manager.reserveQuota({
          generalUnits: 400,
          projectId: testProjectId,
        })
      );

      const results = await Promise.all(tasks);
      expect(results.length).toBe(25);

      const status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(0);

      // The 26th request must fail
      await expect(
        manager.reserveQuota({
          generalUnits: 50,
          projectId: testProjectId,
        })
      ).rejects.toThrow(ProviderQuotaExhaustedError);
    });

    // 6. Expired reservations are recoverable
    it("6. expired reservations from crashed workers are automatically recovered", async () => {
      const now = new Date("2026-11-24T12:00:00Z");

      // Worker reserves 5,000 units with a 60-second lease
      const res = await manager.reserveQuota({
        generalUnits: 5000,
        leaseDurationSeconds: 60,
        projectId: testProjectId,
        now,
      });

      let status = await manager.getStatus(testProjectId, now);
      expect(status.remainingGeneralUnits).toBe(5000);
      expect(status.reservedGeneralUnits).toBe(5000);

      // Worker crashes! 61 seconds elapse without commit or release.
      const afterCrash = new Date(now.getTime() + 61_000);

      // Next status check or reservation automatically reclaims the expired lease!
      status = await manager.getStatus(testProjectId, afterCrash);
      expect(status.remainingGeneralUnits).toBe(10000);
      expect(status.reservedGeneralUnits).toBe(0);

      // New worker can now safely reserve the full 10,000 units
      const freshRes = await manager.reserveQuota({
        generalUnits: 10000,
        projectId: testProjectId,
        now: afterCrash,
      });
      expect(freshRes.success).toBe(true);
      expect(freshRes.remainingGeneralUnits).toBe(0);
    });

    // 7. Failed operations release reservations correctly
    it("7. failed operations release reservations correctly", async () => {
      const res = await manager.reserveQuota({
        generalUnits: 2000,
        searchCalls: 20,
        projectId: testProjectId,
      });

      let status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(8000);
      expect(status.remainingSearchCalls).toBe(80);

      // Job failed halfway; release reservation using token
      await manager.releaseQuota({
        generalUnits: 2000,
        searchCalls: 20,
        reservationToken: res.reservationToken,
        projectId: testProjectId,
      });

      status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(10000);
      expect(status.remainingSearchCalls).toBe(100);
    });

    // 8. Pacific midnight resets both buckets correctly
    it("8. Pacific midnight resets both buckets correctly", async () => {
      const day1 = new Date("2026-11-24T20:00:00Z"); // 12:00 PM PST on 2026-11-24
      await manager.consumeQuota({
        generalUnits: 8000,
        searchCalls: 80,
        projectId: testProjectId,
        now: day1,
      });

      let status1 = await manager.getStatus(testProjectId, day1);
      expect(status1.pacificDate).toBe("2026-11-24");
      expect(status1.remainingGeneralUnits).toBe(2000);
      expect(status1.remainingSearchCalls).toBe(20);

      // Advance time past midnight PST (2026-11-25 08:01:00 UTC = 12:01 AM PST on 2026-11-25)
      const day2 = new Date("2026-11-25T08:01:00Z");
      const status2 = await manager.getStatus(testProjectId, day2);
      expect(status2.pacificDate).toBe("2026-11-25");
      expect(status2.usedGeneralUnits).toBe(0);
      expect(status2.remainingGeneralUnits).toBe(10000);
      expect(status2.usedSearchCalls).toBe(0);
      expect(status2.remainingSearchCalls).toBe(100);
    });

    // 9. DST transitions do not cause premature or delayed resets
    it("9. DST transitions do not cause premature or delayed resets", () => {
      // Winter PST (UTC-8)
      const winter = new Date("2026-01-15T15:00:00Z");
      const winterWindow = getPacificTimeResetWindow(winter);
      // Midnight next day is at UTC 08:00
      expect(winterWindow.nextMidnightUtc.getUTCHours()).toBe(8);

      // Summer PDT (UTC-7)
      const summer = new Date("2026-07-15T15:00:00Z");
      const summerWindow = getPacificTimeResetWindow(summer);
      // Midnight next day is at UTC 07:00
      expect(summerWindow.nextMidnightUtc.getUTCHours()).toBe(7);
    });

    // 10. Estimates match actual reservation costs
    it("10. estimates match actual reservation costs", async () => {
      const estimate = estimateYouTubeQuota({
        playlistsToCreate: 1,
        tracksToInsert: 50,
        retryAllowanceRatio: 0, // Zero retry buffer for exact unit comparison
      });

      // 1 create (50) + 50 tracks (2500) = 2,550 units
      expect(estimate.totalEstimatedGeneralUnits).toBe(2550);
      expect(estimate.totalEstimatedSearchCalls).toBe(0);

      // Reserve exactly what was estimated
      const res = await manager.reserveQuota({
        generalUnits: estimate.totalEstimatedGeneralUnits,
        searchCalls: estimate.totalEstimatedSearchCalls,
        projectId: testProjectId,
      });

      expect(res.generalUnitsReserved).toBe(2550);
      expect(res.remainingGeneralUnits).toBe(10000 - 2550);
    });

    it("protects against duplicate reservations on retries using idempotencyKey", async () => {
      const res1 = await manager.reserveQuota({
        generalUnits: 1000,
        idempotencyKey: "retry-safe-job-123",
        projectId: testProjectId,
      });

      expect(res1.isReplay).toBe(false);
      expect(res1.generalUnitsReserved).toBe(1000);

      let status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(9000);

      // Worker retries the same operation with same idempotencyKey
      const res2 = await manager.reserveQuota({
        generalUnits: 1000,
        idempotencyKey: "retry-safe-job-123",
        projectId: testProjectId,
      });

      // Returns replay of original reservation with ZERO additional quota deducted!
      expect(res2.isReplay).toBe(true);
      expect(res2.reservationToken).toBe(res1.reservationToken);

      status = await manager.getStatus(testProjectId);
      expect(status.remainingGeneralUnits).toBe(9000); // Unchanged!
    });
  });

  describe("Quota Estimator Advanced Features", () => {
    it("distinguishes known mappings and cached results from live searches", () => {
      const estimate = estimateYouTubeQuota({
        playlistsToCreate: 1,
        tracksToInsert: 50,
        searchCalls: 50,
        knownTrackMappingsCount: 30, // 30 tracks already mapped
        cachedSearchResultsCount: 15, // 15 searches cached
      });

      expect(estimate.breakdown.knownMappingsAvoidedUnits).toBe(0);
      expect(estimate.breakdown.cachedSearchesAvoidedCalls).toBe(15);
      // Search calls only count the uncached searchCalls parameter
      expect(estimate.totalEstimatedSearchCalls).toBe(50);
      // Search calls do NOT add to general units
      expect(estimate.breakdown.searchUnits).toBe(0);
    });
  });
});
