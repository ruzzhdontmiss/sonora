import { getEnv } from "@/config/env";
import { MemoryYouTubeQuotaStore } from "./youtube-quota-memory-store";
import { RedisYouTubeQuotaStore } from "./youtube-quota-redis-store";
import { YouTubeQuotaStore } from "./youtube-quota-store.interface";
import {
  ProjectQuotaStatus,
  QuotaConsumptionRequest,
  QuotaConsumptionResult,
  QuotaReleaseRequest,
  QuotaReservationRequest,
  QuotaReservationResult,
} from "./youtube-quota-types";

/**
 * YouTube Data API Quota Manager.
 * Coordinates concurrency-safe project-level quota reservations, consumption, and release.
 */
export class YouTubeQuotaManager {
  private store: YouTubeQuotaStore;
  private defaultProjectId: string;

  constructor(store?: YouTubeQuotaStore, defaultProjectId?: string) {
    let projectId = defaultProjectId;
    if (!projectId) {
      try {
        const env = getEnv();
        projectId = (env as unknown as { GOOGLE_PROJECT_ID?: string }).GOOGLE_PROJECT_ID;
      } catch {
        // Fallback for tests or environments where full env is not loaded yet
      }
    }
    this.defaultProjectId = projectId || "sonora-default-google-project";

    if (store) {
      this.store = store;
    } else {
      // Default to Redis store in production/runtime, or Memory store if test without redis
      try {
        this.store = new RedisYouTubeQuotaStore(undefined, this.defaultProjectId);
      } catch {
        this.store = new MemoryYouTubeQuotaStore(this.defaultProjectId);
      }
    }
  }

  /**
   * Reserves quota units atomically before executing an operation.
   * Throws ProviderQuotaExhaustedError if the project has insufficient quota.
   */
  public async reserveQuota(
    request: QuotaReservationRequest
  ): Promise<QuotaReservationResult> {
    return this.store.reserve({
      ...request,
      projectId: request.projectId || this.defaultProjectId,
    });
  }

  /**
   * Commits an active reservation into permanently consumed quota.
   */
  public async commitReservation(
    reservationToken: string,
    projectId?: string
  ): Promise<void> {
    return this.store.commit(reservationToken, projectId || this.defaultProjectId);
  }

  /**
   * Consumes quota units atomically for single-fire operations without separate reservation lifecycle.
   * Throws ProviderQuotaExhaustedError if the project has insufficient quota.
   */
  public async consumeQuota(
    request: QuotaConsumptionRequest
  ): Promise<QuotaConsumptionResult> {
    return this.store.consume({
      ...request,
      projectId: request.projectId || this.defaultProjectId,
    });
  }

  /**
   * Releases previously reserved or unspent quota back to the project pool.
   */
  public async releaseQuota(request: QuotaReleaseRequest): Promise<void> {
    return this.store.release({
      ...request,
      projectId: request.projectId || this.defaultProjectId,
    });
  }

  /**
   * Inspects current quota consumption and remaining allowance for a project on today's Pacific date.
   */
  public async getStatus(projectId?: string, now?: Date): Promise<ProjectQuotaStatus> {
    return this.store.getStatus(projectId || this.defaultProjectId, now);
  }

  /**
   * Resets quota usage for a project (for testing and administrative overrides).
   */
  public async resetQuota(projectId?: string, now?: Date): Promise<void> {
    return this.store.reset(projectId || this.defaultProjectId, now);
  }
}

export const youTubeQuotaManager = new YouTubeQuotaManager();

export function getYouTubeQuotaManager(): YouTubeQuotaManager {
  return youTubeQuotaManager;
}
