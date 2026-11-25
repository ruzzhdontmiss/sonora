/**
 * Type definitions for YouTube Data API v3 quota accounting, reservations, and estimation.
 */

export type QuotaBucket = "GENERAL" | "SEARCH";

export interface QuotaReservationRequest {
  /** Google Cloud Project identifier (defaults to configured project) */
  projectId?: string;
  /** Number of general quota units requested (e.g. 50 for track insert) */
  generalUnits: number;
  /** Number of search.list calls requested (e.g. 1 for search) */
  searchCalls?: number;
  /** Optional idempotency key (e.g. job ID or retry attempt) to prevent double-charging on retries */
  idempotencyKey?: string;
  /** Lease duration in seconds before an uncommitted reservation expires (default: 300s = 5m) */
  leaseDurationSeconds?: number;
  /** Optional custom limit override for general quota (defaults to 10,000) */
  customGeneralLimit?: number;
  /** Optional custom limit override for search quota (defaults to 100) */
  customSearchLimit?: number;
  /** Optional reference time for testing or deterministic time windows */
  now?: Date;
}

export interface QuotaReservationResult {
  success: boolean;
  reservationToken: string;
  idempotencyKey?: string;
  isReplay?: boolean;
  projectId: string;
  pacificDate: string;
  generalUnitsReserved: number;
  searchCallsReserved: number;
  remainingGeneralUnits: number;
  remainingSearchCalls: number;
  resetsAt: Date;
  secondsUntilReset: number;
  expiresAt: Date;
}

export interface QuotaConsumptionRequest {
  projectId?: string;
  generalUnits: number;
  searchCalls?: number;
  operation?: string;
  customGeneralLimit?: number;
  customSearchLimit?: number;
  now?: Date;
}

export interface QuotaConsumptionResult {
  success: boolean;
  projectId: string;
  pacificDate: string;
  generalUnitsConsumed: number;
  searchCallsConsumed: number;
  remainingGeneralUnits: number;
  remainingSearchCalls: number;
  resetsAt: Date;
  secondsUntilReset: number;
}

export interface QuotaReleaseRequest {
  projectId?: string;
  generalUnits: number;
  searchCalls?: number;
  pacificDate?: string;
  reservationToken?: string;
}

export interface ProjectQuotaStatus {
  projectId: string;
  pacificDate: string;
  usedGeneralUnits: number;
  reservedGeneralUnits: number;
  remainingGeneralUnits: number;
  generalLimit: number;
  usedSearchCalls: number;
  reservedSearchCalls: number;
  remainingSearchCalls: number;
  searchLimit: number;
  resetsAt: Date;
  secondsUntilReset: number;
}

export interface YouTubeQuotaEstimationParams {
  /** Number of new playlists to create (50 units each) */
  playlistsToCreate?: number;
  /** Number of individual track insertions to execute (50 units each) */
  tracksToInsert?: number;
  /** Number of playlist list pages to read (1 unit each, up to 50 playlists/page) */
  playlistPagesToRead?: number;
  /** Number of playlist item pages to read (1 unit each, up to 50 tracks/page) */
  playlistItemPagesToRead?: number;
  /** Number of liked videos pages to read (1 unit each, up to 50 items/page, max 1,000 total) */
  likedTrackPagesToRead?: number;
  /** Number of tracks to rate as liked via POST /videos/rate (50 units each) */
  tracksToRateAsLiked?: number;
  /** Number of track searches via GET /search (0 units from general pool + 1 search call) */
  searchCalls?: number;
  /**
   * Number of tracks already resolved from canonical mappings or ISRC cache.
   * Consumes 0 units and 0 search calls.
   */
  knownTrackMappingsCount?: number;
  /**
   * Number of searches answered from short-term cache.
   * Consumes 0 units and 0 search calls.
   */
  cachedSearchResultsCount?: number;
  /**
   * Configurable engineering planning retry allowance (e.g., 0.05 for 5%).
   * Defaults to 0.05. Explicitly documented as a planning assumption, not a provider guarantee.
   */
  retryAllowanceRatio?: number;
  /** Currently remaining general units for this project (defaults to 10,000) */
  remainingGeneralUnits?: number;
  /** Currently remaining search calls for this project (defaults to 100) */
  remainingSearchCalls?: number;
  /** Total daily general quota limit (defaults to 10,000) */
  dailyGeneralLimit?: number;
  /** Total daily search calls limit (defaults to 100) */
  dailySearchLimit?: number;
}

export interface YouTubeQuotaEstimationResult {
  /** Base general units before retry allowance */
  baseGeneralUnits: number;
  /** Calculated retry allowance units based on the planning assumption */
  retryAllowanceUnits: number;
  /** Total estimated general units including retry allowance */
  totalEstimatedGeneralUnits: number;
  /** Base search calls required */
  baseSearchCalls: number;
  /** Total search calls required */
  totalEstimatedSearchCalls: number;
  /** Configured retry allowance ratio applied (e.g. 0.05) */
  appliedRetryAllowanceRatio: number;
  /** Breakdown of units by operation */
  breakdown: {
    playlistCreationUnits: number;
    trackInsertionUnits: number;
    readUnits: number;
    likedTracksUnits: number;
    searchUnits: number;
    retryBufferUnits: number;
    knownMappingsAvoidedUnits: number;
    cachedSearchesAvoidedCalls: number;
  };
  limits: {
    dailyGeneralLimit: number;
    dailySearchLimit: number;
    remainingGeneralUnits: number;
    remainingSearchCalls: number;
  };
  feasibility: {
    /** Whether the operation can proceed immediately given current project remaining quota */
    isFeasibleWithCurrentQuota: boolean;
    /** Whether the operation could fit within a single fresh day's total quota */
    isFeasibleWithinSingleDayCeiling: boolean;
    /** Whether general units exceed remaining budget */
    exceedsGeneralQuota: boolean;
    /** Whether search calls exceed remaining budget */
    exceedsSearchQuota: boolean;
    /** Theoretical maximum track insertions feasible with current available quota */
    maxInsertableTracksInCurrentQuota: number;
    /** Estimated number of 24h reset cycles (days) needed to complete this migration */
    estimatedDaysRequired: number;
    /** Transparent explanation of the feasibility status and constraints */
    rationale: string;
  };
}
