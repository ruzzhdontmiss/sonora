import {
  claimPendingOutboxEvents,
  markOutboxEventPublished,
  recordOutboxEventFailure,
} from "./outbox.service";
import { dispatchOutboxEventToQueue } from "./queue";

export type EventHandler = (payload: unknown) => Promise<void>;

export interface OutboxDispatcherOptions {
  workerId?: string;
  pollIntervalMs?: number;
  leaseDurationSeconds?: number;
  mode?: "direct" | "queue"; // direct runs handlers in-process; queue enqueues to BullMQ
  maxQueueAttempts?: number;
  queueBackoffDelayMs?: number;
  queueName?: string;
}

export class OutboxDispatcher {
  public readonly workerId: string;
  private handlers = new Map<string, EventHandler>();
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private leaseDurationSeconds: number;
  private mode: "direct" | "queue";
  private maxQueueAttempts?: number;
  private queueBackoffDelayMs?: number;
  private queueName?: string;

  constructor(options: OutboxDispatcherOptions = {}) {
    this.workerId =
      options.workerId ??
      `dispatcher-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 30;
    this.mode = options.mode ?? "direct";
    this.maxQueueAttempts = options.maxQueueAttempts;
    this.queueBackoffDelayMs = options.queueBackoffDelayMs;
    this.queueName = options.queueName;
  }

  /**
   * Registers a handler for a specific outbox event type (used in 'direct' mode).
   */
  public registerHandler(eventType: string, handler: EventHandler): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Processes a single batch of pending outbox events.
   * Atomically claims events using PostgreSQL FOR UPDATE SKIP LOCKED and assigns
   * a unique per-claim leaseToken.
   */
  public async processBatch(batchSize: number = 10): Promise<number> {
    const events = await claimPendingOutboxEvents(
      this.workerId,
      batchSize,
      this.leaseDurationSeconds
    );
    if (events.length === 0) return 0;

    for (const event of events) {
      const leaseToken = event.leaseToken;
      if (!leaseToken) {
        continue;
      }

      if (this.mode === "queue") {
        try {
          await dispatchOutboxEventToQueue(event, {
            maxQueueAttempts: this.maxQueueAttempts,
            queueBackoffDelayMs: this.queueBackoffDelayMs,
            queueName: this.queueName,
          });
        } catch (err: unknown) {
          await recordOutboxEventFailure(
            event.id,
            leaseToken,
            err instanceof Error ? err : new Error(String(err)),
            { finalQueueAttempt: true }
          );
        }
        continue;
      }

      // Direct in-process execution
      const handler = this.handlers.get(event.eventType);
      if (!handler) {
        await recordOutboxEventFailure(
          event.id,
          leaseToken,
          `No registered handler for event type: ${event.eventType}`,
          { finalQueueAttempt: true }
        );
        continue;
      }

      try {
        await handler(event.payload);
        await markOutboxEventPublished(event.id, leaseToken);
      } catch (err: unknown) {
        await recordOutboxEventFailure(
          event.id,
          leaseToken,
          err instanceof Error ? err : new Error(String(err)),
          { finalQueueAttempt: true }
        );
      }
    }

    return events.length;
  }

  /**
   * Starts the background worker loop.
   */
  public async start(): Promise<void> {
    this.isRunning = true;
    console.log(`🚀 SONORA Outbox Dispatcher [${this.workerId}] started (${this.mode} mode). Polling...`);

    while (this.isRunning) {
      try {
        const count = await this.processBatch();
        if (count === 0 && this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (err) {
        console.error("⚠️ Error in outbox worker loop:", err);
        if (this.isRunning) {
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      }
    }

    console.log(`🛑 SONORA Outbox Dispatcher [${this.workerId}] stopped gracefully.`);
  }

  /**
   * Stops the worker gracefully, allowing in-flight jobs to conclude.
   */
  public stop(): void {
    this.isRunning = false;
  }
}

// Standalone runner when executed directly via Node / tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  const dispatcher = new OutboxDispatcher();

  dispatcher.registerHandler("PING", async (payload) => {
    console.log("Received PING event:", payload);
  });

  const shutdown = () => {
    console.log("\nReceived termination signal. Shutting down dispatcher...");
    dispatcher.stop();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  dispatcher.start().catch((err) => {
    console.error("Fatal dispatcher error:", err);
    process.exit(1);
  });
}
