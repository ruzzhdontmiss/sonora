import { prisma } from "@/lib/db";
import { OutboxEvent, OutboxStatus, Prisma } from "@prisma/client";

export interface CreateOutboxEventInput {
  eventType: string;
  payload: Record<string, unknown>;
  maxRetries?: number;
}

export class OutboxFencingError extends Error {
  public readonly eventId: string;

  constructor(eventId: string, message?: string) {
    super(
      message ||
        `Fencing token mismatch or expired lease for outbox event ${eventId}. Transition rejected.`
    );
    this.name = "OutboxFencingError";
    this.eventId = eventId;
  }
}

/**
 * Calculates exponential backoff with jitter (in milliseconds).
 * Delay formula: min(300,000ms, 2^retries * 1000ms + random_jitter_0_500ms)
 */
export function calculateBackoffMs(retryCount: number): number {
  const base = Math.min(300000, Math.pow(2, retryCount) * 1000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/**
 * Creates an outbox event within a transactional boundary.
 */
export async function createOutboxEvent(
  input: CreateOutboxEventInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  return await tx.outboxEvent.create({
    data: {
      eventType: input.eventType,
      payload: input.payload as unknown as Prisma.InputJsonValue,
      status: OutboxStatus.PENDING,
      maxRetries: input.maxRetries ?? 5,
      nextRunAt: new Date(),
    },
  });
}

/**
 * Atomically claims pending, ready-to-retry, or expired-lease outbox events
 * using PostgreSQL FOR UPDATE SKIP LOCKED.
 *
 * Crash Recovery & Fencing:
 * - Claims status = PENDING
 * - Claims status = FAILED where nextRunAt <= NOW()
 * - Reclaims status = PROCESSING where leaseExpiresAt <= NOW() (crashed/abandoned worker recovery)
 * - Increments monotonic leaseGeneration and mints a cryptographically unique UUID leaseToken per claim.
 */
export async function claimPendingOutboxEvents(
  workerId: string,
  batchSize: number = 20,
  leaseDurationSeconds: number = 30
): Promise<OutboxEvent[]> {
  const claimed = await prisma.$queryRaw<OutboxEvent[]>`
    UPDATE outbox_events
    SET status = 'PROCESSING'::"OutboxStatus",
        "lockedAt" = NOW(),
        "lockedBy" = ${workerId},
        "leaseExpiresAt" = NOW() + (${leaseDurationSeconds} || ' seconds')::INTERVAL,
        "leaseGeneration" = "leaseGeneration" + 1,
        "leaseToken" = gen_random_uuid()::text
    WHERE id IN (
      SELECT id
      FROM outbox_events
      WHERE status = 'PENDING'::"OutboxStatus"
         OR (status = 'FAILED'::"OutboxStatus" AND "nextRunAt" <= NOW())
         OR (status = 'PROCESSING'::"OutboxStatus" AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= NOW())
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;
  return claimed;
}

/**
 * Extends the active processing lease for a long-running event.
 * Enforces both fencing token match AND unexpired lease validity (leaseExpiresAt > NOW()).
 * An expired lease cannot be renewed even if no other worker has reclaimed it yet.
 */
export async function renewOutboxLease(
  id: string,
  leaseToken: string,
  extensionSeconds: number = 30
): Promise<boolean> {
  if (!leaseToken) {
    return false;
  }

  const renewed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE outbox_events
    SET "leaseExpiresAt" = NOW() + (${extensionSeconds} || ' seconds')::INTERVAL
    WHERE id = ${id}
      AND "leaseToken" = ${leaseToken}
      AND status = 'PROCESSING'::"OutboxStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    RETURNING id;
  `;
  return renewed.length > 0;
}

/**
 * Verifies whether a lease token currently holds an active, unexpired claim.
 */
export async function isOutboxLeaseActive(
  id: string,
  leaseToken: string
): Promise<boolean> {
  if (!leaseToken) {
    return false;
  }

  const active = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM outbox_events
    WHERE id = ${id}
      AND "leaseToken" = ${leaseToken}
      AND status = 'PROCESSING'::"OutboxStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    LIMIT 1;
  `;
  return active.length > 0;
}

/**
 * Read-only fetch of events ready for dispatch (for monitoring and tests).
 */
export async function fetchPendingOutboxEvents(batchSize: number = 20) {
  const now = new Date();
  return await prisma.outboxEvent.findMany({
    where: {
      OR: [
        { status: OutboxStatus.PENDING },
        {
          status: OutboxStatus.FAILED,
          nextRunAt: { lte: now },
        },
        {
          status: OutboxStatus.PROCESSING,
          leaseExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });
}

/**
 * Marks an event as successfully published / processed.
 * Requires a valid, unexpired leaseToken matching the active claim.
 * Rejects stale or expired leases even if no other worker has reclaimed the event yet.
 */
export async function markOutboxEventPublished(
  id: string,
  leaseToken: string
): Promise<OutboxEvent> {
  if (!leaseToken) {
    throw new OutboxFencingError(id, "Missing lease token for outbox completion.");
  }

  const updated = await prisma.$queryRaw<OutboxEvent[]>`
    UPDATE outbox_events
    SET status = 'PUBLISHED'::"OutboxStatus",
        "processedAt" = NOW(),
        "leaseExpiresAt" = NULL,
        "leaseToken" = NULL,
        "lockedBy" = NULL
    WHERE id = ${id}
      AND "leaseToken" = ${leaseToken}
      AND status = 'PROCESSING'::"OutboxStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    RETURNING *;
  `;

  if (updated.length === 0) {
    throw new OutboxFencingError(
      id,
      `Fencing token mismatch or expired lease for outbox event ${id}. Completion rejected.`
    );
  }

  return updated[0];
}

/**
 * Records a processing failure for an outbox event under strict lease fencing.
 *
 * Retry Accounting Relationship:
 * - PostgreSQL outbox_events ("retryCount", "maxRetries") is the authoritative system of record.
 * - Each failed attempt atomically increments PostgreSQL "retryCount" by 1.
 * - If ("retryCount" + 1) >= "maxRetries": transitions atomically to DEAD_LETTER regardless of BullMQ queue settings.
 * - If finalQueueAttempt is false (an intermediate fast retry remains in BullMQ): stays in PROCESSING,
 *   saves lastError, and extends the lease so the queued retry can execute cleanly.
 * - If finalQueueAttempt is true: transitions to FAILED with exponential backoff nextRunAt and releases the lease
 *   so the outbox dispatcher can reclaim and re-enqueue on the next generation.
 */
export async function recordOutboxEventFailure(
  id: string,
  leaseToken: string,
  error: Error | string,
  options: { finalQueueAttempt?: boolean; leaseExtensionSeconds?: number } = {}
): Promise<OutboxEvent> {
  if (!leaseToken) {
    throw new OutboxFencingError(id, "Missing lease token for outbox failure transition.");
  }

  const errorMessage = typeof error === "string" ? error : error.message;
  const finalQueueAttempt = options.finalQueueAttempt ?? true;
  const leaseExtensionSeconds = options.leaseExtensionSeconds ?? 30;

  const updated = await prisma.$queryRaw<OutboxEvent[]>`
    UPDATE outbox_events
    SET "retryCount" = "retryCount" + 1,
        "lastError" = ${errorMessage},
        status = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" THEN 'DEAD_LETTER'::"OutboxStatus"
          WHEN ${finalQueueAttempt} THEN 'FAILED'::"OutboxStatus"
          ELSE 'PROCESSING'::"OutboxStatus"
        END,
        "processedAt" = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" THEN NOW()
          ELSE "processedAt"
        END,
        "nextRunAt" = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" THEN "nextRunAt"
          WHEN ${finalQueueAttempt} THEN
            NOW() + (
              ((LEAST(300000, POWER(2, LEAST("retryCount", 20)) * 1000)::BIGINT + FLOOR(RANDOM() * 500)::BIGINT)::TEXT || ' milliseconds')
            )::INTERVAL
          ELSE "nextRunAt"
        END,
        "leaseExpiresAt" = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" OR ${finalQueueAttempt} THEN NULL
          ELSE NOW() + (${leaseExtensionSeconds} || ' seconds')::INTERVAL
        END,
        "leaseToken" = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" OR ${finalQueueAttempt} THEN NULL
          ELSE "leaseToken"
        END,
        "lockedBy" = CASE
          WHEN ("retryCount" + 1) >= "maxRetries" OR ${finalQueueAttempt} THEN NULL
          ELSE "lockedBy"
        END
    WHERE id = ${id}
      AND "leaseToken" = ${leaseToken}
      AND status = 'PROCESSING'::"OutboxStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    RETURNING *;
  `;

  if (updated.length === 0) {
    throw new OutboxFencingError(
      id,
      `Fencing token mismatch or expired lease for outbox event ${id}. Failure transition rejected.`
    );
  }

  return updated[0];
}
