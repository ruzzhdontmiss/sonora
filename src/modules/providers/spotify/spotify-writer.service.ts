import { prisma } from "@/lib/db";
import { ProviderType } from "@prisma/client";
import { getValidSpotifyAccessToken } from "./spotify-auth.service";
import {
  ProviderAuthenticationError,
  ProviderError,
  ProviderRateLimitError,
} from "../errors";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export interface SpotifyPlaylistCreationResult {
  externalId: string;
  uri: string;
  url: string;
  snapshotId: string;
}

export interface SpotifyBatchWriteResult {
  addedCount: number;
  snapshotId: string;
  failedUris: Array<{ uri: string; reason: string }>;
}

export interface SpotifyLibrarySaveResult {
  savedCount: number;
  failedIds: Array<{ id: string; reason: string }>;
}

/**
 * Checks that the user's Spotify account has granted the required scopes for write actions.
 */
export async function assertSpotifyWriteScopes(
  userId: string,
  requiredType: "playlist" | "library"
): Promise<void> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: ProviderType.SPOTIFY,
      status: "CONNECTED",
    },
  });

  if (!account) {
    throw new ProviderAuthenticationError(
      "SPOTIFY",
      "No connected Spotify account found for user."
    );
  }

  let rawScopeString = "";
  const rawProfileObj = (account as Record<string, unknown>)["rawProfile"] as Record<string, unknown> | undefined;
  const metadataObj = account.metadata as Record<string, unknown> | null;

  if (Array.isArray(account.scopes) && account.scopes.length > 0) {
    rawScopeString = account.scopes.join(" ");
  } else if (typeof rawProfileObj?.["scope"] === "string") {
    rawScopeString = rawProfileObj["scope"];
  } else if (typeof metadataObj?.["scope"] === "string") {
    rawScopeString = metadataObj["scope"] as string;
  }

  const grantedScopes = new Set(rawScopeString.split(/\s+/).filter(Boolean));

  if (requiredType === "playlist") {
    const hasPublic = grantedScopes.has("playlist-modify-public");
    const hasPrivate = grantedScopes.has("playlist-modify-private");
    if (!hasPublic && !hasPrivate && rawScopeString.length > 0) {
      throw new ProviderAuthenticationError(
        "SPOTIFY",
        "Missing required playlist write scope: playlist-modify-public or playlist-modify-private"
      );
    }
  }

  if (requiredType === "library") {
    if (!grantedScopes.has("user-library-modify") && rawScopeString.length > 0) {
      throw new ProviderAuthenticationError(
        "SPOTIFY",
        "Missing required library write scope: user-library-modify"
      );
    }
  }
}

/**
 * Executes a Spotify fetch request with automatic 429 rate limit retry and exponential backoff.
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
        throw new ProviderRateLimitError("SPOTIFY", retryAfterSeconds);
      }

      const backoffMs = Math.min(30000, Math.max(1000, retryAfterSeconds * 1000));
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    return res;
  }

  throw new ProviderError("SPOTIFY", "Exhausted retry attempts without response");
}

/**
 * Retrieves valid Spotify access token for a user by finding their connected account.
 */
export async function getSpotifyAccessTokenForUser(userId: string): Promise<string> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: ProviderType.SPOTIFY,
      status: "CONNECTED",
    },
  });

  if (!account) {
    throw new ProviderAuthenticationError(
      "SPOTIFY",
      "No connected Spotify account found for user."
    );
  }

  return await getValidSpotifyAccessToken(account.id, userId);
}

/**
 * Creates an empty playlist on Spotify for the authenticated user.
 */
export async function createDestinationPlaylist(
  userId: string,
  name: string,
  description?: string,
  isPublic = false,
  explicitAccessToken?: string
): Promise<SpotifyPlaylistCreationResult> {
  await assertSpotifyWriteScopes(userId, "playlist");
  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));

  const res = await fetchWithRetry(`${SPOTIFY_API_BASE}/me/playlists`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: name.trim(),
      description: description?.trim() || "Created by SONORA",
      public: isPublic,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderError("SPOTIFY", `Failed to create playlist (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    externalId: data.id,
    uri: data.uri,
    url: data.external_urls?.spotify || `https://open.spotify.com/playlist/${data.id}`,
    snapshotId: data.snapshot_id,
  };
}

/**
 * Inserts track URIs into a Spotify playlist in batches of up to 100 tracks.
 * Uses official modern POST /v1/playlists/{id}/items (replaces deprecated /tracks).
 * Natively preserves repeated track occurrences when URIs appear multiple times in trackUris.
 */
export async function addTracksToDestinationPlaylist(
  userId: string,
  externalPlaylistId: string,
  trackUris: string[],
  explicitAccessToken?: string
): Promise<SpotifyBatchWriteResult> {
  if (trackUris.length === 0) {
    return { addedCount: 0, snapshotId: "", failedUris: [] };
  }

  await assertSpotifyWriteScopes(userId, "playlist");
  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));

  const BATCH_SIZE = 100;
  let addedCount = 0;
  let lastSnapshotId = "";
  const failedUris: Array<{ uri: string; reason: string }> = [];

  for (let i = 0; i < trackUris.length; i += BATCH_SIZE) {
    const batch = trackUris.slice(i, i + BATCH_SIZE);

    try {
      const res = await fetchWithRetry(
        `${SPOTIFY_API_BASE}/playlists/${externalPlaylistId}/items`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            uris: batch,
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new ProviderError("SPOTIFY", `Failed to insert track batch (${res.status}): ${errText}`);
      }

      const data = await res.json();
      lastSnapshotId = data.snapshot_id;
      addedCount += batch.length;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Batch insert failed";
      for (const uri of batch) {
        failedUris.push({ uri, reason: errMsg });
      }
    }
  }

  return {
    addedCount,
    snapshotId: lastSnapshotId,
    failedUris,
  };
}

/**
 * Normalizes an array of Spotify track IDs or URIs into canonical Spotify URIs.
 */
export function normalizeSpotifyTrackUris(items: string[]): string[] {
  return items.map((item) => {
    const trimmed = item.trim();
    if (trimmed.startsWith("spotify:track:")) {
      return trimmed;
    }
    return `spotify:track:${trimmed}`;
  });
}

/**
 * Checks whether one or more tracks (max 40 per request) are already saved in the user's Spotify library.
 * Uses official GET /v1/me/library/contains?uris={comma_separated_uris} (replaces deprecated /v1/me/tracks/contains).
 */
export async function checkTracksInLibrary(
  userId: string,
  trackIdsOrUris: string[],
  explicitAccessToken?: string
): Promise<boolean[]> {
  if (trackIdsOrUris.length === 0) {
    return [];
  }

  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));
  const normalizedUris = normalizeSpotifyTrackUris(trackIdsOrUris);
  const BATCH_SIZE = 40;
  const results: boolean[] = [];

  for (let i = 0; i < normalizedUris.length; i += BATCH_SIZE) {
    const batch = normalizedUris.slice(i, i + BATCH_SIZE);
    const urisParam = encodeURIComponent(batch.join(","));

    const res = await fetchWithRetry(`${SPOTIFY_API_BASE}/me/library/contains?uris=${urisParam}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthenticationError(
          "SPOTIFY",
          `Authentication/Permission error checking library status (${res.status}): ${errText}`
        );
      }
      throw new ProviderError(
        "SPOTIFY",
        `Failed to check library status (${res.status}): ${errText}`
      );
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new ProviderError("SPOTIFY", "Malformed response from Spotify library contains check");
    }

    results.push(...data.map(Boolean));
  }

  return results;
}

/**
 * Saves tracks to the user's Liked Songs library on Spotify in batches of up to 40 URIs.
 * Uses modern official PUT /v1/me/library?uris={comma_separated_uris} (replaces deprecated PUT /v1/me/tracks).
 *
 * Safety & Reconciliation:
 * - Checks existing membership before writing to skip already-saved tracks.
 * - Respects the 40-URI maximum per request.
 * - Handles 401, 403, and 429 rate limits with Retry-After backoff.
 * - When an uncertain network error occurs during a write, queries /v1/me/library/contains
 *   to determine if the write actually succeeded before declaring failure or retrying.
 */
export async function saveTracksToUserLibrary(
  userId: string,
  trackIdsOrUris: string[],
  explicitAccessToken?: string
): Promise<SpotifyLibrarySaveResult> {
  if (trackIdsOrUris.length === 0) {
    return { savedCount: 0, failedIds: [] };
  }

  await assertSpotifyWriteScopes(userId, "library");
  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));

  // Normalize to unique canonical URIs
  const uniqueUris = Array.from(new Set(normalizeSpotifyTrackUris(trackIdsOrUris)));
  const BATCH_SIZE = 40; // Spotify official maximum: 40 URIs per request
  let savedCount = 0;
  const failedIds: Array<{ id: string; reason: string }> = [];

  for (let i = 0; i < uniqueUris.length; i += BATCH_SIZE) {
    const batch = uniqueUris.slice(i, i + BATCH_SIZE);

    // 1. Check existing membership before writing where supported
    let existingFlags: boolean[] = [];
    try {
      existingFlags = await checkTracksInLibrary(userId, batch, accessToken);
    } catch {
      // If check fails due to network/scope, proceed conservatively to write
      existingFlags = [];
    }

    // Determine missing URIs that actually require writing
    const urisToWrite =
      existingFlags.length === batch.length
        ? batch.filter((_, idx) => !existingFlags[idx])
        : batch;

    const alreadySavedInBatch = batch.length - urisToWrite.length;
    savedCount += alreadySavedInBatch;

    if (urisToWrite.length === 0) {
      // All tracks in this batch are already present in user's library
      continue;
    }

    const urisParam = encodeURIComponent(urisToWrite.join(","));

    try {
      const res = await fetchWithRetry(`${SPOTIFY_API_BASE}/me/library?uris=${urisParam}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401 || res.status === 403) {
          throw new ProviderAuthenticationError(
            "SPOTIFY",
            `Spotify authorization failed (${res.status}): ${errText}`
          );
        }
        throw new ProviderError(
          "SPOTIFY",
          `Failed to save tracks to library (${res.status}): ${errText}`
        );
      }

      savedCount += urisToWrite.length;
    } catch (err: unknown) {
      // Reconciliation: Never interpret an uncertain network outcome as definite failure.
      // Re-check membership to see if the write actually went through on Spotify's side.
      let reconciledFlags: boolean[] = [];
      try {
        reconciledFlags = await checkTracksInLibrary(userId, urisToWrite, accessToken);
      } catch {
        reconciledFlags = [];
      }

      if (reconciledFlags.length === urisToWrite.length && reconciledFlags.every(Boolean)) {
        // All were successfully written despite the network error
        savedCount += urisToWrite.length;
      } else {
        const errMsg = err instanceof Error ? err.message : "Failed to save to Spotify library";
        for (let j = 0; j < urisToWrite.length; j++) {
          const uri = urisToWrite[j]!;
          const wasWritten = reconciledFlags[j] === true;
          if (wasWritten) {
            savedCount++;
          } else {
            failedIds.push({ id: uri, reason: errMsg });
          }
        }
      }
    }
  }

  return { savedCount, failedIds };
}

/**
 * Verifies membership of tracks in user's Spotify library via GET /v1/me/library/contains.
 */
export async function verifyTracksInUserLibrary(
  userId: string,
  trackIdsOrUris: string[],
  explicitAccessToken?: string
): Promise<{ verified: boolean; actualCount: number; missingUris: string[] }> {
  const flags = await checkTracksInLibrary(userId, trackIdsOrUris, explicitAccessToken);
  const normalizedUris = normalizeSpotifyTrackUris(trackIdsOrUris);
  const missingUris = normalizedUris.filter((_, idx) => !flags[idx]);
  const actualCount = flags.filter(Boolean).length;

  return {
    verified: missingUris.length === 0,
    actualCount,
    missingUris,
  };
}

/**
 * Reads all ordered track URIs currently in a Spotify playlist (handling pagination).
 * Uses official modern GET /v1/playlists/{id}/items (replaces deprecated /tracks).
 * Preserves duplicate occurrences and exact playlist order.
 */
export async function getDestinationPlaylistTrackUris(
  userId: string,
  externalPlaylistId: string,
  explicitAccessToken?: string
): Promise<string[]> {
  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));
  const uris: string[] = [];
  let nextUrl: string | null = `${SPOTIFY_API_BASE}/playlists/${externalPlaylistId}/items?limit=100&fields=items(track(uri,id)),next,total`;

  while (nextUrl) {
    const res = await fetchWithRetry(nextUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new ProviderError(
        "SPOTIFY",
        `Failed to read destination playlist items (${res.status}): ${errText}`
      );
    }

    const data: {
      items?: Array<{ track?: { uri?: string; id?: string } | null }>;
      next?: string | null;
    } = await res.json();

    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (item?.track) {
          const uri = item.track.uri || (item.track.id ? `spotify:track:${item.track.id}` : null);
          if (uri) {
            uris.push(uri);
          }
        }
      }
    }

    nextUrl = data.next ?? null;
  }

  return uris;
}

/**
 * Reads back the destination playlist to verify item count and integrity.
 * Uses official modern GET /v1/playlists/{id}/items (replaces deprecated /tracks).
 */
export async function verifyDestinationPlaylist(
  userId: string,
  externalPlaylistId: string,
  expectedCount: number,
  explicitAccessToken?: string
): Promise<{ verified: boolean; actualCount: number }> {
  const accessToken = explicitAccessToken || (await getSpotifyAccessTokenForUser(userId));

  const res = await fetchWithRetry(
    `${SPOTIFY_API_BASE}/playlists/${externalPlaylistId}/items?limit=1`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new ProviderError("SPOTIFY", `Read-back verification failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const actualCount = data.total ?? 0;

  return {
    verified: actualCount >= expectedCount,
    actualCount,
  };
}
