import {
  DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO,
  DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT,
  DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT,
  YOUTUBE_QUOTA_UNIT_COSTS,
} from "./youtube-quota-constants";
import {
  YouTubeQuotaEstimationParams,
  YouTubeQuotaEstimationResult,
} from "./youtube-quota-types";

/**
 * Pure, deterministic Quota Estimator for YouTube Data API v3 operations.
 *
 * Implements realistic planning models covering:
 * - Playlist creations (50 units each)
 * - Single-track insertions (50 units each)
 * - Paginated reads (1 unit per 50-item page)
 * - Liked video rating writes (50 units each)
 * - Track searches (0 units general + 1 search call)
 * - Known mappings & cached search savings
 * - Configurable planning retry allowance (default: 5%, an engineering assumption, NOT a provider guarantee)
 * - Project-level remaining quota and multi-day duration projections
 */
export function estimateYouTubeQuota(
  params: YouTubeQuotaEstimationParams = {}
): YouTubeQuotaEstimationResult {
  const playlistsToCreate = Math.max(0, params.playlistsToCreate ?? 0);
  const tracksToInsert = Math.max(0, params.tracksToInsert ?? 0);
  const playlistPagesToRead = Math.max(0, params.playlistPagesToRead ?? 0);
  const playlistItemPagesToRead = Math.max(0, params.playlistItemPagesToRead ?? 0);
  const likedTrackPagesToRead = Math.max(0, params.likedTrackPagesToRead ?? 0);
  const tracksToRateAsLiked = Math.max(0, params.tracksToRateAsLiked ?? 0);
  const searchCalls = Math.max(0, params.searchCalls ?? 0);
  const knownTrackMappingsCount = Math.max(0, params.knownTrackMappingsCount ?? 0);
  const cachedSearchResultsCount = Math.max(0, params.cachedSearchResultsCount ?? 0);

  const appliedRetryAllowanceRatio =
    params.retryAllowanceRatio !== undefined
      ? Math.max(0, params.retryAllowanceRatio)
      : DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO;

  const dailyGeneralLimit =
    params.dailyGeneralLimit ?? DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT;
  const dailySearchLimit =
    params.dailySearchLimit ?? DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT;

  const remainingGeneralUnits =
    params.remainingGeneralUnits !== undefined
      ? Math.max(0, params.remainingGeneralUnits)
      : dailyGeneralLimit;
  const remainingSearchCalls =
    params.remainingSearchCalls !== undefined
      ? Math.max(0, params.remainingSearchCalls)
      : dailySearchLimit;

  // 1. Calculate base unit costs
  const playlistCreationUnits =
    playlistsToCreate * YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_CREATE;
  const trackInsertionUnits =
    tracksToInsert * YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_ITEM_INSERT;
  const readUnits =
    (playlistPagesToRead * YOUTUBE_QUOTA_UNIT_COSTS.PLAYLISTS_LIST) +
    (playlistItemPagesToRead * YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_ITEMS_LIST) +
    (likedTrackPagesToRead * YOUTUBE_QUOTA_UNIT_COSTS.VIDEOS_LIST);
  const likedTracksUnits =
    tracksToRateAsLiked * YOUTUBE_QUOTA_UNIT_COSTS.VIDEO_RATE_LIKE;
  // search.list consumes 0 units from General bucket and 1 call from Search bucket
  const searchUnits =
    searchCalls * YOUTUBE_QUOTA_UNIT_COSTS.SEARCH_LIST_GENERAL_UNITS;

  const baseGeneralUnits =
    playlistCreationUnits +
    trackInsertionUnits +
    readUnits +
    likedTracksUnits +
    searchUnits;

  // 2. Apply engineering retry buffer (planning assumption)
  const retryAllowanceUnits = Math.ceil(baseGeneralUnits * appliedRetryAllowanceRatio);
  const totalEstimatedGeneralUnits = baseGeneralUnits + retryAllowanceUnits;

  const baseSearchCalls = searchCalls;
  const totalEstimatedSearchCalls = searchCalls; // Search bucket counts discrete calls

  // Savings through cache and existing canonical mappings
  const knownMappingsAvoidedUnits = knownTrackMappingsCount * YOUTUBE_QUOTA_UNIT_COSTS.SEARCH_LIST_GENERAL_UNITS;
  const cachedSearchesAvoidedCalls = cachedSearchResultsCount;

  // 3. Evaluate feasibility against current available project quota
  const exceedsGeneralQuota = totalEstimatedGeneralUnits > remainingGeneralUnits;
  const exceedsSearchQuota = totalEstimatedSearchCalls > remainingSearchCalls;
  const isFeasibleWithCurrentQuota = !exceedsGeneralQuota && !exceedsSearchQuota;

  // 4. Evaluate feasibility against single-day ceiling (assuming 100% fresh quota)
  const fitsSingleDayGeneral = totalEstimatedGeneralUnits <= dailyGeneralLimit;
  const fitsSingleDaySearch = totalEstimatedSearchCalls <= dailySearchLimit;
  const isFeasibleWithinSingleDayCeiling = fitsSingleDayGeneral && fitsSingleDaySearch;

  // 5. Max insertable tracks in current quota (after reserving non-insert units)
  const nonInsertUnitsWithBuffer = Math.ceil(
    (playlistCreationUnits + readUnits + likedTracksUnits + searchUnits) *
      (1 + appliedRetryAllowanceRatio)
  );
  const remainingForInserts = Math.max(
    0,
    remainingGeneralUnits - nonInsertUnitsWithBuffer
  );
  const effectiveCostPerInsertWithBuffer =
    YOUTUBE_QUOTA_UNIT_COSTS.PLAYLIST_ITEM_INSERT * (1 + appliedRetryAllowanceRatio);
  const maxInsertableTracksInCurrentQuota = Math.floor(
    remainingForInserts / effectiveCostPerInsertWithBuffer
  );

  // 6. Multi-day duration projection
  let estimatedDaysRequired = 1;
  if (!isFeasibleWithinSingleDayCeiling) {
    const generalDays = Math.ceil(totalEstimatedGeneralUnits / dailyGeneralLimit);
    const searchDays =
      totalEstimatedSearchCalls > 0
        ? Math.ceil(totalEstimatedSearchCalls / dailySearchLimit)
        : 1;
    estimatedDaysRequired = Math.max(generalDays, searchDays);
  } else if (!isFeasibleWithCurrentQuota) {
    // Fits in 1 fresh day, but current day's remaining quota is insufficient -> needs next reset
    estimatedDaysRequired = 2;
  }

  // 7. Explanatory rationale
  let rationale = "Operation is feasible within current available project quota.";
  if (!isFeasibleWithCurrentQuota) {
    const reasons: string[] = [];
    if (exceedsGeneralQuota) {
      reasons.push(
        `Requires ${totalEstimatedGeneralUnits} general units (${baseGeneralUnits} base + ${retryAllowanceUnits} retry allowance), but only ${remainingGeneralUnits} units remain today`
      );
    }
    if (exceedsSearchQuota) {
      reasons.push(
        `Requires ${totalEstimatedSearchCalls} search calls, but only ${remainingSearchCalls} search calls remain today`
      );
    }
    if (!isFeasibleWithinSingleDayCeiling) {
      reasons.push(
        `Total workload exceeds single-day project ceiling (${dailyGeneralLimit} units / ${dailySearchLimit} search calls) and requires approximately ${estimatedDaysRequired} daily reset cycles`
      );
    } else {
      reasons.push("Workload fits in a fresh 24h quota cycle after midnight Pacific Time reset");
    }
    rationale = reasons.join("; ");
  }

  return {
    baseGeneralUnits,
    retryAllowanceUnits,
    totalEstimatedGeneralUnits,
    baseSearchCalls,
    totalEstimatedSearchCalls,
    appliedRetryAllowanceRatio,
    breakdown: {
      playlistCreationUnits,
      trackInsertionUnits,
      readUnits,
      likedTracksUnits,
      searchUnits,
      retryBufferUnits: retryAllowanceUnits,
      knownMappingsAvoidedUnits,
      cachedSearchesAvoidedCalls,
    },
    limits: {
      dailyGeneralLimit,
      dailySearchLimit,
      remainingGeneralUnits,
      remainingSearchCalls,
    },
    feasibility: {
      isFeasibleWithCurrentQuota,
      isFeasibleWithinSingleDayCeiling,
      exceedsGeneralQuota,
      exceedsSearchQuota,
      maxInsertableTracksInCurrentQuota,
      estimatedDaysRequired,
      rationale,
    },
  };
}
