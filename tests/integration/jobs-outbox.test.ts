import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { OutboxStatus, SyncJobType, SyncOperationAction, SyncOperationStatus } from "@prisma/client";
import {
  createOutboxEvent,
  claimPendingOutboxEvents,
  renewOutboxLease,
  isOutboxLeaseActive,
  markOutboxEventPublished,
  recordOutboxEventFailure,
  OutboxFencingError,
} from "@/modules/jobs/outbox.service";
import { OutboxDispatcher } from "@/modules/jobs/worker";
import {
  dispatchOutboxEventToQueue,
  createOutboxWorker,
  closeOutboxQueue,
  getOutboxQueue,
} from "@/modules/jobs/queue";
import {
  withIdempotency,
  renewIdempotencyLease,
  completeIdempotencyReservation,
  IdempotencyFencingError,
} from "@/lib/idempotency";
import { deriveKey, encryptToken, decryptToken, reencryptToken } from "@/lib/encryption";
import {
  createSyncJob,
  startSyncJob,
  recordSyncOperation,
  completeSyncJob,
  getSyncJobById,
} from "@/modules/jobs/sync-job.service";
import { checkRedisHealth } from "@/lib/redis";
import { ForbiddenError } from "@/modules/common/errors";

describe("Phase 2 Job Queue & Outbox Foundation (Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000001";
  const otherUserId = "ee000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    await prisma.outboxEvent.deleteMany({});
    await prisma.user.deleteMany({
      where: { id: { in: [testUserId, otherUserId] } },
    });
    await prisma.user.createMany({
      data: [
        { id: testUserId, email: "job-test@example.com" },
        { id: otherUserId, email: "job-other@example.com" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany({});
    await closeOutboxQueue();
    await prisma.user.deleteMany({
      where: { id: { in: [testUserId, otherUserId] } },
    });
    await prisma.$disconnect();
  });

  describe("Redis Connectivity", () => {
    it("connects to Redis and reports healthy status", async () => {
      const health = await checkRedisHealth();
      expect(health.status).toBe("healthy");
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Durable Outbox Dispatch & Worker Execution", () => {
    it("dispatches committed outbox events to registered handlers", async () => {
      const event = await createOutboxEvent({
        eventType: "TEST_DISPATCH",
        payload: { message: "Hello Outbox", count: 42 },
      });

      expect(event.status).toBe(OutboxStatus.PENDING);

      let handledPayload: any = null;
      const dispatcher = new OutboxDispatcher();
      dispatcher.registerHandler("TEST_DISPATCH", async (payload) => {
        handledPayload = payload;
      });

      const processedCount = await dispatcher.processBatch();
      expect(processedCount).toBeGreaterThan(0);
      expect(handledPayload).toEqual({ message: "Hello Outbox", count: 42 });

      // Verify event was marked PUBLISHED
      const updated = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(updated.status).toBe(OutboxStatus.PUBLISHED);
      expect(updated.processedAt).not.toBeNull();
    });

    it("handles worker failure with bounded retries and dead-lettering", async () => {
      // Create event with maxRetries: 2
      const failingEvent = await createOutboxEvent({
        eventType: "FAILING_EVENT",
        payload: { attempt: 1 },
        maxRetries: 2,
      });

      const dispatcher = new OutboxDispatcher();
      dispatcher.registerHandler("FAILING_EVENT", async () => {
        throw new Error("Simulated failure in handler");
      });

      // Attempt 1: Should transition to FAILED with retryCount = 1
      await dispatcher.processBatch();
      let record = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: failingEvent.id },
      });
      expect(record.status).toBe(OutboxStatus.FAILED);
      expect(record.retryCount).toBe(1);
      expect(record.lastError).toContain("Simulated failure in handler");

      // Simulate nextRunAt being reached by backdating nextRunAt
      await prisma.outboxEvent.update({
        where: { id: failingEvent.id },
        data: { nextRunAt: new Date(Date.now() - 1000) },
      });

      // Attempt 2: Should hit maxRetries (2) and transition to DEAD_LETTER
      await dispatcher.processBatch();
      record = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: failingEvent.id },
      });
      expect(record.status).toBe(OutboxStatus.DEAD_LETTER);
      expect(record.retryCount).toBe(2);

      // Clean up
      await prisma.outboxEvent.delete({ where: { id: failingEvent.id } });
    });
  });

  describe("Idempotency Safeguards", () => {
    it("prevents duplicate execution when given the same idempotency key and scope", async () => {
      const idempotencyKey = "key_transfer_job_999";
      const scope = "TRANSFER_JOB";

      // Ensure test begins clean
      await prisma.idempotencyRecord.deleteMany({
        where: { key: idempotencyKey, scope },
      });

      let executionCount = 0;
      const work = async () => {
        executionCount++;
        return { status: "SUCCESS", createdEntities: 5 };
      };

      // First execution
      const call1 = await withIdempotency(idempotencyKey, scope, 60, work);
      expect(call1.isReplay).toBe(false);
      expect(call1.result).toEqual({ status: "SUCCESS", createdEntities: 5 });
      expect(executionCount).toBe(1);

      // Second execution with same key: must NOT run function again
      const call2 = await withIdempotency(idempotencyKey, scope, 60, work);
      expect(call2.isReplay).toBe(true);
      expect(call2.result).toEqual({ status: "SUCCESS", createdEntities: 5 });
      expect(executionCount).toBe(1); // Still 1!

      // Clean up
      await prisma.idempotencyRecord.deleteMany({
        where: { key: idempotencyKey, scope },
      });
    });

    it("prevents concurrent duplicate executions from running simultaneously", async () => {
      const concurrentKey = "key_concurrent_job_888";
      const scope = "CONCURRENT_JOB";

      await prisma.idempotencyRecord.deleteMany({
        where: { key: concurrentKey, scope },
      });

      let executionCount = 0;
      const slowWork = async () => {
        executionCount++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: "COMPLETED", id: 888 };
      };

      // Launch two concurrent calls with the same key
      const [res1, res2] = await Promise.all([
        withIdempotency(concurrentKey, scope, 60, slowWork),
        withIdempotency(concurrentKey, scope, 60, slowWork),
      ]);

      // Exactly one was the initial execution, and the other was a replay!
      expect(executionCount).toBe(1);
      expect(res1.result).toEqual({ status: "COMPLETED", id: 888 });
      expect(res2.result).toEqual({ status: "COMPLETED", id: 888 });
      expect([res1.isReplay, res2.isReplay].sort()).toEqual([false, true]);

      await prisma.idempotencyRecord.deleteMany({
        where: { key: concurrentKey, scope },
      });
    });
  });

  describe("SyncJob & SyncOperation Lifecycle", () => {
    it("tracks job lifecycle and per-item outcomes durably", async () => {
      const job = await createSyncJob({
        userId: testUserId,
        jobType: SyncJobType.IMPORT,
        sourceProvider: "SPOTIFY",
        targetProvider: "SONORA_CANONICAL",
        totalItems: 2,
      });

      expect(job.status).toBe("QUEUED");

      await startSyncJob(job.id);

      // Record first item success
      await recordSyncOperation(job.id, {
        itemType: "TRACK",
        sourceId: "sp_track_1",
        targetId: "canon_track_1",
        action: SyncOperationAction.MATCHED,
        status: SyncOperationStatus.SUCCESS,
      });

      // Record second item failure
      await recordSyncOperation(job.id, {
        itemType: "TRACK",
        sourceId: "sp_track_2",
        action: SyncOperationAction.FAILED,
        status: SyncOperationStatus.ERROR,
        errorMessage: "Metadata missing required ISRC or duration",
      });

      await completeSyncJob(job.id);

      const completed = await getSyncJobById(testUserId, job.id);
      expect(completed.status).toBe("COMPLETED");
      expect(completed.processedItems).toBe(2);
      expect(completed.failedItems).toBe(1);
      expect(completed.operations.length).toBe(2);
      expect(completed.operations[0].action).toBe("MATCHED");
      expect(completed.operations[1].action).toBe("FAILED");
    });

    it("enforces tenant ownership on getSyncJobById", async () => {
      const job = await createSyncJob({
        userId: testUserId,
        jobType: SyncJobType.IMPORT,
        sourceProvider: "SPOTIFY",
        targetProvider: "SONORA_CANONICAL",
      });

      // Other user cannot access this job
      await expect(getSyncJobById(otherUserId, job.id)).rejects.toThrow(ForbiddenError);
    });
  });

  describe("Concurrent Worker Claiming (SKIP LOCKED)", () => {
    it("atomically claims events so concurrent workers never receive overlapping events", async () => {
      // Create 4 distinct pending events
      const events = await Promise.all([
        createOutboxEvent({ eventType: "CONCURRENT_1", payload: {} }),
        createOutboxEvent({ eventType: "CONCURRENT_2", payload: {} }),
        createOutboxEvent({ eventType: "CONCURRENT_3", payload: {} }),
        createOutboxEvent({ eventType: "CONCURRENT_4", payload: {} }),
      ]);

      // Worker A and Worker B claim concurrently
      const [claimedA, claimedB] = await Promise.all([
        claimPendingOutboxEvents("worker-conc-A", 2),
        claimPendingOutboxEvents("worker-conc-B", 2),
      ]);

      const idsA = claimedA.map((e) => e.id);
      const idsB = claimedB.map((e) => e.id);

      // Verify no intersection between claimed IDs
      const intersection = idsA.filter((id) => idsB.includes(id));
      expect(intersection.length).toBe(0);

      // All claimed events must be marked PROCESSING
      for (const e of [...claimedA, ...claimedB]) {
        expect(e.status).toBe(OutboxStatus.PROCESSING);
      }

      // Clean up
      await prisma.outboxEvent.deleteMany({
        where: { id: { in: events.map((e) => e.id) } },
      });
    });
  });

  describe("Token Encryption Key Decoding & Zero-Downtime Rotation", () => {
    it("derives exact 32-byte buffers from either hex or raw passphrase keys", () => {
      const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const passphraseKey = "my_custom_super_secure_passphrase_here";

      const bufHex = deriveKey(hexKey);
      const bufPass = deriveKey(passphraseKey);

      expect(bufHex.length).toBe(32);
      expect(bufPass.length).toBe(32);
    });

    it("decrypts tokens encrypted with previous keys using fallback rotation keys", () => {
      const oldKey = "old_secret_key_rotation_phase_1";
      const oldKeyBuffer = deriveKey(oldKey);

      const secretToken = "spotify_access_token_to_rotate_12345";
      const encryptedWithOldKey = encryptToken(secretToken, oldKeyBuffer);

      // Decrypting without fallback keys should fail with active key
      expect(() => decryptToken(encryptedWithOldKey)).toThrow(
        "Failed to decrypt token: authenticity verification failed"
      );

      // Decrypting WITH oldKey as fallback succeeds
      const decryptedWithFallback = decryptToken(encryptedWithOldKey, {
        fallbackKeys: [oldKey],
      });
      expect(decryptedWithFallback).toBe(secretToken);

      // Re-encrypting rotates to active key
      const reencrypted = reencryptToken(encryptedWithOldKey, {
        fallbackKeys: [oldKey],
      });
      expect(reencrypted).not.toBe(encryptedWithOldKey);

      // Now decrypts cleanly with active key alone
      expect(decryptToken(reencrypted)).toBe(secretToken);
    });
  });

  describe("Outbox Processing Lease, Crash Recovery & Fencing Tokens", () => {
    it("recovers events when processing lease expires and fences out timed-out workers via unique leaseToken", async () => {
      const event = await createOutboxEvent({
        eventType: "LEASE_TEST",
        payload: { data: "lease-recovery-payload" },
      });

      // Worker A claims with 1-second lease
      const claimedA = await claimPendingOutboxEvents("worker-A", 1, 1);
      expect(claimedA.length).toBe(1);
      const tokenA = claimedA[0].leaseToken!;
      expect(tokenA).toBeTruthy();
      expect(claimedA[0].leaseGeneration).toBe(1);
      expect(claimedA[0].lockedBy).toBe("worker-A");

      // While lease is active, Worker B cannot claim this event
      const claimedBBeforeExpiry = await claimPendingOutboxEvents("worker-B", 1, 1);
      expect(claimedBBeforeExpiry.some((e) => e.id === event.id)).toBe(false);

      // Wait 1.1s for Worker A's lease to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Worker B claims now: lease expired, Worker B receives generation 2 & new unique token
      const claimedBAfterExpiry = await claimPendingOutboxEvents("worker-B", 1, 10);
      const reclaimedEvent = claimedBAfterExpiry.find((e) => e.id === event.id)!;
      expect(reclaimedEvent).toBeDefined();
      const tokenB = reclaimedEvent.leaseToken!;
      expect(tokenB).not.toBe(tokenA);
      expect(reclaimedEvent.leaseGeneration).toBe(2);
      expect(reclaimedEvent.lockedBy).toBe("worker-B");

      // Worker A wakes up and tries to complete OR fail using stale tokenA -> Fenced out!
      await expect(markOutboxEventPublished(event.id, tokenA)).rejects.toThrow(
        OutboxFencingError
      );
      await expect(
        recordOutboxEventFailure(event.id, tokenA, "stale error")
      ).rejects.toThrow(OutboxFencingError);

      // Worker B renews its active lease with tokenB
      expect(await renewOutboxLease(event.id, tokenB, 30)).toBe(true);
      expect(await renewOutboxLease(event.id, tokenA, 30)).toBe(false);

      // Worker B marks completion successfully with tokenB
      const completed = await markOutboxEventPublished(event.id, tokenB);
      expect(completed.status).toBe(OutboxStatus.PUBLISHED);

      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });

    it("rejects renewal, completion, and failure immediately after lease expiry even before any other worker reclaims (P1-4)", async () => {
      const event = await createOutboxEvent({
        eventType: "IMMEDIATE_EXPIRY_TEST",
        payload: { data: "expiry-without-reclaim" },
      });

      const [claimed] = await claimPendingOutboxEvents("worker-solo", 1, 1);
      const token = claimed.leaseToken!;
      expect(await isOutboxLeaseActive(event.id, token)).toBe(true);

      // Wait 1.1s without any competing worker reclaiming!
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(await isOutboxLeaseActive(event.id, token)).toBe(false);

      // Even though status is still PROCESSING and nobody else reclaimed it, ALL transitions MUST fail
      expect(await renewOutboxLease(event.id, token, 30)).toBe(false);

      await expect(markOutboxEventPublished(event.id, token)).rejects.toThrow(
        OutboxFencingError
      );
      await expect(
        recordOutboxEventFailure(event.id, token, "late failure")
      ).rejects.toThrow(OutboxFencingError);

      // DB record must remain completely uncorrupted
      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe(OutboxStatus.PROCESSING);
      expect(row.retryCount).toBe(0);
      expect(row.lastError).toBeNull();

      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });
  });

  describe("BullMQ Outbox Queue Dispatch, Fencing & Retry Accounting (P0-1, P1-5)", () => {
    it("dispatches claimed outbox event with generation fencing token and marks published", async () => {
      const queueName = "sonora-test-dispatch-basic";
      const q = getOutboxQueue(queueName);
      await q.obliterate({ force: true });

      const event = await createOutboxEvent({
        eventType: "BULLMQ_DISPATCH_TEST",
        payload: { message: "Dispatched through Redis queue" },
      });

      const [claimed] = await claimPendingOutboxEvents("bullmq-dispatcher", 1, 30);
      expect(claimed.leaseToken).toBeTruthy();

      const dispatchResult = await dispatchOutboxEventToQueue(claimed, { queueName });
      expect(dispatchResult.jobId).toBe(`${claimed.id}-gen-1`);

      let handled = false;
      const worker = createOutboxWorker(
        async (job) => {
          expect(job.data.outboxEventId).toBe(claimed.id);
          expect(job.data.leaseToken).toBe(claimed.leaseToken);
          expect(job.data.leaseGeneration).toBe(1);
          handled = true;
        },
        { queueName }
      );

      for (let i = 0; i < 40; i++) {
        if (handled) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(handled).toBe(true);

      // Allow completion DB update to settle
      let dbEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      for (let i = 0; i < 20 && dbEvent.status !== OutboxStatus.PUBLISHED; i++) {
        await new Promise((r) => setTimeout(r, 50));
        dbEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      }
      expect(dbEvent.status).toBe(OutboxStatus.PUBLISHED);

      await worker.close();
      await q.obliterate({ force: true });
      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });

    it("rejects stale BullMQ worker success & failure after lease reclaim while fresh worker completes cleanly", async () => {
      const qStaleSuccess = "sonora-test-stale-success";
      const qStaleFailure = "sonora-test-stale-failure";
      await getOutboxQueue(qStaleSuccess).obliterate({ force: true });
      await getOutboxQueue(qStaleFailure).obliterate({ force: true });

      // Part A: Stale success in BullMQ worker
      const eSuccess = await createOutboxEvent({ eventType: "STALE_SUCCESS", payload: {} });
      const [claim1A] = await claimPendingOutboxEvents("disp-1", 1, 1);
      await dispatchOutboxEventToQueue(claim1A, { queueName: qStaleSuccess, maxQueueAttempts: 1 });

      let worker1Started = false;
      let worker1FinishedErr: Error | undefined;

      const worker1 = createOutboxWorker(
        async () => {
          worker1Started = true;
          // Sleep longer than 1s lease so Worker 2 reclaims in the meantime (simulating frozen worker)
          await new Promise((r) => setTimeout(r, 1500));
        },
        { queueName: qStaleSuccess, autoRenewLease: false }
      );

      worker1.on("failed", (_job, err) => {
        worker1FinishedErr = err;
      });

      for (let i = 0; i < 30 && !worker1Started; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(worker1Started).toBe(true);

      // Wait for lease to expire, then reclaim via Worker 2 and complete
      await new Promise((r) => setTimeout(r, 1100));
      const [claim1B] = await claimPendingOutboxEvents("disp-2", 1, 30);
      expect(claim1B.id).toBe(eSuccess.id);
      expect(claim1B.leaseGeneration).toBe(2);
      await markOutboxEventPublished(eSuccess.id, claim1B.leaseToken!);

      // Wait for Worker 1 to finish and hit fencing rejection
      for (let i = 0; i < 30 && !worker1FinishedErr; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(worker1FinishedErr).toBeDefined();
      expect(worker1FinishedErr?.message).toContain("Fencing token mismatch");

      const finalSuccessRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eSuccess.id } });
      expect(finalSuccessRow.status).toBe(OutboxStatus.PUBLISHED);
      expect(finalSuccessRow.leaseGeneration).toBe(2);

      // Part B: Stale failure in BullMQ worker MUST NOT reset/increment retryCount or touch active worker's claim
      const eFail = await createOutboxEvent({ eventType: "STALE_FAILURE", payload: {}, maxRetries: 3 });
      const [claim2A] = await claimPendingOutboxEvents("disp-fail-1", 1, 1);
      await dispatchOutboxEventToQueue(claim2A, { queueName: qStaleFailure, maxQueueAttempts: 1 });

      let failWorkerStarted = false;
      let failWorkerErr: Error | undefined;
      const failWorker = createOutboxWorker(
        async () => {
          failWorkerStarted = true;
          await new Promise((r) => setTimeout(r, 1500));
          throw new Error("Simulated stale handler error");
        },
        { queueName: qStaleFailure, autoRenewLease: false }
      );

      failWorker.on("failed", (_job, err) => {
        failWorkerErr = err;
      });

      for (let i = 0; i < 30 && !failWorkerStarted; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Lease expires -> Fresh dispatcher reclaims with gen=2
      await new Promise((r) => setTimeout(r, 1100));
      const [claim2B] = await claimPendingOutboxEvents("disp-fail-2", 1, 30);
      expect(claim2B.id).toBe(eFail.id);
      expect(claim2B.leaseGeneration).toBe(2);

      // Wait for stale failWorker to fail and hit fencing error
      for (let i = 0; i < 30 && !failWorkerErr; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(failWorkerErr).toBeDefined();
      expect(failWorkerErr?.message).toContain("Fencing token mismatch");

      // DB row must STILL be PROCESSING under claim2B with retryCount = 0!
      const intactRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eFail.id } });
      expect(intactRow.status).toBe(OutboxStatus.PROCESSING);
      expect(intactRow.leaseToken).toBe(claim2B.leaseToken);
      expect(intactRow.retryCount).toBe(0);

      // Fresh worker finishes cleanly
      await markOutboxEventPublished(eFail.id, claim2B.leaseToken!);

      await worker1.close();
      await failWorker.close();
      await getOutboxQueue(qStaleSuccess).obliterate({ force: true });
      await getOutboxQueue(qStaleFailure).obliterate({ force: true });
      await prisma.outboxEvent.deleteMany({ where: { id: { in: [eSuccess.id, eFail.id] } } });
    });

    it("periodically renews PostgreSQL outbox lease via heartbeat while handler outlives original lease, preventing concurrent execution by a second worker", async () => {
      const queueName = "sonora-test-heartbeat-renew";
      const q = getOutboxQueue(queueName);
      await q.obliterate({ force: true });

      const event = await createOutboxEvent({
        eventType: "LONG_HEARTBEAT_EVENT",
        payload: { duration: "long" },
      });

      // Claim with a short 1-second initial lease
      const [claimed] = await claimPendingOutboxEvents("hb-dispatcher", 1, 1);
      expect(claimed.leaseToken).toBeTruthy();
      await dispatchOutboxEventToQueue(claimed, { queueName, maxQueueAttempts: 1 });

      let handlerRuns = 0;
      let handlerStarted = false;
      let handlerFinished = false;
      let signalAbortedDuringHealthyRun = false;

      // Uses DEFAULT options: heartbeat automatically calibrated to ~333ms!
      const worker = createOutboxWorker(
        async (_job, ctx) => {
          handlerRuns++;
          handlerStarted = true;
          // Sleep 1,850ms — well past the 1,000ms original lease!
          await new Promise((r) => setTimeout(r, 1850));
          signalAbortedDuringHealthyRun = ctx?.signal.aborted ?? false;
          handlerFinished = true;
        },
        { queueName }
      );

      for (let i = 0; i < 30 && !handlerStarted; i++) {
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(handlerStarted).toBe(true);

      // Probe DB with a competing worker BEFORE and WELL AFTER the original 1s lease expiry
      await new Promise((r) => setTimeout(r, 600));
      expect((await claimPendingOutboxEvents("competing-worker-2", 10, 30)).length).toBe(0);

      await new Promise((r) => setTimeout(r, 600)); // ~1.2s elapsed (past initial 1s lease!)
      expect((await claimPendingOutboxEvents("competing-worker-2", 10, 30)).length).toBe(0);

      await new Promise((r) => setTimeout(r, 350)); // ~1.55s elapsed
      expect((await claimPendingOutboxEvents("competing-worker-2", 10, 30)).length).toBe(0);

      // Wait for handler completion & DB publish
      for (let i = 0; i < 40 && !handlerFinished; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(handlerFinished).toBe(true);
      expect(signalAbortedDuringHealthyRun).toBe(false);
      expect(handlerRuns).toBe(1);

      let finalRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      for (let i = 0; i < 20 && finalRow.status !== OutboxStatus.PUBLISHED; i++) {
        await new Promise((r) => setTimeout(r, 50));
        finalRow = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      }
      expect(finalRow.status).toBe(OutboxStatus.PUBLISHED);
      expect(finalRow.leaseGeneration).toBe(1); // Never reclaimed because lease remained continuously valid!

      await worker.close();
      await q.obliterate({ force: true });
      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });

    it("aborts execution and rejects completion when BullMQ worker lease heartbeat renewal fails mid-flight", async () => {
      const queueName = "sonora-test-heartbeat-abort";
      const q = getOutboxQueue(queueName);
      await q.obliterate({ force: true });

      const event = await createOutboxEvent({
        eventType: "HEARTBEAT_FAILURE_EVENT",
        payload: { test: true },
      });

      const [claimed] = await claimPendingOutboxEvents("hb-fail-disp", 1, 2);
      await dispatchOutboxEventToQueue(claimed, { queueName, maxQueueAttempts: 1 });

      let handlerStarted = false;
      let observedSignalAborted = false;
      let workerFailedErr: Error | undefined;

      const worker = createOutboxWorker(
        async (_job, ctx) => {
          handlerStarted = true;
          await new Promise<void>((resolve) => {
            if (ctx?.signal.aborted) {
              observedSignalAborted = true;
              resolve();
              return;
            }
            const timer = setTimeout(() => resolve(), 3000);
            ctx?.signal.addEventListener(
              "abort",
              () => {
                observedSignalAborted = true;
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
        { queueName, leaseHeartbeatMs: 120 }
      );

      worker.on("failed", (_job, err) => {
        workerFailedErr = err;
      });

      for (let i = 0; i < 30 && !handlerStarted; i++) {
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(handlerStarted).toBe(true);

      // Externally revoke/supersede lease while handler is running
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET "leaseToken" = 'revoked-token',
            "leaseExpiresAt" = NOW() - INTERVAL '1 second'
        WHERE id = ${event.id};
      `;

      // Wait for next heartbeat tick to detect renewal failure & abort
      for (let i = 0; i < 40 && !workerFailedErr; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(observedSignalAborted).toBe(true);
      expect(workerFailedErr).toBeDefined();
      expect(workerFailedErr?.message).toContain("heartbeat renewal rejected");

      // DB record must NOT be PUBLISHED
      const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe(OutboxStatus.PROCESSING);
      expect(row.leaseToken).toBe("revoked-token");

      await worker.close();
      await q.obliterate({ force: true });
      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });

    it("reconciles BullMQ exhaustion, dispatcher re-enqueue, process restart, and DEAD_LETTER transitions cleanly (P1-5)", async () => {
      const queueName = "sonora-test-retry-reconcile";
      const q = getOutboxQueue(queueName);
      await q.obliterate({ force: true });

      // Event allows 4 durable attempts total across all dispatch cycles
      const event = await createOutboxEvent({
        eventType: "RETRY_RECONCILE",
        payload: { test: true },
        maxRetries: 4,
      });

      let handlerExecutions = 0;

      // Cycle 1: Queue configured for 2 local attempts per dispatch
      const dispatcher1 = new OutboxDispatcher({
        workerId: "proc-1-disp",
        mode: "queue",
        queueName,
        maxQueueAttempts: 2,
        queueBackoffDelayMs: 40,
      });

      const worker1 = createOutboxWorker(
        async () => {
          handlerExecutions++;
          throw new Error(`Failure #${handlerExecutions}`);
        },
        { queueName }
      );

      await dispatcher1.processBatch(1);

      // Wait for BullMQ Cycle 1 exhaustion (2 attempts)
      let row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      for (let i = 0; i < 40 && row.status !== OutboxStatus.FAILED; i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      }

      // Assert Cycle 1 did NOT reset, skip, or prematurely DEAD_LETTER when durable maxRetries = 4!
      expect(handlerExecutions).toBe(2);
      expect(row.status).toBe(OutboxStatus.FAILED);
      expect(row.retryCount).toBe(2);
      expect(row.leaseGeneration).toBe(1);
      expect(row.leaseToken).toBeNull();
      expect(row.lastError).toBe("Failure #2");

      // Simulate Process Restart: close worker 1 cleanly
      await worker1.close();

      // Advance clock for durable backoff to become ready
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { nextRunAt: new Date(Date.now() - 1000) },
      });

      // Cycle 2 (Fresh Process): Even if dispatcher requests maxQueueAttempts: 5,
      // BullMQ attempts MUST be capped to remaining durable retries (4 - 2 = 2)!
      const dispatcher2 = new OutboxDispatcher({
        workerId: "proc-2-disp",
        mode: "queue",
        queueName,
        maxQueueAttempts: 5,
        queueBackoffDelayMs: 40,
      });

      const worker2 = createOutboxWorker(
        async () => {
          handlerExecutions++;
          throw new Error(`Failure #${handlerExecutions}`);
        },
        { queueName }
      );

      await dispatcher2.processBatch(1);

      // Wait for Cycle 2 to exhaust remaining durable budget (Attempts 3 & 4) -> DEAD_LETTER!
      row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      for (let i = 0; i < 40 && row.status !== OutboxStatus.DEAD_LETTER; i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
      }

      expect(handlerExecutions).toBe(4); // Strictly 4 total executions == maxRetries!
      expect(row.status).toBe(OutboxStatus.DEAD_LETTER);
      expect(row.retryCount).toBe(4);
      expect(row.leaseGeneration).toBe(2);
      expect(row.processedAt).not.toBeNull();
      expect(row.lastError).toBe("Failure #4");

      await worker2.close();
      await q.obliterate({ force: true });
      await prisma.outboxEvent.delete({ where: { id: event.id } });
    });
  });

  describe("Idempotency Long-Running Lease Renewal & Stale Isolation (P0-2, P1-4)", () => {
    it("cleans up pending idempotency reservation when executeFn throws so subsequent calls can retry", async () => {
      const failKey = "key_failing_operation_123";
      const scope = "FAILING_OP";

      await prisma.idempotencyRecord.deleteMany({ where: { key: failKey, scope } });

      let attempt = 0;
      const work = async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("Transitory upstream failure");
        }
        return { status: "RECOVERED" };
      };

      await expect(withIdempotency(failKey, scope, 60, work)).rejects.toThrow(
        "Transitory upstream failure"
      );

      const retryResult = await withIdempotency(failKey, scope, 60, work);
      expect(retryResult.isReplay).toBe(false);
      expect(retryResult.result).toEqual({ status: "RECOVERED" });

      await prisma.idempotencyRecord.deleteMany({ where: { key: failKey, scope } });
    });

    it("reclaims expired in-flight idempotency reservation after crash/timeout", async () => {
      const expireKey = "key_expired_reservation_456";
      const scope = "EXPIRED_RES";

      await prisma.idempotencyRecord.deleteMany({ where: { key: expireKey, scope } });

      await prisma.idempotencyRecord.create({
        data: {
          key: expireKey,
          scope,
          status: "PENDING",
          lockedBy: "dead-worker-1",
          lockedAt: new Date(Date.now() - 5000),
          leaseExpiresAt: new Date(Date.now() - 1000),
          expiresAt: new Date(Date.now() + 60000),
        },
      });

      const result = await withIdempotency(expireKey, scope, 60, async () => {
        return { status: "RECLAIMED_SUCCESS" };
      });

      expect(result.isReplay).toBe(false);
      expect(result.result).toEqual({ status: "RECLAIMED_SUCCESS" });

      const record = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { key_scope: { key: expireKey, scope } },
      });
      expect(record.status).toBe("COMPLETED");

      await prisma.idempotencyRecord.deleteMany({ where: { key: expireKey, scope } });
    });

    it("automatically renews lease for long-running operation (> original lease) so duplicate caller receives replay without double execution (P0-2)", async () => {
      const longKey = "key_long_running_renewal";
      const scope = "LONG_OP";

      await prisma.idempotencyRecord.deleteMany({ where: { key: longKey, scope } });

      let executionCount = 0;
      const slowWork = async () => {
        executionCount++;
        // Run for 1.8 seconds (> 1s original lease)
        await new Promise((r) => setTimeout(r, 1800));
        return { completedBy: "long-runner", runCount: executionCount };
      };

      // Request 1 starts with 1s lease and heartbeat renewal every 250ms
      const p1 = withIdempotency(longKey, scope, 60, slowWork, {
        leaseDurationSeconds: 1,
        autoRenewLease: true,
        heartbeatIntervalMs: 250,
        pollTimeoutMs: 5000,
      });

      // Wait 500ms, then send concurrent duplicate request while lease continues past 1.0s
      await new Promise((r) => setTimeout(r, 500));
      const p2 = withIdempotency(longKey, scope, 60, slowWork, {
        leaseDurationSeconds: 1,
        pollTimeoutMs: 5000,
      });

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(executionCount).toBe(1);
      expect(res1.isReplay).toBe(false);
      expect(res2.isReplay).toBe(true);
      expect(res1.result).toEqual({ completedBy: "long-runner", runCount: 1 });
      expect(res2.result).toEqual({ completedBy: "long-runner", runCount: 1 });

      await prisma.idempotencyRecord.deleteMany({ where: { key: longKey, scope } });
    });

    it("prevents stale owner from completing or deleting a new owner's reclaimed reservation, and rejects expired lease before reclaim (P0-2, P1-4)", async () => {
      const staleKey = "key_stale_owner_test";
      const scope = "STALE_IDEMPOTENCY";

      await prisma.idempotencyRecord.deleteMany({ where: { key: staleKey, scope } });

      // Part A: Reject immediate renewal & completion on expired lease BEFORE any reclaim
      await prisma.$executeRaw`
        INSERT INTO idempotency_records (id, key, scope, status, "lockedBy", "lockedAt", "leaseExpiresAt", "expiresAt", "createdAt")
        VALUES ('manual-exp-1', ${staleKey}, ${scope}, 'PENDING', 'owner-manual', NOW() - INTERVAL '5 seconds', NOW() - INTERVAL '1 second', NOW() + INTERVAL '60 seconds', NOW());
      `;
      expect(await renewIdempotencyLease(staleKey, scope, "owner-manual", 30)).toBe(false);
      await expect(
        completeIdempotencyReservation(staleKey, scope, "owner-manual", { bad: true })
      ).rejects.toThrow(IdempotencyFencingError);

      await prisma.idempotencyRecord.deleteMany({ where: { key: staleKey, scope } });

      // Part B: Stale owner freezes (autoRenewLease: false), Owner B reclaims,
      // Stale owner wakes up while Owner B is in-flight -> Stale owner cannot complete OR delete Owner B's lock!
      const ownerAExecution = withIdempotency(
        staleKey,
        scope,
        60,
        async () => {
          // Freeze past 1s lease until 1.6s
          await new Promise((r) => setTimeout(r, 1600));
          return { owner: "stale-A" };
        },
        { leaseDurationSeconds: 1, autoRenewLease: false }
      );

      // Wait 1.2s for Owner A's lease to expire
      await new Promise((r) => setTimeout(r, 1200));

      // Owner B reclaims and holds execution until 2.0s (overlapping Owner A's wakeup at 1.6s!)
      const ownerBExecution = withIdempotency(
        staleKey,
        scope,
        60,
        async () => {
          await new Promise((r) => setTimeout(r, 800));
          return { owner: "fresh-B" };
        },
        { leaseDurationSeconds: 5, autoRenewLease: true }
      );

      // Owner A MUST be rejected with IdempotencyFencingError and MUST NOT delete Owner B's reservation
      await expect(ownerAExecution).rejects.toThrow(IdempotencyFencingError);

      // Owner B completes cleanly with its reclaimed reservation intact!
      const ownerBResult = await ownerBExecution;
      expect(ownerBResult.isReplay).toBe(false);
      expect(ownerBResult.result).toEqual({ owner: "fresh-B" });

      const finalRec = await prisma.idempotencyRecord.findUniqueOrThrow({
        where: { key_scope: { key: staleKey, scope } },
      });
      expect(finalRec.status).toBe("COMPLETED");
      expect(finalRec.responsePayload).toEqual({ owner: "fresh-B" });

      await prisma.idempotencyRecord.deleteMany({ where: { key: staleKey, scope } });
    });
  });
});

