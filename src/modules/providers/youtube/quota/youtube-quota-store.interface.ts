import {
  ProjectQuotaStatus,
  QuotaConsumptionRequest,
  QuotaConsumptionResult,
  QuotaReleaseRequest,
  QuotaReservationRequest,
  QuotaReservationResult,
} from "./youtube-quota-types";

/**
 * Common contract for YouTube quota stores (Redis in production, Memory for unit testing).
 */
export interface YouTubeQuotaStore {
  /**
   * Atomically checks availability and reserves quota for a project with lease expiration.
   * Throws ProviderQuotaExhaustedError if limits would be exceeded.
   */
  reserve(request: QuotaReservationRequest): Promise<QuotaReservationResult>;

  /**
   * Commits an active reservation into permanently consumed daily quota.
   */
  commit(reservationToken: string, projectId?: string): Promise<void>;

  /**
   * Atomically consumes quota without creating a separate reservation.
   * Throws ProviderQuotaExhaustedError if limits would be exceeded.
   */
  consume(request: QuotaConsumptionRequest): Promise<QuotaConsumptionResult>;

  /**
   * Releases previously reserved or unspent quota back to the project pool.
   */
  release(request: QuotaReleaseRequest): Promise<void>;

  /**
   * Returns current quota utilization, in-flight reservations, and remaining capacity for a project.
   */
  getStatus(projectId?: string, now?: Date): Promise<ProjectQuotaStatus>;

  /**
   * Resets quota usage for a project (useful for testing or manual administrative overrides).
   */
  reset(projectId?: string, now?: Date): Promise<void>;
}
