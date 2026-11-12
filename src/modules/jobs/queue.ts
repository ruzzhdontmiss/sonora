import { Queue, Worker, Job, UnrecoverableError } from "bullmq";
import { getRedisClient } from "@/lib/redis";
import { OutboxEvent } from "@prisma/client";
import {
  isOutboxLeaseActive,
  markOutboxEventPublished,
  OutboxFencingError,
  recordOutboxEventFailure,
  renewOutboxLease,
} from "./outbox.service";

export const SONORA_OUTBOX_QUEUE_NAME = "sonora-outbox-dispatch";

export interface OutboxJobData {
  outboxEventId: string;
  eventType: string;
  payload: unknown;
  leaseToken: string;
  leaseGeneration: number;
  /** Initial PostgreSQL lease duration (seconds) so workers can calibrate heartbeat intervals. */
  leaseDurationSeconds?: number;
}

export interface DispatchOutboxOptions {
  /** Maximum local fast-retries per dispatch cycle inside BullMQ (capped by PostgreSQL remaining retries). */
  maxQueueAttempts?: number;
  /** Base backoff delay in ms for in-queue BullMQ retries. */
  queueBackoffDelayMs?: number;
  queueName?: string;
}

export interface OutboxWorkerOptions {
  concurrency?: number;
  queueName?: string;
  /** Whether to verify active DB lease immediately before invoking handler (default: true). */
  verifyLeaseBeforeRun?: boolean;
  /** Whether to periodically renew the DB lease while the handler executes (default: true). */
  autoRenewLease?: boolean;
  /** Optional explicit heartbeat interval (ms). Defaults to 1/3 of lease duration (min 100ms). */
  leaseHeartbeatMs?: number;
  /** Lease extension duration (seconds) used for heartbeat renewals and queue retries. */
  leaseExtensionSeconds?: number;
}

export interface OutboxExecutionContext {
  signal: AbortSignal;
}

const queueInstances = new Map<string, Queue<OutboxJobData>>();

/**
 * Returns or creates the BullMQ Queue instance for Sonora outbox dispatch.
 */
export function getOutboxQueue(
  queueName: string = SONORA_OUTBOX_QUEUE_NAME
): Queue<OutboxJobData> {
  let queue = queueInstances.get(queueName);
  if (!queue) {
    const redis = getRedisClient();
    queue = new Queue<OutboxJobData>(queueName, {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: {
          age: 3600,
          count: 1000,
        },
        removeOnFail: {
          age: 86400,
          count: 5000,
        },
      },
    });

    queue.on("error", (err) => {
      console.error(`⚠️ BullMQ Outbox Queue [${queueName}] Error:`, err.message);
    });

    queueInstances.set(queueName, queue);
  }

  return queue;
}

/**
 * Enqueues a claimed outbox event to BullMQ with strict generation fencing and
 * durable-retry reconciliation.
 *
 * Retry & Deduplication Guarantees:
 * - Deterministic jobId uses `${event.id}-gen-${event.leaseGeneration}` so retries
 *   across dispatch cycles create a new runnable BullMQ job rather than being silently
 *   ignored as duplicates of prior failed jobs.
 * - BullMQ `attempts` is capped by remaining durable budget (`maxRetries - retryCount`).
 */
export async function dispatchOutboxEventToQueue(
  event: OutboxEvent,
  options: DispatchOutboxOptions = {}
): Promise<{ jobId: string; attempts: number }> {
  if (!event.leaseToken || event.leaseGeneration <= 0) {
    throw new OutboxFencingError(
      event.id,
      `Cannot dispatch unclaimed outbox event ${event.id} without active leaseToken and leaseGeneration.`
    );
  }

  const queue = getOutboxQueue(options.queueName);
  const desiredQueueAttempts = Math.max(1, options.maxQueueAttempts ?? 2);
  const remainingDurableRetries = Math.max(1, event.maxRetries - event.retryCount);
  const boundedAttempts = Math.min(desiredQueueAttempts, remainingDurableRetries);

  const deterministicJobId = `${event.id}-gen-${event.leaseGeneration}`;

  let leaseDurationSeconds = 30;
  if (event.lockedAt && event.leaseExpiresAt) {
    const derivedSeconds = Math.round(
      (event.leaseExpiresAt.getTime() - event.lockedAt.getTime()) / 1000
    );
    if (derivedSeconds >= 1) {
      leaseDurationSeconds = derivedSeconds;
    }
  }

  try {
    const job = await queue.add(
      event.eventType,
      {
        outboxEventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
        leaseToken: event.leaseToken,
        leaseGeneration: event.leaseGeneration,
        leaseDurationSeconds,
      },
      {
        jobId: deterministicJobId,
        attempts: boundedAttempts,
        backoff: {
          type: "exponential",
          delay: options.queueBackoffDelayMs ?? 500,
        },
      }
    );

    return {
      jobId: job.id ?? deterministicJobId,
      attempts: boundedAttempts,
    };
  } catch (err) {
    console.error(`Failed to enqueue outbox event ${event.id} to BullMQ:`, err);
    throw err;
  }
}

/**
 * Creates a fenced BullMQ worker that:
 * 1. Verifies the outbox lease is active before starting handler execution.
 * 2. Periodically renews the PostgreSQL lease using `leaseToken` while the handler runs (on by default).
 * 3. Immediately aborts execution & rejects completion via `OutboxFencingError` / `UnrecoverableError`
 *    if heartbeat renewal fails or expires.
 * 4. Requires the valid unexpired `leaseToken` on both completion and failure transitions.
 */
export function createOutboxWorker(
  handler: (job: Job<OutboxJobData>, ctx?: OutboxExecutionContext) => Promise<void>,
  options: OutboxWorkerOptions = {}
): Worker<OutboxJobData> {
  const redis = getRedisClient();
  const queueName = options.queueName ?? SONORA_OUTBOX_QUEUE_NAME;
  const verifyLeaseBeforeRun = options.verifyLeaseBeforeRun ?? true;
  const autoRenewLease = options.autoRenewLease ?? true;

  const worker = new Worker<OutboxJobData>(
    queueName,
    async (job: Job<OutboxJobData>) => {
      const { outboxEventId, leaseToken, leaseDurationSeconds } = job.data;

      if (!leaseToken) {
        throw new UnrecoverableError(
          `Outbox job ${job.id} rejected: missing mandatory leaseToken.`
        );
      }

      if (verifyLeaseBeforeRun) {
        const active = await isOutboxLeaseActive(outboxEventId, leaseToken);
        if (!active) {
          throw new UnrecoverableError(
            `Outbox fencing violation: leaseToken ${leaseToken} is expired or superseded before execution.`
          );
        }
      }

      const effectiveLeaseSeconds = options.leaseExtensionSeconds ?? leaseDurationSeconds ?? 30;
      const heartbeatIntervalMs =
        options.leaseHeartbeatMs ??
        Math.max(100, Math.floor((effectiveLeaseSeconds * 1000) / 3));

      const abortController = new AbortController();
      let renewalFailureError: OutboxFencingError | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let renewInFlight = false;

      let rejectOnAbort!: (err: Error) => void;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
      });

      if (autoRenewLease && heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (renewInFlight || abortController.signal.aborted) {
            return;
          }
          renewInFlight = true;
          void renewOutboxLease(outboxEventId, leaseToken, effectiveLeaseSeconds)
            .then((renewed) => {
              if (!renewed) {
                renewalFailureError = new OutboxFencingError(
                  outboxEventId,
                  `Outbox lease heartbeat renewal rejected for event ${outboxEventId}: lease expired or superseded.`
                );
                if (heartbeatTimer) {
                  clearInterval(heartbeatTimer);
                  heartbeatTimer = null;
                }
                abortController.abort(renewalFailureError);
                rejectOnAbort(renewalFailureError);
              }
            })
            .catch((renewErr: unknown) => {
              renewalFailureError = new OutboxFencingError(
                outboxEventId,
                `Outbox lease heartbeat failed for event ${outboxEventId}: ${
                  renewErr instanceof Error ? renewErr.message : String(renewErr)
                }`
              );
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
              }
              abortController.abort(renewalFailureError);
              rejectOnAbort(renewalFailureError);
            })
            .finally(() => {
              renewInFlight = false;
            });
        }, heartbeatIntervalMs);

        if (typeof heartbeatTimer.unref === "function") {
          heartbeatTimer.unref();
        }
      }

      try {
        const handlerPromise = Promise.resolve(
          handler(job, { signal: abortController.signal })
        );
        // Prevent unhandled rejection if abortPromise wins the race while handler settles later
        handlerPromise.catch(() => {});

        await Promise.race([handlerPromise, abortPromise]);

        if (renewalFailureError || abortController.signal.aborted) {
          throw (
            renewalFailureError ??
            new OutboxFencingError(
              outboxEventId,
              `Outbox execution aborted due to lost lease for event ${outboxEventId}.`
            )
          );
        }

        await markOutboxEventPublished(outboxEventId, leaseToken);
      } catch (err: unknown) {
        if (err instanceof OutboxFencingError || renewalFailureError) {
          throw new UnrecoverableError(
            (renewalFailureError ?? (err as OutboxFencingError)).message
          );
        }

        const totalQueueAttempts = job.opts.attempts ?? 1;
        const finalQueueAttempt = job.attemptsMade + 1 >= totalQueueAttempts;

        // Calculate lease extension covering BullMQ retry backoff so lease does not expire prematurely
        const backoffDelayMs =
          typeof job.opts.backoff === "object" && job.opts.backoff?.delay
            ? job.opts.backoff.delay * Math.pow(2, job.attemptsMade)
            : 1000;
        const retryLeaseExtSec = Math.max(
          effectiveLeaseSeconds,
          Math.ceil(backoffDelayMs / 1000) + 15
        );

        try {
          await recordOutboxEventFailure(
            outboxEventId,
            leaseToken,
            err instanceof Error ? err : new Error(String(err)),
            {
              finalQueueAttempt,
              leaseExtensionSeconds: retryLeaseExtSec,
            }
          );
        } catch (failureRecordErr: unknown) {
          if (failureRecordErr instanceof OutboxFencingError) {
            throw new UnrecoverableError(failureRecordErr.message);
          }
          throw failureRecordErr;
        }

        throw err;
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }
    },
    {
      connection: redis,
      concurrency: options.concurrency ?? 5,
    }
  );

  return worker;
}

/**
 * Closes all BullMQ queue instances gracefully (useful for clean test teardowns).
 */
export async function closeOutboxQueue(): Promise<void> {
  const entries = Array.from(queueInstances.values());
  queueInstances.clear();
  await Promise.all(entries.map((q) => q.close()));
}
