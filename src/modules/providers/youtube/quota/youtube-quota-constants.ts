/**
 * Official YouTube Data API v3 quota constants, unit costs, and Pacific Time calculations.
 *
 * References:
 * - Google Cloud Console YouTube Data API v3 Quota Limits
 * - Default general daily quota: 10,000 units per project, resetting at midnight Pacific Time (PT).
 * - Dedicated search bucket: 100 search.list calls per day per project.
 */

export const PACIFIC_TIMEZONE = "America/Los_Angeles";

export const DEFAULT_YOUTUBE_GENERAL_QUOTA_LIMIT = 10_000;
export const DEFAULT_YOUTUBE_SEARCH_QUOTA_LIMIT = 100;

/**
 * Engineering planning retry allowance (5%).
 * IMPORTANT: This is an internal engineering planning assumption to account for
 * network retries and transient errors, NOT a provider-guaranteed quota or buffer.
 */
export const DEFAULT_PLANNING_RETRY_ALLOWANCE_RATIO = 0.05;

/**
 * YouTube Data API v3 operation unit costs.
 */
export const YOUTUBE_QUOTA_UNIT_COSTS = {
  /** POST /playlistItems (single track append per call) */
  PLAYLIST_ITEM_INSERT: 50,
  /** POST /playlists (create a playlist) */
  PLAYLIST_CREATE: 50,
  /** POST /videos/rate?rating=like (rate a video as liked) */
  VIDEO_RATE_LIKE: 50,
  /** GET /playlistItems (read items page, max 50 items/page) */
  PLAYLIST_ITEMS_LIST: 1,
  /** GET /playlists (read user playlists page, max 50 items/page) */
  PLAYLISTS_LIST: 1,
  /** GET /videos?myRating=like (read liked videos page, max 50 items/page, 1,000 max ceiling) */
  VIDEOS_LIST: 1,
  /** GET /channels (read channel contentDetails / relatedPlaylists) */
  CHANNELS_LIST: 1,
  /** GET /search (catalog track search: consumes 0 units from general pool and 1 call from dedicated search pool) */
  SEARCH_LIST_GENERAL_UNITS: 0,
  SEARCH_LIST_CALLS: 1,
} as const;

/**
 * Theoretical vs. Planning write limits for a single day on a dedicated 10,000 unit pool:
 * - Theoretical ceiling: 199 track insertions (10,000 - 50 units for 1 playlist create = 9,950 / 50 = 199 items).
 * - Planning estimate: ~189 tracks (199 / 1.05 with 5% engineering retry allowance).
 */
export const THEORETICAL_SINGLE_DAY_WRITE_CEILING = 199;
export const PLANNING_SINGLE_DAY_WRITE_ESTIMATE = 189;

export interface PacificTimeResetWindow {
  /** Calendar date in America/Los_Angeles formatted as YYYY-MM-DD */
  pacificDate: string;
  /** Exact UTC instant when midnight Pacific Time will occur */
  nextMidnightUtc: Date;
  /** Seconds remaining until the next midnight Pacific Time reset */
  secondsUntilReset: number;
}

/**
 * Computes the current Pacific Time calendar date and the exact UTC instant of the
 * next midnight Pacific Time reset.
 *
 * Handles daylight saving time transitions (PST UTC-8 vs. PDT UTC-7) cleanly
 * without external timezone libraries.
 */
export function getPacificTimeResetWindow(now: Date = new Date()): PacificTimeResetWindow {
  // Format current date in America/Los_Angeles as YYYY-MM-DD
  const pacificDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const [year, month, day] = pacificDate.split("-").map(Number);

  // Next calendar day in PT:
  const nextDayRef = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const nextPtDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nextDayRef);

  const [nextYear, nextMonth, nextDayNum] = nextPtDateStr.split("-").map(Number);

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Base candidate for midnight next day PT is UTC 08:00 (PST)
  let nextMidnightUtc = new Date(Date.UTC(nextYear, nextMonth - 1, nextDayNum, 8, 0, 0, 0));
  const ptHour = timeFormatter.format(nextMidnightUtc);

  if (ptHour === "01:00:00") {
    // PDT (UTC-7) is active: midnight occurred at UTC 07:00
    nextMidnightUtc = new Date(Date.UTC(nextYear, nextMonth - 1, nextDayNum, 7, 0, 0, 0));
  } else if (ptHour === "23:00:00") {
    // UTC-9 edge transition
    nextMidnightUtc = new Date(Date.UTC(nextYear, nextMonth - 1, nextDayNum, 9, 0, 0, 0));
  }

  const secondsUntilReset = Math.max(
    0,
    Math.round((nextMidnightUtc.getTime() - now.getTime()) / 1000)
  );

  return {
    pacificDate,
    nextMidnightUtc,
    secondsUntilReset,
  };
}
