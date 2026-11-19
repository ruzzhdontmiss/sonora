import { prisma } from "@/lib/db";
import { ProviderType } from "@prisma/client";
import { getValidAppleMusicUserToken } from "./apple-auth.service";
import { getAppleDeveloperToken } from "./apple-token.service";
import {
  ProviderAuthenticationError,
  ProviderError,
  ProviderRateLimitError,
} from "../errors";

const APPLE_MUSIC_API_BASE = "https://api.music.apple.com/v1";

export interface AppleMusicPlaylistCreationResult {
  externalId: string;
  href: string;
}

export interface AppleMusicBatchWriteResult {
  addedCount: number;
  failedIds: Array<{ id: string; reason: string }>;
}

export interface AppleMusicLibrarySaveResult {
  savedCount: number;
  acceptedCount: number;
  verifiedCount?: number;
  status: "ACCEPTED" | "VERIFIED" | "FAILED";
  failedIds: Array<{ id: string; reason: string }>;
}

/**
 * Executes an Apple Music API request with 429 rate limit backoff.
 */
async function fetchAppleWithRetry(
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
        throw new ProviderRateLimitError("APPLE_MUSIC", retryAfterSeconds);
      }

      const backoffMs = Math.min(30000, Math.max(1000, retryAfterSeconds * 1000));
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    return res;
  }

  throw new ProviderError("APPLE_MUSIC", "Exhausted retry attempts without response");
}

/**
 * Retrieves valid Apple Music User Token for a user by finding their connected account.
 */
export async function getAppleMusicUserTokenForUser(userId: string): Promise<string> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: ProviderType.APPLE_MUSIC,
      status: "CONNECTED",
    },
  });

  if (!account) {
    throw new ProviderAuthenticationError(
      "APPLE_MUSIC",
      "No connected Apple Music account found for user."
    );
  }

  return await getValidAppleMusicUserToken(account.id, userId);
}

/**
 * Creates an empty playlist in the user's Apple Music Cloud Library.
 */
export async function createLibraryPlaylist(
  userId: string,
  name: string,
  description?: string,
  explicitTokens?: { developerToken?: string; musicUserToken?: string }
): Promise<AppleMusicPlaylistCreationResult> {
  const developerToken = explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const res = await fetchAppleWithRetry(`${APPLE_MUSIC_API_BASE}/me/library/playlists`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${developerToken}`,
      "Music-User-Token": musicUserToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      attributes: {
        name: name.trim(),
        description: description?.trim() || "Created by SONORA",
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderError("APPLE_MUSIC", `Failed to create library playlist (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const playlistItem = json.data?.[0];
  if (!playlistItem?.id) {
    throw new ProviderError("APPLE_MUSIC", "Apple Music response did not contain created playlist ID");
  }

  return {
    externalId: playlistItem.id,
    href: playlistItem.href || `/v1/me/library/playlists/${playlistItem.id}`,
  };
}

/**
 * Inserts tracks into a user's Apple Music Cloud Library playlist in batches of up to 100.
 */
export async function addTracksToLibraryPlaylist(
  userId: string,
  externalPlaylistId: string,
  trackIds: string[],
  explicitTokens?: { developerToken?: string; musicUserToken?: string }
): Promise<AppleMusicBatchWriteResult> {
  if (trackIds.length === 0) {
    return { addedCount: 0, failedIds: [] };
  }

  const developerToken = explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const BATCH_SIZE = 100;
  let addedCount = 0;
  const failedIds: Array<{ id: string; reason: string }> = [];

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetchAppleWithRetry(
        `${APPLE_MUSIC_API_BASE}/me/library/playlists/${externalPlaylistId}/tracks`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${developerToken}`,
            "Music-User-Token": musicUserToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            data: batch.map((id) => ({
              id,
              type: "songs",
            })),
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new ProviderError(
          "APPLE_MUSIC",
          `Failed to append tracks to playlist (${res.status}): ${errText}`
        );
      }

      addedCount += batch.length;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Failed to add song to Apple Music playlist";
      for (const id of batch) {
        failedIds.push({ id, reason: errMsg });
      }
    }
  }

  return { addedCount, failedIds };
}

/**
 * Adds tracks directly to the user's personal Apple Music Cloud Library in batches of up to 25.
 *
 * Response Semantics:
 * - Apple Music returns HTTP 202 Accepted.
 * - This indicates the addition was accepted for ingestion into the user's Cloud Library,
 *   which is subject to asynchronous propagation delay before appearing in library queries.
 */
export async function saveTracksToAppleLibrary(
  userId: string,
  trackIds: string[],
  explicitTokens?: { developerToken?: string; musicUserToken?: string }
): Promise<AppleMusicLibrarySaveResult> {
  if (trackIds.length === 0) {
    return { savedCount: 0, acceptedCount: 0, status: "VERIFIED", failedIds: [] };
  }

  const developerToken = explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const BATCH_SIZE = 25;
  let savedCount = 0;
  let acceptedCount = 0;
  const failedIds: Array<{ id: string; reason: string }> = [];

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);
    const idsParam = batch.join(",");

    try {
      const res = await fetchAppleWithRetry(
        `${APPLE_MUSIC_API_BASE}/me/library?ids[songs]=${idsParam}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${developerToken}`,
            "Music-User-Token": musicUserToken,
          },
        }
      );

      if (!res.ok && res.status !== 202) {
        const errText = await res.text();
        throw new ProviderError(
          "APPLE_MUSIC",
          `Failed to add songs to library (${res.status}): ${errText}`
        );
      }

      // Record accepted state per Apple Music 202 Accepted specification
      acceptedCount += batch.length;
      savedCount += batch.length;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Failed to save to Apple Music library";
      for (const id of batch) {
        failedIds.push({ id, reason: errMsg });
      }
    }
  }

  const status: "ACCEPTED" | "VERIFIED" | "FAILED" =
    failedIds.length === trackIds.length ? "FAILED" : "ACCEPTED";

  return { savedCount, acceptedCount, status, failedIds };
}

/**
 * Reads back the user's Apple Music library to verify track presence with bounded polling
 * to account for Cloud Library asynchronous ingestion / propagation delay.
 */
export async function verifyAppleLibrarySongs(
  userId: string,
  catalogSongIds: string[],
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    explicitTokens?: { developerToken?: string; musicUserToken?: string };
  } = {}
): Promise<{
  verified: boolean;
  verifiedCount: number;
  pendingCount: number;
  status: "VERIFIED" | "ACCEPTED_PENDING";
}> {
  if (catalogSongIds.length === 0) {
    return { verified: true, verifiedCount: 0, pendingCount: 0, status: "VERIFIED" };
  }

  const developerToken = options.explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    options.explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const maxAttempts = options.maxAttempts ?? 3;
  let delayMs = options.initialDelayMs ?? 500;
  let verifiedCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchAppleWithRetry(
        `${APPLE_MUSIC_API_BASE}/me/library/songs?limit=100`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${developerToken}`,
            "Music-User-Token": musicUserToken,
          },
        }
      );

      if (res.ok) {
        const json = await res.json();
        const librarySongs: Array<{ id: string; attributes?: { playParams?: { catalogId?: string } } }> =
          json.data || [];

        const foundCatalogIds = new Set(
          librarySongs
            .map((s) => s.attributes?.playParams?.catalogId)
            .filter((id): id is string => Boolean(id))
        );

        verifiedCount = catalogSongIds.filter((id) => foundCatalogIds.has(id)).length;
        if (verifiedCount >= catalogSongIds.length) {
          return {
            verified: true,
            verifiedCount,
            pendingCount: 0,
            status: "VERIFIED",
          };
        }
      }
    } catch {
      // Non-fatal read-back check failure; will retry if attempts remain
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  // Bounded polling complete: propagation delay is normal for 202 Accepted.
  // Never repeat writes on timeout.
  const pendingCount = Math.max(0, catalogSongIds.length - verifiedCount);
  return {
    verified: false,
    verifiedCount,
    pendingCount,
    status: "ACCEPTED_PENDING",
  };
}

/**
 * Reads all ordered track IDs currently in an Apple Music library playlist (handling pagination).
 * Preserves duplicate occurrences and exact playlist order.
 */
export async function getLibraryPlaylistTrackIds(
  userId: string,
  externalPlaylistId: string,
  optionsOrTokens?: {
    explicitTokens?: { developerToken?: string; musicUserToken?: string };
    developerToken?: string;
    musicUserToken?: string;
  }
): Promise<string[]> {
  const explicitTokens =
    optionsOrTokens?.explicitTokens ||
    (optionsOrTokens?.developerToken || optionsOrTokens?.musicUserToken
      ? { developerToken: optionsOrTokens.developerToken, musicUserToken: optionsOrTokens.musicUserToken }
      : undefined);

  const developerToken = explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const trackIds: string[] = [];
  let nextUrl: string | null = `${APPLE_MUSIC_API_BASE}/me/library/playlists/${externalPlaylistId}/tracks?limit=100`;

  while (nextUrl) {
    const fullUrl = nextUrl.startsWith("http") ? nextUrl : `${APPLE_MUSIC_API_BASE}${nextUrl}`;
    const res = await fetchAppleWithRetry(fullUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Music-User-Token": musicUserToken,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new ProviderError(
        "APPLE_MUSIC",
        `Failed to read library playlist items (${res.status}): ${errText}`
      );
    }

    const data: {
      data?: Array<{
        id: string;
        type?: string;
        attributes?: {
          playParams?: { catalogId?: string; id?: string };
        };
      }>;
      next?: string | null;
    } = await res.json();

    if (Array.isArray(data.data)) {
      for (const item of data.data) {
        // Extract catalog ID from playParams if available, otherwise fall back to item.id
        const catalogId = item.attributes?.playParams?.catalogId || item.id;
        if (catalogId) {
          trackIds.push(catalogId);
        }
      }
    }

    nextUrl = data.next ?? null;
  }

  return trackIds;
}

/**
 * Reads back the library playlist to verify actual track count with bounded polling.
 */
export async function verifyLibraryPlaylist(
  userId: string,
  externalPlaylistId: string,
  expectedCount: number,
  optionsOrTokens?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    explicitTokens?: { developerToken?: string; musicUserToken?: string };
    developerToken?: string;
    musicUserToken?: string;
  }
): Promise<{ verified: boolean; actualCount: number; status: "VERIFIED" | "ACCEPTED_PENDING" }> {
  const explicitTokens =
    optionsOrTokens?.explicitTokens ||
    (optionsOrTokens?.developerToken || optionsOrTokens?.musicUserToken
      ? { developerToken: optionsOrTokens.developerToken, musicUserToken: optionsOrTokens.musicUserToken }
      : undefined);

  const developerToken = explicitTokens?.developerToken || (await getAppleDeveloperToken());
  const musicUserToken =
    explicitTokens?.musicUserToken || (await getAppleMusicUserTokenForUser(userId));

  const maxAttempts = optionsOrTokens?.maxAttempts ?? 2;
  let delayMs = optionsOrTokens?.initialDelayMs ?? 300;
  let actualCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchAppleWithRetry(
      `${APPLE_MUSIC_API_BASE}/me/library/playlists/${externalPlaylistId}/tracks`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${developerToken}`,
          "Music-User-Token": musicUserToken,
        },
      }
    );

    if (res.ok) {
      const json = await res.json();
      actualCount = json.data?.length ?? 0;
      if (actualCount >= expectedCount) {
        return {
          verified: true,
          actualCount,
          status: "VERIFIED",
        };
      }
    } else {
      const errText = await res.text();
      throw new ProviderError(
        "APPLE_MUSIC",
        `Library playlist verification failed (${res.status}): ${errText}`
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }

  return {
    verified: actualCount >= expectedCount,
    actualCount,
    status: actualCount >= expectedCount ? "VERIFIED" : "ACCEPTED_PENDING",
  };
}
