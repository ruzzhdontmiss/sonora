import { prisma } from "@/lib/db";
import { ConflictError } from "@/modules/common/errors";
import crypto from "crypto";

export interface IdempotencyResult<T> {
  result: T;
  isReplay: boolean;
}

export interface IdempotencyOptions {
  /** Lease duration (seconds) for the active in-flight reservation (default: 30s). */
  leaseDurationSeconds?: number;
  /** Maximum time (ms) a duplicate caller waits for an in-flight owner to complete (default: 5000ms). */
  pollTimeoutMs?: number;
  /** Whether to renew the lease periodically while executeFn() runs (default: true). */
  autoRenewLease?: boolean;
  /** Interval (ms) between automatic lease renewals (default: leaseDurationSeconds * 1000 / 3). */
  heartbeatIntervalMs?: number;
}

export interface IdempotencyExecutionContext {
  reservationOwner: string;
  signal: AbortSignal;
}

export class IdempotencyFencingError extends Error {
  public readonly key: string;
  public readonly scope: string;

  constructor(key: string, scope: string, message?: string) {
    super(
      message ||
        `Fencing token mismatch or expired lease for idempotency key "${key}" in scope "${scope}".`
    );
    this.name = "IdempotencyFencingError";
    this.key = key;
    this.scope = scope;
  }
}

/**
 * Renews an active PENDING idempotency reservation lease.
 * Conditional on matching owner (`lockedBy`), `status = 'PENDING'`, AND unexpired lease (`leaseExpiresAt > NOW()`).
 * Returns false if the lease has expired or ownership has been superseded.
 */
export async function renewIdempotencyLease(
  key: string,
  scope: string,
  reservationOwner: string,
  leaseSeconds: number = 30
): Promise<boolean> {
  if (!reservationOwner) {
    return false;
  }

  const renewed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE idempotency_records
    SET "leaseExpiresAt" = NOW() + (${leaseSeconds} || ' seconds')::INTERVAL
    WHERE key = ${key}
      AND scope = ${scope}
      AND status = 'PENDING'
      AND "lockedBy" = ${reservationOwner}
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    RETURNING id;
  `;

  return renewed.length > 0;
}

/**
 * Completes an idempotency reservation under strict lease ownership & validity checks.
 * Rejects stale or expired reservations even if no competing worker has reclaimed them yet.
 */
export async function completeIdempotencyReservation<T>(
  key: string,
  scope: string,
  reservationOwner: string,
  result: T
): Promise<void> {
  const updated = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE idempotency_records
    SET status = 'COMPLETED',
        "responsePayload" = ${JSON.stringify(result)}::JSONB,
        "leaseExpiresAt" = NULL,
        "lockedBy" = NULL
    WHERE key = ${key}
      AND scope = ${scope}
      AND status = 'PENDING'
      AND "lockedBy" = ${reservationOwner}
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" > NOW()
    RETURNING id;
  `;

  if (updated.length === 0) {
    throw new IdempotencyFencingError(
      key,
      scope,
      `Fencing token mismatch or expired lease: reservation for "${key}" in scope "${scope}" cannot be completed.`
    );
  }
}

/**
 * Executes a function within an idempotency scope with lease renewal and crash recovery.
 *
 * Important Delivery Semantics:
 * - Local database mutations executed within an idempotent transaction coordinate with
 *   the transactional outbox safely.
 * - External third-party provider side effects (e.g., HTTP calls to Spotify/Apple Music)
 *   REMAIN AT-LEAST-ONCE unless the provider natively supports idempotency keys or
 *   reconciliation. If an external API call succeeds and this process crashes before
 *   recording completion locally, lease expiry permits a subsequent retry.
 */
export async function withIdempotency<T>(
  key: string,
  scope: string,
  ttlSeconds: number,
  executeFn: (ctx: IdempotencyExecutionContext) => Promise<T>,
  options: IdempotencyOptions = {}
): Promise<IdempotencyResult<T>> {
  const leaseSeconds = options.leaseDurationSeconds ?? 30;
  const pollTimeoutMs = options.pollTimeoutMs ?? 5000;
  const autoRenewLease = options.autoRenewLease ?? true;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(100, Math.floor((leaseSeconds * 1000) / 3));
  const reservationOwner = crypto.randomUUID();

  // 1. Clean up records past overall result retention TTL
  await prisma.$executeRaw`
    DELETE FROM idempotency_records
    WHERE key = ${key}
      AND scope = ${scope}
      AND "expiresAt" <= NOW();
  `;

  // 2. Check if already completed
  const completedRows = await prisma.$queryRaw<Array<{ responsePayload: unknown }>>`
    SELECT "responsePayload"
    FROM idempotency_records
    WHERE key = ${key}
      AND scope = ${scope}
      AND status = 'COMPLETED'
      AND "responsePayload" IS NOT NULL
    LIMIT 1;
  `;

  if (completedRows.length > 0) {
    return {
      result: completedRows[0].responsePayload as T,
      isReplay: true,
    };
  }

  // 3. Attempt atomic reservation insert using database clock
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO idempotency_records (
      id, key, scope, status, "lockedBy", "lockedAt", "leaseExpiresAt", "expiresAt", "createdAt"
    )
    VALUES (
      gen_random_uuid()::text,
      ${key},
      ${scope},
      'PENDING',
      ${reservationOwner},
      NOW(),
      NOW() + (${leaseSeconds} || ' seconds')::INTERVAL,
      NOW() + (${ttlSeconds} || ' seconds')::INTERVAL,
      NOW()
    )
    ON CONFLICT (key, scope) DO NOTHING
    RETURNING id;
  `;

  let isReservationOwner = inserted.length > 0;

  // 4. If insert conflicted, check if existing PENDING reservation has an expired lease and reclaim atomically
  if (!isReservationOwner) {
    const reclaimed = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE idempotency_records
      SET "lockedBy" = ${reservationOwner},
          "lockedAt" = NOW(),
          "leaseExpiresAt" = NOW() + (${leaseSeconds} || ' seconds')::INTERVAL,
          "expiresAt" = NOW() + (${ttlSeconds} || ' seconds')::INTERVAL
      WHERE key = ${key}
        AND scope = ${scope}
        AND status = 'PENDING'
        AND "leaseExpiresAt" IS NOT NULL
        AND "leaseExpiresAt" <= NOW()
      RETURNING id;
    `;
    isReservationOwner = reclaimed.length > 0;
  }

  // 5. If another healthy worker holds the active unexpired lease, wait for completion or expiry
  if (!isReservationOwner) {
    const pollStart = Date.now();

    while (Date.now() - pollStart < pollTimeoutMs) {
      const stateRows = await prisma.$queryRaw<
        Array<{ status: string; responsePayload: unknown; leaseExpired: boolean }>
      >`
        SELECT status,
               "responsePayload",
               ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= NOW()) AS "leaseExpired"
        FROM idempotency_records
        WHERE key = ${key} AND scope = ${scope}
        LIMIT 1;
      `;

      // Record was purged on failure -> retry claim immediately
      if (stateRows.length === 0) {
        return await withIdempotency(key, scope, ttlSeconds, executeFn, options);
      }

      const active = stateRows[0];
      if (active.status === "COMPLETED" && active.responsePayload !== null) {
        return {
          result: active.responsePayload as T,
          isReplay: true,
        };
      }

      // Active owner's lease expired while waiting -> attempt takeover
      if (active.status === "PENDING" && active.leaseExpired) {
        return await withIdempotency(key, scope, ttlSeconds, executeFn, options);
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new ConflictError(
      `Concurrent operation with idempotency key "${key}" in scope "${scope}" is in progress.`
    );
  }

  // 6. We own the reservation lease: run heartbeat renewal during long operations
  const abortController = new AbortController();
  let renewalFailureError: IdempotencyFencingError | null = null;
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
      void renewIdempotencyLease(key, scope, reservationOwner, leaseSeconds)
        .then((renewed) => {
          if (!renewed) {
            renewalFailureError = new IdempotencyFencingError(
              key,
              scope,
              `Idempotency lease heartbeat renewal rejected for "${scope}:${key}": lease expired or superseded.`
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
          renewalFailureError = new IdempotencyFencingError(
            key,
            scope,
            `Idempotency lease heartbeat failed for "${scope}:${key}": ${
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
    const execPromise = Promise.resolve(
      executeFn({ reservationOwner, signal: abortController.signal })
    );
    execPromise.catch(() => {});

    const result = await Promise.race([execPromise, abortPromise]);

    if (renewalFailureError || abortController.signal.aborted) {
      throw (
        renewalFailureError ??
        new IdempotencyFencingError(
          key,
          scope,
          `Execution aborted due to lost idempotency lease for "${scope}:${key}".`
        )
      );
    }

    // Conditional completion checking current ownership AND valid unexpired lease
    await completeIdempotencyReservation(key, scope, reservationOwner, result);

    return {
      result,
      isReplay: false,
    };
  } catch (error) {
    // Only delete if WE STILL own the PENDING reservation; never delete a new owner's reservation
    await prisma.idempotencyRecord.deleteMany({
      where: {
        key,
        scope,
        lockedBy: reservationOwner,
        status: "PENDING",
      },
    });
    throw error;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
}
