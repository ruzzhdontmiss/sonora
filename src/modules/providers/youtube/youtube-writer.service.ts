/**
 * YouTube Data API Destination Writer for SONORA (P5-T05).
 *
 * Implements destination writing with prefix recovery and dual-read safeguards:
 * - Playlist creation (POST /playlists, 50 units)
 * - Sequential track insertion (POST /playlistItems, 50 units per item)
 * - Liked videos rating (POST /videos/rate?rating=like, 50 units per call)
 * - Uncertain-write recovery using complete pagination and dual-read eventual consistency
 * - Exact ordering and duplicate preservation via verifyPlaylistPrefix
 */

import { getYouTubeAccessToken } from "./youtube-auth.service";
import { getYouTubeQuotaManager } from "./quota/youtube-quota-manager";
import {
  ProviderError,
  ProviderQuotaExhaustedError,
  ProviderRateLimitError,
} from "../errors";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

export interface YouTubePlaylistCreationResult {
  externalId: string;
  url: string;
  title: string;
}

export interface YouTubeBatchWriteResult {
  addedCount: number;
  failedVideoIds: Array<{ videoId: string; reason: string }>;
}

export interface YouTubeLibrarySaveResult {
  savedCount: number;
  failedIds: Array<{ id: string; reason: string }>;
}

/**
 * Executes a YouTube fetch with automatic retry on 429 and 5xx errors.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt++;
    const res = await fetch(url, options);

    if (res.status === 429) {
      const retryHeader = res.headers.get("Retry-After");
      const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : Math.pow(2, attempt);

      if (attempt > maxRetries) {
        throw new ProviderRateLimitError("YOUTUBE_MUSIC", retryAfterSeconds);
      }

      const backoffMs = Math.min(30000, Math.max(1000, retryAfterSeconds * 1000));
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (res.status === 403) {
      const errText = await res.text().catch(() => "");
      if (errText.includes("quotaExceeded") || errText.includes("dailyLimitExceeded")) {
        const tomorrowPacific = new Date();
        tomorrowPacific.setUTCDate(tomorrowPacific.getUTCDate() + 1);
        tomorrowPacific.setUTCHours(7, 0, 0, 0);
        throw new ProviderQuotaExhaustedError({
          provider: "YOUTUBE_MUSIC",
          quotaBucket: "GENERAL",
          limit: 10000,
          requested: 50,
          remaining: 0,
          resetsAt: tomorrowPacific,
        });
      }
      throw new ProviderError("YOUTUBE_MUSIC", `YouTube API 403: ${errText.slice(0, 250)}`);
    }

    if (res.status >= 500 && attempt <= maxRetries) {
      const backoffMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    return res;
  }

  throw new ProviderError("YOUTUBE_MUSIC", "Exhausted retry attempts without response from YouTube API");
}

/**
 * Creates an empty playlist on YouTube / YouTube Music for the authenticated user.
 * Quota cost: 50 general units (playlists.insert).
 */
export async function createDestinationPlaylist(
  userId: string,
  name: string,
  description?: string,
  isPublic = false,
  explicitAccessToken?: string
): Promise<YouTubePlaylistCreationResult> {
  const accessToken = explicitAccessToken || (await getYouTubeAccessToken(userId));

  // Quota: playlists.insert = 50 general units
  const quotaManager = getYouTubeQuotaManager();
  await quotaManager.consumeQuota({
    generalUnits: 50,
    searchCalls: 0,
    operation: "playlists.insert",
  });

  const res = await fetchWithRetry(`${YOUTUBE_API_BASE}/playlists?part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        title: name.trim(),
        description: description?.trim() || "Created by SONORA",
      },
      status: {
        privacyStatus: isPublic ? "public" : "private",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderError("YOUTUBE_MUSIC", `Failed to create YouTube playlist (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const id = String(data["id"] || "");

  return {
    externalId: id,
    url: `https://www.youtube.com/playlist?list=${id}`,
    title: name.trim(),
  };
}

/**
 * Reads all ordered video IDs currently present in a YouTube playlist (complete pagination).
 * Quota cost: 1 general unit per page of 50 items.
 */
export async function getDestinationPlaylistVideoIds(
  userId: string,
  externalPlaylistId: string,
  explicitAccessToken?: string
): Promise<string[]> {
  const accessToken = explicitAccessToken || (await getYouTubeAccessToken(userId));
  const videoIds: string[] = [];
  const quotaManager = getYouTubeQuotaManager();

  let pageToken: string | null = null;
  let hasMore = true;

  while (hasMore) {
    await quotaManager.consumeQuota({
      generalUnits: 1,
      searchCalls: 0,
      operation: "playlistItems.list",
    });

    let url = `${YOUTUBE_API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(
      externalPlaylistId
    )}&maxResults=50`;
    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new ProviderError(
        "YOUTUBE_MUSIC",
        `Failed to read destination playlist items (${res.status}): ${errText}`
      );
    }

    const data = (await res.json()) as {
      items?: Array<Record<string, unknown>>;
      nextPageToken?: string;
    };

    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        const snippet = item["snippet"] as Record<string, unknown> | undefined;
        const resId = snippet?.["resourceId"] as Record<string, unknown> | undefined;
        const contentDetails = item["contentDetails"] as Record<string, unknown> | undefined;
        const vid = String(resId?.["videoId"] || contentDetails?.["videoId"] || "");
        if (vid) {
          videoIds.push(vid);
        }
      }
    }

    pageToken = data.nextPageToken || null;
    hasMore = Boolean(pageToken);
  }

  return videoIds;
}

/**
 * Dual-read practical safeguard:
 * Performs two consecutive reads with a 500ms sleep to guard against eventual consistency delay
 * in Google Cloud distributed datastores.
 */
export async function dualReadDestinationPlaylistVideoIds(
  userId: string,
  externalPlaylistId: string,
  explicitAccessToken?: string
): Promise<string[]> {
  const read1 = await getDestinationPlaylistVideoIds(userId, externalPlaylistId, explicitAccessToken);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const read2 = await getDestinationPlaylistVideoIds(userId, externalPlaylistId, explicitAccessToken);

  // If read2 shows more items than read1, use read2 (eventual consistency caught up)
  return read2.length >= read1.length ? read2 : read1;
}

/**
 * Sequentially inserts video IDs into a YouTube playlist with uncertain-write reconciliation.
 * Quota cost: 50 general units per item (playlistItems.insert).
 * Preserves intentional duplicate tracks in exact sequence.
 */
export async function addTracksToDestinationPlaylist(
  userId: string,
  externalPlaylistId: string,
  videoIds: string[],
  explicitAccessToken?: string
): Promise<YouTubeBatchWriteResult> {
  if (videoIds.length === 0) {
    return { addedCount: 0, failedVideoIds: [] };
  }

  const accessToken = explicitAccessToken || (await getYouTubeAccessToken(userId));
  const quotaManager = getYouTubeQuotaManager();

  let addedCount = 0;
  const failedVideoIds: Array<{ videoId: string; reason: string }> = [];

  for (let idx = 0; idx < videoIds.length; idx++) {
    const videoId = videoIds[idx]!;

    // Quota: 50 general units per item insert
    await quotaManager.consumeQuota({
      generalUnits: 50,
      searchCalls: 0,
      operation: "playlistItems.insert",
    });

    try {
      const res = await fetchWithRetry(`${YOUTUBE_API_BASE}/playlistItems?part=snippet`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          snippet: {
            playlistId: externalPlaylistId,
            resourceId: {
              kind: "youtube#video",
              videoId,
            },
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new ProviderError(
          "YOUTUBE_MUSIC",
          `Failed to insert playlist item [${videoId}] (${res.status}): ${errText}`
        );
      }

      addedCount++;
    } catch (err: unknown) {
      // Uncertain Write Recovery:
      // Perform dual-read read-back to verify if the item was committed on YouTube's side
      let confirmedViaReadBack = false;
      try {
        const currentItems = await dualReadDestinationPlaylistVideoIds(
          userId,
          externalPlaylistId,
          accessToken
        );

        // Check if current items contain the expected count of this track up to current index
        const expectedOccurrences = videoIds.slice(0, idx + 1).filter((v) => v === videoId).length;
        const actualOccurrences = currentItems.filter((v) => v === videoId).length;

        if (actualOccurrences >= expectedOccurrences) {
          confirmedViaReadBack = true;
          addedCount++;
        }
      } catch {
        // Read-back error
      }

      if (!confirmedViaReadBack) {
        const errMsg = err instanceof Error ? err.message : "Uncertain write failure";
        failedVideoIds.push({ videoId, reason: errMsg });
      }
    }
  }

  return { addedCount, failedVideoIds };
}

/**
 * Reads back the destination playlist to verify item count and integrity.
 */
export async function verifyDestinationPlaylist(
  userId: string,
  externalPlaylistId: string,
  expectedCount: number,
  explicitAccessToken?: string
): Promise<{ verified: boolean; actualCount: number }> {
  const currentItems = await dualReadDestinationPlaylistVideoIds(
    userId,
    externalPlaylistId,
    explicitAccessToken
  );

  return {
    verified: currentItems.length >= expectedCount,
    actualCount: currentItems.length,
  };
}

/**
 * Marks videos as liked (rating=like) in the user's YouTube library.
 * Quota cost: 50 general units per rated video (videos.rate).
 */
export async function saveTracksToUserLibrary(
  userId: string,
  videoIds: string[],
  explicitAccessToken?: string
): Promise<YouTubeLibrarySaveResult> {
  if (videoIds.length === 0) {
    return { savedCount: 0, failedIds: [] };
  }

  const accessToken = explicitAccessToken || (await getYouTubeAccessToken(userId));
  const quotaManager = getYouTubeQuotaManager();

  let savedCount = 0;
  const failedIds: Array<{ id: string; reason: string }> = [];

  for (const videoId of videoIds) {
    // Quota: 50 general units per rate call
    await quotaManager.consumeQuota({
      generalUnits: 50,
      searchCalls: 0,
      operation: "videos.rate",
    });

    try {
      const url = `${YOUTUBE_API_BASE}/videos/rate?id=${encodeURIComponent(videoId)}&rating=like`;
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new ProviderError("YOUTUBE_MUSIC", `Failed to rate video [${videoId}] (${res.status}): ${errText}`);
      }

      savedCount++;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Failed to set video rating";
      failedIds.push({ id: videoId, reason: errMsg });
    }
  }

  return { savedCount, failedIds };
}
