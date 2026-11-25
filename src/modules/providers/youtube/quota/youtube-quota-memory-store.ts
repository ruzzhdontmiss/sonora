import { randomUUID } from "crypto";
import { ProviderQuotaExhaustedError } from "@/modules/providers/errors";
import {
  DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
  DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
  getPacificTimeResetWindow,
} from "./youtube-quota-constants";
import { YouTubeQuotaStore } from "./youtube-quota-store.interface";
import {
  ProjectQuotaStatus,
  QuotaConsumptionRequest,
  QuotaConsumptionResult,
  QuotaReleaseRequest,
  QuotaReservationRequest,
  QuotaReservationResult,
} from "./youtube-quota-types";

interface DailyBucketUsage {
  usedGeneral: number;
  usedSearch: number;
  reservedGeneral: number;
  reservedSearch: number;
}

interface ActiveReservation {
  reservationToken: string;
  idempotencyKey?: string;
  projectId: string;
  pacificDate: string;
  generalUnits: number;
  searchCalls: number;
  expiresAt: Date;
  committed: boolean;
  released: boolean;
  resetsAt: Date;
  secondsUntilReset: number;
}

/**
 * In-memory concurrency-safe quota store for unit testing and offline environments.
 * Supports active lease expiration, idempotency key replay, and automatic reclamation of crashed worker leases.
 */
export class MemoryYouTubeQuotaStore implements YouTubeQuotaStore {
  // Key format: `${projectId}:${pacificDate}`
  private usage = new Map<string, DailyBucketUsage>();
  private reservations = new Map<string, ActiveReservation>();
  private idempotencyIndex = new Map<string, string>(); // `${projectId}:${idempotencyKey}` -> reservationToken
  private defaultProjectId: string;

  constructor(defaultProjectId: string = "sonora-default-google-project") {
    this.defaultProjectId = defaultProjectId;
  }

  private getKey(projectId: string, pacificDate: string): string {
    return `${projectId}:${pacificDate}`;
  }

  private getOrCreateBucket(projectId: string, pacificDate: string): DailyBucketUsage {
    const key = this.getKey(projectId, pacificDate);
    let bucket = this.usage.get(key);
    if (!bucket) {
      bucket = {
        usedGeneral: 0,
        usedSearch: 0,
        reservedGeneral: 0,
        reservedSearch: 0,
      };
      this.usage.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Reclaims any uncommitted, unreleased reservations whose lease has expired.
   */
  private reclaimExpired(now: Date = new Date()): void {
    const nowTime = now.getTime();
    for (const res of this.reservations.values()) {
      if (!res.committed && !res.released && res.expiresAt.getTime() <= nowTime) {
        const bucket = this.getOrCreateBucket(res.projectId, res.pacificDate);
        bucket.reservedGeneral = Math.max(0, bucket.reservedGeneral - res.generalUnits);
        bucket.reservedSearch = Math.max(0, bucket.reservedSearch - res.searchCalls);
        res.released = true;
        if (res.idempotencyKey) {
          this.idempotencyIndex.delete(`${res.projectId}:${res.idempotencyKey}`);
        }
      }
    }
  }

  public async reserve(request: QuotaReservationRequest): Promise<QuotaReservationResult> {
    const now = request.now ?? new Date();
    this.reclaimExpired(now);

    const projectId = request.projectId || this.defaultProjectId;
    const generalRequested = Math.max(0, request.generalUnits);
    const searchRequested = Math.max(0, request.searchCalls ?? 0);
    const generalLimit = request.customGeneralLimit ?? DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT;
    const searchLimit = request.customSearchLimit ?? DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT;
    const leaseDurationSeconds = request.leaseDurationSeconds ?? 300;

    const { pacificDate, nextMidnightUtc, secondsUntilReset } = getPacificTimeResetWindow(now);
    const bucket = this.getOrCreateBucket(projectId, pacificDate);

    // Check for idempotent replay
    if (request.idempotencyKey) {
      const existingToken = this.idempotencyIndex.get(`${projectId}:${request.idempotencyKey}`);
      if (existingToken) {
        const existing = this.reservations.get(existingToken);
        if (existing && !existing.released && existing.expiresAt.getTime() > now.getTime()) {
          return {
            success: true,
            reservationToken: existing.reservationToken,
            idempotencyKey: existing.idempotencyKey,
            isReplay: true,
            projectId: existing.projectId,
            pacificDate: existing.pacificDate,
            generalUnitsReserved: existing.generalUnits,
            searchCallsReserved: existing.searchCalls,
            remainingGeneralUnits: Math.max(
              0,
              generalLimit - (bucket.usedGeneral + bucket.reservedGeneral)
            ),
            remainingSearchCalls: Math.max(
              0,
              searchLimit - (bucket.usedSearch + bucket.reservedSearch)
            ),
            resetsAt: existing.resetsAt,
            secondsUntilReset: existing.secondsUntilReset,
            expiresAt: existing.expiresAt,
          };
        }
      }
    }

    // 1. Check General Quota
    const totalGeneral = bucket.usedGeneral + bucket.reservedGeneral + generalRequested;
    if (totalGeneral > generalLimit) {
      throw new ProviderQuotaExhaustedError({
        provider: "YOUTUBE_MUSIC",
        quotaBucket: "GENERAL",
        limit: generalLimit,
        requested: generalRequested,
        remaining: Math.max(0, generalLimit - (bucket.usedGeneral + bucket.reservedGeneral)),
        resetsAt: nextMidnightUtc,
        projectId,
      });
    }

    // 2. Check Search Quota
    const totalSearch = bucket.usedSearch + bucket.reservedSearch + searchRequested;
    if (totalSearch > searchLimit) {
      throw new ProviderQuotaExhaustedError({
        provider: "YOUTUBE_MUSIC",
        quotaBucket: "SEARCH",
        limit: searchLimit,
        requested: searchRequested,
        remaining: Math.max(0, searchLimit - (bucket.usedSearch + bucket.reservedSearch)),
        resetsAt: nextMidnightUtc,
        projectId,
      });
    }

    // 3. Atomically advance reserved counters
    bucket.reservedGeneral += generalRequested;
    bucket.reservedSearch += searchRequested;

    const reservationToken = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseDurationSeconds * 1000);

    const reservation: ActiveReservation = {
      reservationToken,
      idempotencyKey: request.idempotencyKey,
      projectId,
      pacificDate,
      generalUnits: generalRequested,
      searchCalls: searchRequested,
      expiresAt,
      committed: false,
      released: false,
      resetsAt: nextMidnightUtc,
      secondsUntilReset,
    };

    this.reservations.set(reservationToken, reservation);
    if (request.idempotencyKey) {
      this.idempotencyIndex.set(`${projectId}:${request.idempotencyKey}`, reservationToken);
    }

    return {
      success: true,
      reservationToken,
      idempotencyKey: request.idempotencyKey,
      isReplay: false,
      projectId,
      pacificDate,
      generalUnitsReserved: generalRequested,
      searchCallsReserved: searchRequested,
      remainingGeneralUnits: Math.max(
        0,
        generalLimit - (bucket.usedGeneral + bucket.reservedGeneral)
      ),
      remainingSearchCalls: Math.max(
        0,
        searchLimit - (bucket.usedSearch + bucket.reservedSearch)
      ),
      resetsAt: nextMidnightUtc,
      secondsUntilReset,
      expiresAt,
    };
  }

  public async commit(reservationToken: string, projectId?: string): Promise<void> {
    const res = this.reservations.get(reservationToken);
    if (!res || res.committed || res.released) {
      return;
    }
    const pid = projectId || res.projectId;
    const bucket = this.getOrCreateBucket(pid, res.pacificDate);

    bucket.reservedGeneral = Math.max(0, bucket.reservedGeneral - res.generalUnits);
    bucket.usedGeneral += res.generalUnits;

    bucket.reservedSearch = Math.max(0, bucket.reservedSearch - res.searchCalls);
    bucket.usedSearch += res.searchCalls;

    res.committed = true;
    if (res.idempotencyKey) {
      this.idempotencyIndex.delete(`${pid}:${res.idempotencyKey}`);
    }
  }

  public async consume(request: QuotaConsumptionRequest): Promise<QuotaConsumptionResult> {
    const res = await this.reserve({
      projectId: request.projectId,
      generalUnits: request.generalUnits,
      searchCalls: request.searchCalls,
      customGeneralLimit: request.customGeneralLimit,
      customSearchLimit: request.customSearchLimit,
      now: request.now,
    });

    await this.commit(res.reservationToken, res.projectId);

    return {
      success: true,
      projectId: res.projectId,
      pacificDate: res.pacificDate,
      generalUnitsConsumed: res.generalUnitsReserved,
      searchCallsConsumed: res.searchCallsReserved,
      remainingGeneralUnits: res.remainingGeneralUnits,
      remainingSearchCalls: res.remainingSearchCalls,
      resetsAt: res.resetsAt,
      secondsUntilReset: res.secondsUntilReset,
    };
  }

  public async release(request: QuotaReleaseRequest): Promise<void> {
    if (request.reservationToken) {
      const res = this.reservations.get(request.reservationToken);
      if (res && !res.committed && !res.released) {
        const bucket = this.getOrCreateBucket(res.projectId, res.pacificDate);
        bucket.reservedGeneral = Math.max(0, bucket.reservedGeneral - res.generalUnits);
        bucket.reservedSearch = Math.max(0, bucket.reservedSearch - res.searchCalls);
        res.released = true;
        if (res.idempotencyKey) {
          this.idempotencyIndex.delete(`${res.projectId}:${res.idempotencyKey}`);
        }
        return;
      }
    }

    const projectId = request.projectId || this.defaultProjectId;
    const pacificDate =
      request.pacificDate || getPacificTimeResetWindow().pacificDate;
    const bucket = this.getOrCreateBucket(projectId, pacificDate);

    bucket.usedGeneral = Math.max(0, bucket.usedGeneral - Math.max(0, request.generalUnits));
    bucket.usedSearch = Math.max(0, bucket.usedSearch - Math.max(0, request.searchCalls ?? 0));
  }

  public async getStatus(projectId?: string, now?: Date): Promise<ProjectQuotaStatus> {
    const n = now ?? new Date();
    this.reclaimExpired(n);

    const pid = projectId || this.defaultProjectId;
    const { pacificDate, nextMidnightUtc, secondsUntilReset } = getPacificTimeResetWindow(n);
    const bucket = this.getOrCreateBucket(pid, pacificDate);

    const remainingGen = Math.max(
      0,
      DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT - (bucket.usedGeneral + bucket.reservedGeneral)
    );
    const remainingSearch = Math.max(
      0,
      DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT - (bucket.usedSearch + bucket.reservedSearch)
    );

    return {
      projectId: pid,
      pacificDate,
      usedGeneralUnits: bucket.usedGeneral,
      reservedGeneralUnits: bucket.reservedGeneral,
      remainingGeneralUnits: remainingGen,
      generalLimit: DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
      usedSearchCalls: bucket.usedSearch,
      reservedSearchCalls: bucket.reservedSearch,
      remainingSearchCalls: remainingSearch,
      searchLimit: DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
      resetsAt: nextMidnightUtc,
      secondsUntilReset,
    };
  }

  public async reset(projectId?: string, now?: Date): Promise<void> {
    const pid = projectId || this.defaultProjectId;
    const { pacificDate } = getPacificTimeResetWindow(now);
    const key = this.getKey(pid, pacificDate);
    this.usage.delete(key);
    for (const [token, res] of this.reservations.entries()) {
      if (res.projectId === pid) {
        this.reservations.delete(token);
        if (res.idempotencyKey) {
          this.idempotencyIndex.delete(`${pid}:${res.idempotencyKey}`);
        }
      }
    }
  }
}
