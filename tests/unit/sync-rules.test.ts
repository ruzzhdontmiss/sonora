import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSyncRule,
  updateSyncRule,
  deleteSyncRule,
  reconcileSyncRule,
} from "@/modules/sync/sync-rule.service";
import {
  ConflictPolicy,
  ProviderType,
  SyncDirection,
  SyncJobStatus,
} from "@prisma/client";
import {
  ValidationError,
  ForbiddenError,
  NotFoundError,
} from "@/modules/common/errors";
import { prisma } from "@/lib/db";
import * as migrationOrchestrator from "@/modules/jobs/migration-orchestrator";

// Set environment
process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long-123456";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/sonora_dev";
process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "redis://localhost:6379";

describe("Automated Sync Rules & Continuous Reconciliation (P5-T08)", () => {
  const userId = "test-sync-user-1";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Rule Creation & Validation", () => {
    it("rejects sync rule if source and target providers are identical", async () => {
      await expect(
        createSyncRule(userId, {
          name: "Invalid Rule",
          sourceProvider: ProviderType.YOUTUBE_MUSIC,
          targetProvider: ProviderType.YOUTUBE_MUSIC,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("verifies user accounts are connected before saving rule", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst")
        .mockResolvedValueOnce(null) // Source account not connected
        .mockResolvedValueOnce({ id: "acc-dest" } as never);

      await expect(
        createSyncRule(userId, {
          name: "Spotify to YouTube Sync",
          sourceProvider: ProviderType.SPOTIFY,
          targetProvider: ProviderType.YOUTUBE_MUSIC,
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it("creates an active sync rule with default ADDITIVE_MERGE policy", async () => {
      vi.spyOn(prisma.providerAccount, "findFirst")
        .mockResolvedValueOnce({ id: "acc-source" } as never)
        .mockResolvedValueOnce({ id: "acc-dest" } as never);

      const mockCreated = {
        id: "rule-123",
        userId,
        name: "Spotify to YouTube Sync",
        sourceProvider: ProviderType.SPOTIFY,
        targetProvider: ProviderType.YOUTUBE_MUSIC,
        direction: SyncDirection.ONE_WAY,
        conflictPolicy: ConflictPolicy.ADDITIVE_MERGE,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.syncRule, "create").mockResolvedValueOnce(mockCreated);

      const rule = await createSyncRule(userId, {
        name: "Spotify to YouTube Sync",
        sourceProvider: ProviderType.SPOTIFY,
        targetProvider: ProviderType.YOUTUBE_MUSIC,
      });

      expect(rule.id).toBe("rule-123");
      expect(rule.conflictPolicy).toBe(ConflictPolicy.ADDITIVE_MERGE);
      expect(rule.isActive).toBe(true);
    });
  });

  describe("Rule Management (Update & Delete)", () => {
    it("throws NotFoundError when updating non-existent rule", async () => {
      vi.spyOn(prisma.syncRule, "findFirst").mockResolvedValueOnce(null);

      await expect(
        updateSyncRule(userId, "non-existent-rule", { isActive: false })
      ).rejects.toThrow(NotFoundError);
    });

    it("updates rule active status and conflict policy", async () => {
      vi.spyOn(prisma.syncRule, "findFirst").mockResolvedValueOnce({
        id: "rule-1",
        userId,
      } as never);

      vi.spyOn(prisma.syncRule, "update").mockResolvedValueOnce({
        id: "rule-1",
        userId,
        name: "Updated Name",
        sourceProvider: ProviderType.SPOTIFY,
        targetProvider: ProviderType.YOUTUBE_MUSIC,
        direction: SyncDirection.ONE_WAY,
        conflictPolicy: ConflictPolicy.SOURCE_WINS,
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await updateSyncRule(userId, "rule-1", {
        isActive: false,
        conflictPolicy: ConflictPolicy.SOURCE_WINS,
      });

      expect(updated.isActive).toBe(false);
      expect(updated.conflictPolicy).toBe(ConflictPolicy.SOURCE_WINS);
    });
  });

  describe("Reconciliation Triggering", () => {
    it("rejects reconciliation if sync rule is inactive", async () => {
      vi.spyOn(prisma.syncRule, "findFirst").mockResolvedValueOnce({
        id: "rule-inactive",
        userId,
        name: "Paused Sync",
        isActive: false,
      } as never);

      await expect(
        reconcileSyncRule(userId, "rule-inactive")
      ).rejects.toThrow(/currently inactive/);
    });

    it("triggers migration job under rule's conflict policy", async () => {
      vi.spyOn(prisma.syncRule, "findFirst").mockResolvedValueOnce({
        id: "rule-active",
        userId,
        name: "Active Daily Sync",
        sourceProvider: ProviderType.SPOTIFY,
        targetProvider: ProviderType.YOUTUBE_MUSIC,
        conflictPolicy: ConflictPolicy.ADDITIVE_MERGE,
        isActive: true,
      } as never);

      vi.spyOn(prisma.playlist, "findMany").mockResolvedValueOnce([
        { id: "pl-1" },
        { id: "pl-2" },
      ] as never);

      vi.spyOn(migrationOrchestrator, "createMigrationJob").mockResolvedValueOnce({
        id: "sync-job-xyz",
        status: SyncJobStatus.QUEUED,
      } as never);

      const result = await reconcileSyncRule(userId, "rule-active");
      expect(result.syncJobId).toBe("sync-job-xyz");
      expect(result.status).toBe(SyncJobStatus.QUEUED);
      expect(result.message).toContain("ADDITIVE_MERGE");
    });
  });
});
