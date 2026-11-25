import { MatchMethod, ProviderType, TrackMatchReviewStatus } from "@prisma/client";
import {
  normalizeTrackMetadata,
  normalizeComparableString,
  TrackRecordingType,
  NormalizedTrackMetadata,
} from "./metadata-normalizer";
import {
  parseYouTubeDuration,
  extractIsrcFromYouTubeDescription,
  parseYouTubeVideoTitle,
} from "./youtube-normalizer";
import { getYouTubeQuotaManager } from "@/modules/providers/youtube/quota/youtube-quota-manager";
import { getRedisClient } from "@/lib/redis";
import crypto from "crypto";

export interface CandidateTrack {
  id: string; // provider external ID or URI
  provider: ProviderType;
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  isrc?: string | null;
  explicit?: boolean;
  uri?: string | null;
  rawMetadata?: Record<string, unknown>;
}

export interface MatchScoreBreakdown {
  isrcMatch: boolean;
  isrcScore: number;
  titleSimilarity: number;
  titleScore: number;
  artistOverlap: number;
  artistScore: number;
  durationDiffMs: number;
  durationScore: number;
  sourceRecordingType: TrackRecordingType;
  candidateRecordingType: TrackRecordingType;
  versionScore: number;
  albumMatch: boolean;
  albumScore: number;
  explicitMismatch: boolean;
  explicitPenalty: number;
  rawTotal: number;
  finalScore: number;
}

export interface MatchEvidence {
  score: number;
  confidenceCategory: "EXACT" | "HIGH" | "MEDIUM" | "LOW";
  isAmbiguous: boolean;
  isConflict: boolean;
  conflictReason: string | null;
  sourceTrack: {
    title: string;
    artistName: string;
    albumName?: string | null;
    durationMs: number;
    isrc?: string | null;
    explicit?: boolean;
    recordingType: TrackRecordingType;
  };
  candidateTrack: {
    id: string;
    provider: ProviderType;
    title: string;
    artistName: string;
    albumName?: string | null;
    durationMs: number;
    isrc?: string | null;
    explicit?: boolean;
    recordingType: TrackRecordingType;
  };
  scoreDifferenceWithNext?: number | null;
  breakdown: MatchScoreBreakdown;
}

export interface CandidateScoreRecord {
  candidate: CandidateTrack;
  score: number;
  breakdown: MatchScoreBreakdown;
}

export interface MatchResult {
  bestMatch: CandidateTrack | null;
  confidence: number;
  category: "EXACT" | "HIGH" | "MEDIUM" | "LOW";
  method: MatchMethod;
  reviewStatus: TrackMatchReviewStatus;
  isAmbiguous: boolean;
  isConflict: boolean;
  conflictReason: string | null;
  evidence: MatchEvidence | null;
  candidates: CandidateScoreRecord[];
}

/**
 * Calculates Levenshtein edit distance between two strings.
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculates a normalized string similarity in [0, 1].
 * Combines character-level Levenshtein similarity and word-token Sorensen-Dice similarity.
 */
export function calculateStringSimilarity(strA: string, strB: string): number {
  const normA = normalizeComparableString(strA);
  const normB = normalizeComparableString(strB);

  if (!normA && !normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  // Character Levenshtein ratio
  const maxLen = Math.max(normA.length, normB.length);
  const distance = calculateLevenshteinDistance(normA, normB);
  const charSim = Math.max(0, 1 - distance / maxLen);

  // Word token Sorensen-Dice similarity
  const tokensA = new Set(normA.split(/\s+/).filter(Boolean));
  const tokensB = new Set(normB.split(/\s+/).filter(Boolean));
  let intersectionCount = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionCount++;
    }
  }
  const tokenSim = (2 * intersectionCount) / (tokensA.size + tokensB.size);

  // Weighted combination
  return Math.min(1.0, Math.max(0.0, 0.4 * charSim + 0.6 * tokenSim));
}

/**
 * Calculates artist overlap between source track and candidate track metadata.
 */
export function calculateArtistOverlap(
  sourceMeta: NormalizedTrackMetadata,
  candidateMeta: NormalizedTrackMetadata
): number {
  const normSourcePrimary = normalizeComparableString(sourceMeta.primaryArtist);
  const normCandidatePrimary = normalizeComparableString(candidateMeta.primaryArtist);

  if (normSourcePrimary && normCandidatePrimary && normSourcePrimary === normCandidatePrimary) {
    return 1.0;
  }

  // Primary artist similarity
  const primarySim = calculateStringSimilarity(
    sourceMeta.primaryArtist,
    candidateMeta.primaryArtist
  );

  // Check if candidate primary is in source's full artists set or vice versa
  const sourceArtistsNorm = new Set(sourceMeta.allArtists.map(normalizeComparableString));
  const candidateArtistsNorm = new Set(candidateMeta.allArtists.map(normalizeComparableString));

  if (sourceArtistsNorm.has(normCandidatePrimary) || candidateArtistsNorm.has(normSourcePrimary)) {
    return Math.max(primarySim, 0.90);
  }

  // Jaccard similarity across all credited artists
  let sharedCount = 0;
  for (const art of sourceArtistsNorm) {
    if (candidateArtistsNorm.has(art)) {
      sharedCount++;
    }
  }
  const unionSize = new Set([...sourceArtistsNorm, ...candidateArtistsNorm]).size;
  const jaccard = unionSize > 0 ? sharedCount / unionSize : 0;

  return Math.min(1.0, Math.max(primarySim, jaccard));
}

/**
 * Computes deterministic score breakdown for a single candidate against the source track.
 *
 * NOTE: The resulting finalScore is a heuristic ranking metric normalized to [0, 1],
 * NOT a statistical or Bayesian probability. It ranks candidates by weighted metadata
 * alignment (ISRC, title similarity, artist overlap, duration delta, version isolation)
 * and is subject to discrete gating rules (ISRC contradiction checks, version mismatch penalties,
 * and ambiguity delta thresholds) before any auto-match determination is made.
 */
export function scoreCandidate(
  source: {
    title: string;
    artistName: string;
    albumName?: string | null;
    durationMs: number;
    isrc?: string | null;
    explicit?: boolean;
  },
  candidate: CandidateTrack
): MatchScoreBreakdown {
  const sourceMeta = normalizeTrackMetadata(source);
  const candidateMeta = normalizeTrackMetadata(candidate);

  // 1. ISRC exact match (+0.60)
  const cleanSourceIsrc = source.isrc?.trim().toUpperCase();
  const cleanCandIsrc = candidate.isrc?.trim().toUpperCase();
  const isrcMatch = Boolean(
    cleanSourceIsrc &&
    cleanCandIsrc &&
    cleanSourceIsrc.length >= 10 &&
    cleanCandIsrc.length >= 10 &&
    cleanSourceIsrc === cleanCandIsrc
  );
  const isrcScore = isrcMatch ? 0.60 : 0.0;

  // 2. Title similarity (+0.25)
  const titleSimilarity = calculateStringSimilarity(
    sourceMeta.cleanTitle,
    candidateMeta.cleanTitle
  );
  const titleScore = Number((titleSimilarity * 0.25).toFixed(4));

  // 3. Artist overlap (+0.20)
  const artistOverlap = calculateArtistOverlap(sourceMeta, candidateMeta);
  const artistScore = Number((artistOverlap * 0.20).toFixed(4));

  // 4. Duration difference (+0.10 for <=3s, +0.05 for <=8s, -0.30 penalty for >30s)
  const durationDiffMs = Math.abs(source.durationMs - candidate.durationMs);
  let durationScore = 0.0;
  if (durationDiffMs <= 3000) {
    durationScore = 0.10;
  } else if (durationDiffMs <= 8000) {
    durationScore = 0.05;
  } else if (durationDiffMs > 30000) {
    durationScore = -0.30;
  }

  // 5. Version match / isolation (+0.05 on match, -0.40 on version mismatch)
  const sourceRecordingType = sourceMeta.recordingType;
  const candidateRecordingType = candidateMeta.recordingType;
  let versionScore = 0.0;
  if (sourceRecordingType === candidateRecordingType) {
    versionScore = 0.05;
  } else {
    // If one is Live/Remix/Acoustic/Instrumental and the other is different, heavy penalty
    versionScore = -0.40;
  }

  // 6. Album match (+0.05)
  let albumMatch = false;
  let albumScore = 0.0;
  if (source.albumName && candidate.albumName) {
    const normSourceAlbum = normalizeComparableString(source.albumName);
    const normCandAlbum = normalizeComparableString(candidate.albumName);
    if (normSourceAlbum && normCandAlbum && (
      normSourceAlbum === normCandAlbum ||
      calculateStringSimilarity(source.albumName, candidate.albumName) >= 0.80
    )) {
      albumMatch = true;
      albumScore = 0.05;
    }
  }

  // 7. Explicit / Clean mismatch (-0.15 penalty)
  let explicitMismatch = false;
  let explicitPenalty = 0.0;
  if (
    source.explicit !== undefined &&
    candidate.explicit !== undefined &&
    source.explicit !== candidate.explicit
  ) {
    explicitMismatch = true;
    explicitPenalty = 0.15;
  }

  const rawTotal =
    isrcScore +
    titleScore +
    artistScore +
    durationScore +
    versionScore +
    albumScore -
    explicitPenalty;

  const finalScore = Number(Math.max(0.0, Math.min(1.0, rawTotal)).toFixed(4));

  return {
    isrcMatch,
    isrcScore,
    titleSimilarity,
    titleScore,
    artistOverlap,
    artistScore,
    durationDiffMs,
    durationScore,
    sourceRecordingType,
    candidateRecordingType,
    versionScore,
    albumMatch,
    albumScore,
    explicitMismatch,
    explicitPenalty,
    rawTotal: Number(rawTotal.toFixed(4)),
    finalScore,
  };
}

/**
 * Categorizes a final confidence score.
 */
export function categorizeScore(score: number): "EXACT" | "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.95) return "EXACT";
  if (score >= 0.82) return "HIGH";
  if (score >= 0.60) return "MEDIUM";
  return "LOW";
}

/**
 * Matches a source track against an array of retrieved candidate tracks,
 * detecting ambiguity and conflicting ISRC assignments deterministically.
 */
export function evaluateCandidates(
  source: {
    title: string;
    artistName: string;
    albumName?: string | null;
    durationMs: number;
    isrc?: string | null;
    explicit?: boolean;
  },
  candidates: CandidateTrack[]
): MatchResult {
  if (candidates.length === 0) {
    return {
      bestMatch: null,
      confidence: 0.0,
      category: "LOW",
      method: MatchMethod.METADATA_FUZZY,
      reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
      isAmbiguous: false,
      isConflict: false,
      conflictReason: "No candidate tracks found on destination provider",
      evidence: null,
      candidates: [],
    };
  }

  // Score all candidates
  const scoredRecords: CandidateScoreRecord[] = candidates.map((cand) => {
    const breakdown = scoreCandidate(source, cand);
    return {
      candidate: cand,
      score: breakdown.finalScore,
      breakdown,
    };
  });

  // Sort by score descending, then by ISRC match, then by duration difference ascending
  scoredRecords.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.breakdown.isrcMatch !== a.breakdown.isrcMatch) {
      return b.breakdown.isrcMatch ? 1 : -1;
    }
    return a.breakdown.durationDiffMs - b.breakdown.durationDiffMs;
  });

  const best = scoredRecords[0];
  const secondBest = scoredRecords.length > 1 ? scoredRecords[1] : null;

  // 1. Ambiguity detection: difference between top 2 candidates < 0.08 with high score
  let isAmbiguous = false;
  let scoreDiff: number | null = null;
  if (secondBest && best.score >= 0.60) {
    scoreDiff = Number((best.score - secondBest.score).toFixed(4));
    if (scoreDiff < 0.08) {
      isAmbiguous = true;
    }
  }

  // 2. Conflicting ISRC & Version conflict detection:
  // - If ISRC matches but title or artist diverges (<0.50) or duration difference > 20s, flag conflict
  // - If recording types mismatch (e.g. LIVE vs ORIGINAL, REMIX vs ORIGINAL), flag conflict
  let isConflict = false;
  let conflictReason: string | null = null;
  if (
    best.breakdown.isrcMatch &&
    (best.breakdown.titleSimilarity < 0.50 ||
      best.breakdown.artistOverlap < 0.50 ||
      best.breakdown.durationDiffMs > 20000)
  ) {
    isConflict = true;
    conflictReason = `Conflicting ISRC: ISRC ${source.isrc} matches but metadata diverges (titleSim: ${best.breakdown.titleSimilarity.toFixed(2)}, artistOverlap: ${best.breakdown.artistOverlap.toFixed(2)}, durationDiff: ${Math.round(best.breakdown.durationDiffMs / 1000)}s)`;
  } else if (best.breakdown.sourceRecordingType !== best.breakdown.candidateRecordingType) {
    isConflict = true;
    conflictReason = `Version conflict: source track is ${best.breakdown.sourceRecordingType} while candidate is ${best.breakdown.candidateRecordingType}`;
  }

  // 3. Match Method determination
  let method: MatchMethod = MatchMethod.METADATA_FUZZY;
  if (best.breakdown.isrcMatch && !isConflict) {
    method = MatchMethod.EXACT_ISRC;
  } else if (best.breakdown.titleSimilarity >= 0.95 && best.breakdown.artistOverlap >= 0.95) {
    method = MatchMethod.METADATA_EXACT;
  } else if (best.score >= 0.75) {
    method = MatchMethod.METADATA_FUZZY;
  }

  // 4. Review Status determination
  let reviewStatus: TrackMatchReviewStatus;
  if (isConflict || isAmbiguous) {
    reviewStatus = TrackMatchReviewStatus.NEEDS_REVIEW;
  } else if (best.score >= 0.85 && best.breakdown.versionScore >= 0) {
    reviewStatus = TrackMatchReviewStatus.AUTO_MATCHED;
  } else {
    reviewStatus = TrackMatchReviewStatus.NEEDS_REVIEW;
  }

  const category = categorizeScore(best.score);
  const sourceMeta = normalizeTrackMetadata(source);
  const candMeta = normalizeTrackMetadata(best.candidate);

  const evidence: MatchEvidence = {
    score: best.score,
    confidenceCategory: category,
    isAmbiguous,
    isConflict,
    conflictReason,
    sourceTrack: {
      title: source.title,
      artistName: source.artistName,
      albumName: source.albumName ?? null,
      durationMs: source.durationMs,
      isrc: source.isrc ?? null,
      explicit: source.explicit,
      recordingType: sourceMeta.recordingType,
    },
    candidateTrack: {
      id: best.candidate.id,
      provider: best.candidate.provider,
      title: best.candidate.title,
      artistName: best.candidate.artistName,
      albumName: best.candidate.albumName ?? null,
      durationMs: best.candidate.durationMs,
      isrc: best.candidate.isrc ?? null,
      explicit: best.candidate.explicit,
      recordingType: candMeta.recordingType,
    },
    scoreDifferenceWithNext: scoreDiff,
    breakdown: best.breakdown,
  };

  return {
    bestMatch: best.candidate,
    confidence: best.score,
    category,
    method,
    reviewStatus,
    isAmbiguous,
    isConflict,
    conflictReason,
    evidence,
    candidates: scoredRecords,
  };
}

/**
 * Searches the Spotify Web API catalog for track candidates.
 */
export async function searchSpotifyCatalog(
  query: string,
  accessToken: string,
  limit = 10
): Promise<CandidateTrack[]> {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(`Spotify search rate-limited (429). Retry-After: ${retryAfter || 5}`);
    }
    const errText = await res.text();
    throw new Error(`Spotify catalog search failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const items = (data.tracks?.items || []) as Array<Record<string, unknown>>;

  return items.map((item): CandidateTrack => {
    const artists = (item["artists"] || []) as Array<Record<string, unknown>>;
    const album = item["album"] as Record<string, unknown> | undefined;
    const externalIds = item["external_ids"] as Record<string, unknown> | undefined;

    return {
      id: String(item["id"]),
      provider: ProviderType.SPOTIFY,
      title: String(item["name"] || ""),
      artistName: artists.map((a) => String(a["name"] || "")).join(", "),
      albumName: album ? String(album["name"] || "") : null,
      durationMs: Number(item["duration_ms"] || 0),
      isrc: externalIds ? String(externalIds["isrc"] || "") : null,
      explicit: Boolean(item["explicit"]),
      uri: (item["uri"] as string) || `spotify:track:${item["id"]}`,
      rawMetadata: item,
    };
  });
}

/**
 * Searches the Apple Music catalog for track (song) candidates.
 */
export async function searchAppleMusicCatalog(
  term: string,
  developerToken: string,
  storefront = "us",
  limit = 10
): Promise<CandidateTrack[]> {
  const url = `https://api.music.apple.com/v1/catalog/${storefront}/search?term=${encodeURIComponent(term)}&types=songs&limit=${limit}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${developerToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(`Apple Music search rate-limited (429). Retry-After: ${retryAfter || 5}`);
    }
    const errText = await res.text();
    throw new Error(`Apple Music catalog search failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const songs = (data.results?.songs?.data || []) as Array<Record<string, unknown>>;

  return songs.map((song): CandidateTrack => {
    const attrs = (song["attributes"] || {}) as Record<string, unknown>;
    return {
      id: String(song["id"]),
      provider: ProviderType.APPLE_MUSIC,
      title: String(attrs["name"] || ""),
      artistName: String(attrs["artistName"] || ""),
      albumName: attrs["albumName"] ? String(attrs["albumName"]) : null,
      durationMs: Number(attrs["durationInMillis"] || 0),
      isrc: attrs["isrc"] ? String(attrs["isrc"]) : null,
      explicit: attrs["contentRating"] === "explicit",
      uri: (song["href"] as string) || null,
      rawMetadata: song,
    };
  });
}

// In-memory catalog search cache to avoid burning quota limits
const catalogSearchMemoryCache = new Map<string, { candidates: CandidateTrack[]; expiresAt: number }>();

export interface SearchYouTubeCatalogOptions {
  accessToken: string;
  userId?: string;
  limit?: number;
  useCache?: boolean;
  cacheTtlSeconds?: number;
}

/**
 * Searches the YouTube Data API v3 catalog for musical tracks, adhering strictly
 * to the quota model and caching candidates to protect the daily 100-call search ceiling.
 */
export async function searchYouTubeCatalog(
  query: string,
  options: SearchYouTubeCatalogOptions
): Promise<CandidateTrack[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const useCache = options.useCache !== false;
  const ttlSeconds = options.cacheTtlSeconds || 86400; // 24-hour default
  const cacheKey = `yt:catalog:search:${crypto.createHash("sha256").update(cleanQuery.toLowerCase()).digest("hex")}`;

  // 1. In-memory cache lookup
  if (useCache) {
    const memoryHit = catalogSearchMemoryCache.get(cacheKey);
    if (memoryHit && Date.now() < memoryHit.expiresAt) {
      return memoryHit.candidates;
    }

    // 2. Redis cache lookup
    try {
      const redis = getRedisClient();
      const redisHit = await redis.get(cacheKey);
      if (redisHit) {
        const candidates = JSON.parse(redisHit) as CandidateTrack[];
        catalogSearchMemoryCache.set(cacheKey, {
          candidates,
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
        return candidates;
      }
    } catch {
      // Non-fatal if Redis is temporarily unreachable
    }
  }

  // 3. Quota accounting: consume 1 Search Queries call (0 general units)
  const quotaManager = getYouTubeQuotaManager();
  await quotaManager.consumeQuota({ generalUnits: 0, searchCalls: 1, operation: "search.list" });

  // 4. YouTube search.list query constrained to musical content
  const limit = Math.min(Math.max(1, options.limit || 10), 25);
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=${limit}&q=${encodeURIComponent(cleanQuery)}`;

  const searchRes = await fetch(searchUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!searchRes.ok) {
    if (searchRes.status === 429) {
      const retryAfter = searchRes.headers.get("Retry-After");
      throw new Error(`YouTube search rate-limited (429). Retry-After: ${retryAfter || 5}`);
    }
    const errText = await searchRes.text();
    throw new Error(`YouTube catalog search failed (${searchRes.status}): ${errText}`);
  }

  const searchData = await searchRes.json();
  const searchItems = (searchData.items || []) as Array<Record<string, unknown>>;
  const videoIds = searchItems
    .map((it) => (it["id"] as Record<string, unknown> | undefined)?.["videoId"] as string)
    .filter(Boolean);

  if (videoIds.length === 0) {
    return [];
  }

  // 5. Batch videos.list to obtain contentDetails (exact ISO 8601 duration and rating)
  // Consumes 1 general unit from General bucket
  await quotaManager.consumeQuota({ generalUnits: 1, searchCalls: 0, operation: "videos.list" });
  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoIds.join(","))}`;

  const videoMap = new Map<string, Record<string, unknown>>();
  try {
    const videosRes = await fetch(videosUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (videosRes.ok) {
      const videosData = await videosRes.json();
      const videoItems = (videosData.items || []) as Array<Record<string, unknown>>;
      for (const v of videoItems) {
        if (v["id"]) videoMap.set(String(v["id"]), v);
      }
    }
  } catch {
    // If videos.list fails, continue with snippet-only data
  }

  // 6. Map to CandidateTrack with normalized metadata
  const candidates: CandidateTrack[] = searchItems.map((searchItem): CandidateTrack => {
    const videoId = (searchItem["id"] as Record<string, unknown>)?.["videoId"] as string;
    const detailed = videoMap.get(videoId);
    const snippet = (detailed?.["snippet"] || searchItem["snippet"] || {}) as Record<string, unknown>;
    const contentDetails = (detailed?.["contentDetails"] || {}) as Record<string, unknown>;

    const rawTitle = String(snippet["title"] || "");
    const channelTitle = String(snippet["channelTitle"] || "");
    const description = String(snippet["description"] || "");
    const durationIso = String(contentDetails["duration"] || "");
    const durationMs = parseYouTubeDuration(durationIso);

    const parsed = parseYouTubeVideoTitle(rawTitle, channelTitle, description);
    const isrc = extractIsrcFromYouTubeDescription(description);

    const contentRating = contentDetails["contentRating"] as Record<string, unknown> | undefined;
    const explicit = parsed.isExplicit || contentRating?.["ytRating"] === "ytAgeRestricted";

    return {
      id: videoId,
      provider: ProviderType.YOUTUBE_MUSIC,
      title: parsed.title,
      artistName: parsed.artist,
      albumName: null,
      durationMs,
      isrc,
      explicit,
      uri: `https://www.youtube.com/watch?v=${videoId}`,
      rawMetadata: detailed || searchItem,
    };
  });

  // 7. Store in caches
  if (useCache) {
    catalogSearchMemoryCache.set(cacheKey, {
      candidates,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    try {
      const redis = getRedisClient();
      await redis.set(cacheKey, JSON.stringify(candidates), "EX", ttlSeconds);
    } catch {
      // Non-fatal cache write failure
    }
  }

  return candidates;
}

/**
 * High-level candidate retrieval with fallback queries.
 */
export async function retrieveAndMatchCandidates(
  sourceTrack: {
    title: string;
    artistName: string;
    albumName?: string | null;
    durationMs: number;
    isrc?: string | null;
    explicit?: boolean;
  },
  destinationProvider: ProviderType,
  credentials: {
    spotifyAccessToken?: string;
    appleDeveloperToken?: string;
    appleStorefront?: string;
    youTubeAccessToken?: string;
    userId?: string;
  }
): Promise<MatchResult> {
  const norm = normalizeTrackMetadata(sourceTrack);
  let candidates: CandidateTrack[] = [];

  if (destinationProvider === ProviderType.SPOTIFY) {
    if (!credentials.spotifyAccessToken) {
      throw new Error("Missing Spotify access token for catalog search");
    }

    // Stage 1: Clean title + primary artist
    const query1 = `${norm.cleanTitle} ${norm.primaryArtist}`;
    candidates = await searchSpotifyCatalog(query1, credentials.spotifyAccessToken, 10);

    // Stage 2: Fallback query using clean title only if 0 results
    if (candidates.length === 0 && norm.cleanTitle) {
      candidates = await searchSpotifyCatalog(norm.cleanTitle, credentials.spotifyAccessToken, 10);
    }

    // Stage 3: ISRC direct lookup if available and 0 results
    if (candidates.length === 0 && sourceTrack.isrc) {
      const isrcQuery = `isrc:${sourceTrack.isrc.trim().toUpperCase()}`;
      candidates = await searchSpotifyCatalog(isrcQuery, credentials.spotifyAccessToken, 5);
    }
  } else if (destinationProvider === ProviderType.APPLE_MUSIC) {
    if (!credentials.appleDeveloperToken) {
      throw new Error("Missing Apple Music developer token for catalog search");
    }
    const storefront = credentials.appleStorefront || "us";

    // Stage 1: Clean title + primary artist
    const query1 = `${norm.cleanTitle} ${norm.primaryArtist}`;
    candidates = await searchAppleMusicCatalog(query1, credentials.appleDeveloperToken, storefront, 10);

    // Stage 2: Fallback query using clean title only if 0 results
    if (candidates.length === 0 && norm.cleanTitle) {
      candidates = await searchAppleMusicCatalog(norm.cleanTitle, credentials.appleDeveloperToken, storefront, 10);
    }
  } else if (destinationProvider === ProviderType.YOUTUBE_MUSIC) {
    if (!credentials.youTubeAccessToken) {
      throw new Error("Missing YouTube access token for catalog search");
    }

    // Stage 1: Clean title + primary artist
    const query1 = `${norm.cleanTitle} ${norm.primaryArtist}`;
    candidates = await searchYouTubeCatalog(query1, {
      accessToken: credentials.youTubeAccessToken,
      userId: credentials.userId,
      limit: 10,
    });

    // Stage 2: Fallback query using clean title only if 0 results
    if (candidates.length === 0 && norm.cleanTitle) {
      candidates = await searchYouTubeCatalog(norm.cleanTitle, {
        accessToken: credentials.youTubeAccessToken,
        userId: credentials.userId,
        limit: 10,
      });
    }
  } else {
    throw new Error(`Unsupported destination provider: ${destinationProvider}`);
  }

  const result = evaluateCandidates(sourceTrack, candidates);

  // YouTube-specific tiered verification:
  // Enforce version compatibility and duration tolerance gating
  if (destinationProvider === ProviderType.YOUTUBE_MUSIC && result.bestMatch) {
    const bestCand = result.bestMatch;
    const candParsed = parseYouTubeVideoTitle(bestCand.title, bestCand.artistName);

    // Tier 1: Exact ISRC match
    if (
      sourceTrack.isrc &&
      bestCand.isrc &&
      sourceTrack.isrc.trim().toUpperCase() === bestCand.isrc.trim().toUpperCase()
    ) {
      // Check for material contradiction
      if (
        result.evidence?.breakdown.titleSimilarity !== undefined &&
        result.evidence.breakdown.titleSimilarity < 0.50
      ) {
        result.isConflict = true;
        result.reviewStatus = TrackMatchReviewStatus.NEEDS_REVIEW;
      }
    } else {
      // Incompatible version gating: NEVER match studio canonical track to Live, Cover, or Remix
      if (
        norm.recordingType === "ORIGINAL" &&
        candParsed.recordingType !== "ORIGINAL" &&
        candParsed.recordingType !== "REMASTER"
      ) {
        result.isConflict = true;
        result.reviewStatus = TrackMatchReviewStatus.NEEDS_REVIEW;
        result.conflictReason = `Incompatible version: canonical track is studio ORIGINAL, while candidate is ${candParsed.recordingType}`;
      }

      // Duration tolerance: if difference exceeds 10,000ms (10s) and neither is extended/live
      const durDiff = Math.abs(sourceTrack.durationMs - bestCand.durationMs);
      if (
        durDiff > 10000 &&
        norm.recordingType === "ORIGINAL" &&
        candParsed.recordingType === "ORIGINAL"
      ) {
        result.reviewStatus = TrackMatchReviewStatus.NEEDS_REVIEW;
        result.conflictReason = `Duration delta (${Math.round(durDiff / 1000)}s) exceeds YouTube tolerance threshold of 10s`;
        if (result.category === "EXACT" || result.category === "HIGH") {
          result.isAmbiguous = true;
        }
      }
    }
  }

  return result;
}
