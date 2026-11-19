import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  triggerImportJob,
  executeImportJob,
} from "@/modules/jobs/import-orchestrator";
import { encryptToken } from "@/lib/encryption";
import {
  ProviderType,
  ProviderAccountStatus,
  SyncJobStatus,
  SyncJobType,
} from "@prisma/client";
import { ForbiddenError, NotFoundError } from "@/modules/common/errors";

describe("Shared Import Orchestration & Outbox Integration (Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000040";
  const otherUserId = "ee000000-0000-0000-0000-000000000041";
  const testAccountId = "aa000000-0000-0000-0000-000000000040";

  beforeEach(async () => {
    process.env["SPOTIFY_CLIENT_ID"] = "placeholder";
    process.env["SPOTIFY_CLIENT_SECRET"] = "placeholder";

    await prisma.outboxEvent.deleteMany({ where: { eventType: "IMPORT_JOB_DISPATCHED" } });
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: { in: [testUserId, otherUserId] } } } });
    await prisma.syncJob.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.providerAccount.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.library.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, otherUserId] } } });

    await prisma.user.createMany({
      data: [
        { id: testUserId, email: "orchestrator-test@example.com", displayName: "Orchestrator Tester" },
        { id: otherUserId, email: "other-user@example.com", displayName: "Other User" },
      ],
    });

    await prisma.providerAccount.create({
      data: {
        id: testAccountId,
        userId: testUserId,
        provider: ProviderType.SPOTIFY,
        providerUserId: "spotify-orchestrator-user",
        displayName: "Orchestrator Spotify Account",
        encryptedAccessToken: encryptToken("mock-spotify-token"),
        encryptedRefreshToken: encryptToken("mock-refresh-token"),
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        status: ProviderAccountStatus.CONNECTED,
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.outboxEvent.deleteMany({ where: { eventType: "IMPORT_JOB_DISPATCHED" } });
    await prisma.syncOperation.deleteMany({ where: { syncJob: { userId: { in: [testUserId, otherUserId] } } } });
    await prisma.syncJob.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.providerAccount.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.library.deleteMany({ where: { userId: { in: [testUserId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [testUserId, otherUserId] } } });
  });

  describe("triggerImportJob", () => {
    it("creates a SyncJob in QUEUED state and dispatches an OutboxEvent", async () => {
      const job = await triggerImportJob(testUserId, testAccountId);

      expect(job).toBeDefined();
      expect(job.status).toBe(SyncJobStatus.QUEUED);
      expect(job.jobType).toBe(SyncJobType.IMPORT);
      expect(job.sourceProvider).toBe("SPOTIFY");

      // Verify OutboxEvent created in DB
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: { eventType: "IMPORT_JOB_DISPATCHED" },
      });

      expect(outboxEvent).not.toBeNull();
      const payload = outboxEvent?.payload as any;
      expect(payload.syncJobId).toBe(job.id);
      expect(payload.userId).toBe(testUserId);
      expect(payload.providerAccountId).toBe(testAccountId);
    });

    it("prevents duplicate concurrent jobs if an import is already QUEUED or RUNNING", async () => {
      const firstJob = await triggerImportJob(testUserId, testAccountId);
      const secondJob = await triggerImportJob(testUserId, testAccountId);

      expect(firstJob.id).toBe(secondJob.id);

      const count = await prisma.syncJob.count({
        where: { userId: testUserId, sourceProvider: "SPOTIFY" },
      });
      expect(count).toBe(1);
    });

    it("rejects import if provider account does not belong to the user", async () => {
      await expect(triggerImportJob(otherUserId, testAccountId)).rejects.toThrow(NotFoundError);
    });

    it("rejects import if provider account is DISCONNECTED", async () => {
      await prisma.providerAccount.update({
        where: { id: testAccountId },
        data: { status: ProviderAccountStatus.DISCONNECTED },
      });

      await expect(triggerImportJob(testUserId, testAccountId)).rejects.toThrow(ForbiddenError);
    });
  });

  describe("executeImportJob", () => {
    it("transitions SyncJob through RUNNING to COMPLETED upon successful importer execution", async () => {
      // Mock Spotify API responses
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/me/tracks")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ items: [], total: 0, next: null }),
          });
        }
        if (url.includes("/me/playlists")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ items: [], total: 0, next: null }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const job = await triggerImportJob(testUserId, testAccountId);

      await executeImportJob({
        syncJobId: job.id,
        userId: testUserId,
        providerAccountId: testAccountId,
      });

      const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
      expect(updatedJob?.status).toBe(SyncJobStatus.COMPLETED);
      expect(updatedJob?.startedAt).not.toBeNull();
      expect(updatedJob?.completedAt).not.toBeNull();
    });

    it("transitions SyncJob to FAILED when an unrecoverable error occurs", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => "Bad Request",
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const job = await triggerImportJob(testUserId, testAccountId);

      await expect(
        executeImportJob({
          syncJobId: job.id,
          userId: testUserId,
          providerAccountId: testAccountId,
        })
      ).rejects.toThrow();

      const updatedJob = await prisma.syncJob.findUnique({ where: { id: job.id } });
      expect(updatedJob?.status).toBe(SyncJobStatus.FAILED);
      expect(updatedJob?.completedAt).not.toBeNull();
    });
  });
});
