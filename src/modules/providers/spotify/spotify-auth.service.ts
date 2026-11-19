import crypto from "crypto";
import { prisma } from "@/lib/db";
import { getEnv } from "@/config/env";
import { encryptToken, decryptToken } from "@/lib/encryption";
import { ProviderAccount, ProviderType, ProviderAccountStatus } from "@prisma/client";
import {
  OAuthStateValidationError,
  OAuthTokenExchangeError,
  TokenRefreshError,
  ProviderNotConfiguredError,
  ProviderAuthenticationError,
} from "../errors";
import { NotFoundError, ForbiddenError } from "@/modules/common/errors";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_ME_URL = "https://api.spotify.com/v1/me";

// Minimum required scopes for Phase 3 read-only import (strict least privilege)
export const SPOTIFY_READONLY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
];

// Full operational scopes for Sonora (read-only import + cross-provider migration writes)
export const SPOTIFY_FULL_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-modify",
];

export interface SpotifyConfigStatus {
  isConfigured: boolean;
  missingVariables: string[];
}

/**
 * Checks whether Spotify developer credentials are configured in the environment.
 */
export function getSpotifyConfigStatus(): SpotifyConfigStatus {
  const env = getEnv();
  const missing: string[] = [];

  if (!env.SPOTIFY_CLIENT_ID) missing.push("SPOTIFY_CLIENT_ID");
  if (!env.SPOTIFY_CLIENT_SECRET) missing.push("SPOTIFY_CLIENT_SECRET");

  return {
    isConfigured: missing.length === 0,
    missingVariables: missing,
  };
}

/**
 * Validates and returns Spotify credentials, throwing a typed error if missing.
 */
function getSpotifyCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const env = getEnv();
  const status = getSpotifyConfigStatus();

  if (!status.isConfigured || !env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new ProviderNotConfiguredError("SPOTIFY", status.missingVariables);
  }

  const redirectUri =
    env.SPOTIFY_REDIRECT_URI || `${env.APP_URL}/api/connections/spotify/callback`;

  return {
    clientId: env.SPOTIFY_CLIENT_ID,
    clientSecret: env.SPOTIFY_CLIENT_SECRET,
    redirectUri,
  };
}

/**
 * Generates PKCE code_verifier and code_challenge (S256).
 */
export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  // 64 random bytes base64url encoded -> ~86 chars (within RFC 7636 43-128 chars)
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

/**
 * Initiates the Spotify Authorization Code flow with PKCE.
 * Stores a cryptographically secure, state-bound record in the database with 10-minute expiry.
 */
export async function generateSpotifyAuthorizeUrl(
  userId: string,
  hostOverride?: string,
  scopes: string[] = SPOTIFY_FULL_SCOPES
): Promise<{ url: string; state: string }> {
  const { clientId, redirectUri: configuredRedirectUri } = getSpotifyCredentials();

  // Allow dynamic origin for local development if hostOverride is supplied
  let redirectUri = configuredRedirectUri;
  if (hostOverride && !getEnv().SPOTIFY_REDIRECT_URI) {
    const protocol = hostOverride.startsWith("localhost") || hostOverride.startsWith("127.0.0.1") ? "http" : "https";
    redirectUri = `${protocol}://${hostOverride}/api/connections/spotify/callback`;
  }

  const { codeVerifier, codeChallenge } = generatePKCEPair();
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.oAuthState.create({
    data: {
      provider: ProviderType.SPOTIFY,
      state,
      codeVerifier,
      userId,
      expiresAt,
      used: false,
    },
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });

  return {
    url: `${SPOTIFY_AUTH_URL}?${params.toString()}`,
    state,
  };
}

export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export interface SpotifyUserProfile {
  id: string;
  display_name: string | null;
  email: string | null;
  product?: string;
}

/**
 * Handles the OAuth callback from Spotify, validating state, exchanging PKCE code,
 * retrieving user profile, and storing encrypted tokens in ProviderAccount.
 */
export async function handleSpotifyCallback(
  code: string,
  state: string,
  currentUserId: string,
  hostOverride?: string
): Promise<ProviderAccount> {
  const { clientId, clientSecret, redirectUri: configuredRedirectUri } = getSpotifyCredentials();

  let redirectUri = configuredRedirectUri;
  if (hostOverride && !getEnv().SPOTIFY_REDIRECT_URI) {
    const protocol = hostOverride.startsWith("localhost") || hostOverride.startsWith("127.0.0.1") ? "http" : "https";
    redirectUri = `${protocol}://${hostOverride}/api/connections/spotify/callback`;
  }

  // 1. Atomic state validation and consumption to prevent replay attacks
  const stateRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.oAuthState.findUnique({
      where: { state },
    });

    if (!record) {
      throw new OAuthStateValidationError("SPOTIFY", "State parameter is invalid or unrecognized.");
    }
    if (record.provider !== ProviderType.SPOTIFY) {
      throw new OAuthStateValidationError("SPOTIFY", "OAuth provider mismatch.");
    }
    if (record.userId !== currentUserId) {
      throw new OAuthStateValidationError("SPOTIFY", "OAuth session does not match authenticated user.");
    }
    if (record.used) {
      throw new OAuthStateValidationError("SPOTIFY", "OAuth state has already been consumed (replay attempt).");
    }
    if (record.expiresAt < new Date()) {
      throw new OAuthStateValidationError("SPOTIFY", "OAuth state has expired. Please initiate connection again.");
    }

    // Mark used immediately
    await tx.oAuthState.update({
      where: { id: record.id },
      data: { used: true },
    });

    return record;
  });

  // 2. Exchange authorization code with Spotify server-side
  const bodyParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: stateRecord.codeVerifier,
  });

  const basicAuthHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let tokenData: SpotifyTokenResponse;
  try {
    const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuthHeader}`,
      },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      throw new OAuthTokenExchangeError(
        "SPOTIFY",
        `Spotify token endpoint rejected code (HTTP ${tokenRes.status}): ${errText.slice(0, 200)}`,
        tokenRes.status
      );
    }

    tokenData = (await tokenRes.json()) as SpotifyTokenResponse;
  } catch (err: unknown) {
    if (err instanceof OAuthTokenExchangeError) throw err;
    throw new OAuthTokenExchangeError(
      "SPOTIFY",
      `Network failure connecting to Spotify token endpoint: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!tokenData.access_token) {
    throw new OAuthTokenExchangeError("SPOTIFY", "Spotify response did not contain an access_token.");
  }

  // 3. Retrieve user profile using the new access token
  let userProfile: SpotifyUserProfile;
  try {
    const profileRes = await fetch(SPOTIFY_ME_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!profileRes.ok) {
      throw new ProviderAuthenticationError(
        "SPOTIFY",
        `Failed to fetch user profile from Spotify (HTTP ${profileRes.status})`
      );
    }

    userProfile = (await profileRes.json()) as SpotifyUserProfile;
  } catch (err: unknown) {
    if (err instanceof ProviderAuthenticationError) throw err;
    throw new ProviderAuthenticationError(
      "SPOTIFY",
      `Error retrieving Spotify user profile: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 4. Encrypt tokens using authenticated AES-256-GCM
  const encryptedAccessToken = encryptToken(tokenData.access_token);
  const encryptedRefreshToken = tokenData.refresh_token
    ? encryptToken(tokenData.refresh_token)
    : undefined;

  // Buffer expiry by 60 seconds to ensure proactive refresh
  const tokenExpiresAt = new Date(Date.now() + Math.max(0, tokenData.expires_in - 60) * 1000);
  const scopes = tokenData.scope ? tokenData.scope.split(" ") : SPOTIFY_READONLY_SCOPES;
  const displayName = userProfile.display_name || userProfile.id;

  // 5. Upsert ProviderAccount with composite ownership key
  const account = await prisma.providerAccount.upsert({
    where: {
      userId_provider_providerUserId: {
        userId: currentUserId,
        provider: ProviderType.SPOTIFY,
        providerUserId: userProfile.id,
      },
    },
    create: {
      userId: currentUserId,
      provider: ProviderType.SPOTIFY,
      providerUserId: userProfile.id,
      displayName,
      email: userProfile.email,
      encryptedAccessToken,
      encryptedRefreshToken: encryptedRefreshToken || null,
      tokenExpiresAt,
      scopes,
      status: ProviderAccountStatus.CONNECTED,
      metadata: {
        product: userProfile.product,
      },
    },
    update: {
      displayName,
      email: userProfile.email,
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      tokenExpiresAt,
      scopes,
      status: ProviderAccountStatus.CONNECTED,
      metadata: {
        product: userProfile.product,
      },
    },
  });

  return account;
}

/**
 * Atomically refreshes a Spotify access token if it has expired or is nearing expiration.
 * Enforces ownership check and concurrency serialization.
 */
export async function getValidSpotifyAccessToken(
  providerAccountId: string,
  userId: string
): Promise<string> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      id: providerAccountId,
      userId,
    },
  });

  if (!account) {
    throw new NotFoundError("Provider account", providerAccountId);
  }
  if (account.provider !== ProviderType.SPOTIFY) {
    throw new ForbiddenError("Specified provider account is not a Spotify account.");
  }
  if (account.status === ProviderAccountStatus.DISCONNECTED) {
    throw new ForbiddenError("Spotify account is disconnected. Please re-authenticate.");
  }
  if (account.status === ProviderAccountStatus.REVOKED) {
    throw new TokenRefreshError("SPOTIFY", "Spotify authorization has been revoked or expired. Please reconnect.", true);
  }

  const now = Date.now();
  const expiresAtMs = account.tokenExpiresAt ? account.tokenExpiresAt.getTime() : 0;
  // If token is still valid for at least 3 minutes, reuse it
  if (expiresAtMs - now > 3 * 60 * 1000) {
    return decryptToken(account.encryptedAccessToken);
  }

  // Token is expired or expiring soon -> Refresh
  if (!account.encryptedRefreshToken) {
    await prisma.providerAccount.update({
      where: { id: account.id },
      data: { status: ProviderAccountStatus.EXPIRED },
    });
    throw new TokenRefreshError("SPOTIFY", "No refresh token available; re-authentication required.", true);
  }

  // Acquire distributed lease for refresh to prevent concurrent token refresh race
  const lockToken = crypto.randomUUID();
  const lockTimeoutMs = 15_000;
  const lockStart = Date.now();

  while (Date.now() - lockStart < lockTimeoutMs) {
    const lockExpiresAt = new Date(Date.now() + 30_000); // 30 sec lease
    const acquired = await prisma.providerAccount.updateMany({
      where: {
        id: account.id,
        userId,
        OR: [
          { refreshLockExpiresAt: null },
          { refreshLockExpiresAt: { lt: new Date() } },
        ],
      },
      data: {
        refreshLockToken: lockToken,
        refreshLockExpiresAt: lockExpiresAt,
      },
    });

    if (acquired.count > 0) {
      // We hold the lock. Perform the HTTP refresh outside any long database transaction.
      try {
        const { clientId, clientSecret } = getSpotifyCredentials();
        const currentAccount = await prisma.providerAccount.findUnique({
          where: { id: account.id },
        });
        if (!currentAccount || !currentAccount.encryptedRefreshToken) {
          throw new TokenRefreshError("SPOTIFY", "No refresh token available; re-authentication required.", true);
        }
        const refreshToken = decryptToken(currentAccount.encryptedRefreshToken);

        const bodyParams = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });

        const basicAuthHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

        let refreshResponse: SpotifyTokenResponse;
        try {
          const res = await fetch(SPOTIFY_TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${basicAuthHeader}`,
            },
            body: bodyParams.toString(),
          });

          if (!res.ok) {
            if (res.status === 400 || res.status === 401) {
              await prisma.providerAccount.update({
                where: { id: account.id },
                data: {
                  status: ProviderAccountStatus.REVOKED,
                  refreshLockToken: null,
                  refreshLockExpiresAt: null,
                },
              });
              throw new TokenRefreshError(
                "SPOTIFY",
                "Spotify authorization has been revoked or expired. Please reconnect.",
                true
              );
            }
            throw new TokenRefreshError("SPOTIFY", `Spotify refresh failed with status ${res.status}`);
          }

          refreshResponse = (await res.json()) as SpotifyTokenResponse;
        } catch (err: unknown) {
          if (err instanceof TokenRefreshError) throw err;
          throw new TokenRefreshError(
            "SPOTIFY",
            `Error during token refresh: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const newEncryptedAccessToken = encryptToken(refreshResponse.access_token);
        const newEncryptedRefreshToken = refreshResponse.refresh_token
          ? encryptToken(refreshResponse.refresh_token)
          : undefined;
        const newTokenExpiresAt = new Date(Date.now() + Math.max(0, refreshResponse.expires_in - 60) * 1000);

        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            encryptedAccessToken: newEncryptedAccessToken,
            ...(newEncryptedRefreshToken ? { encryptedRefreshToken: newEncryptedRefreshToken } : {}),
            tokenExpiresAt: newTokenExpiresAt,
            status: ProviderAccountStatus.CONNECTED,
            refreshLockToken: null,
            refreshLockExpiresAt: null,
          },
        });

        return refreshResponse.access_token;
      } finally {
        await prisma.providerAccount
          .updateMany({
            where: {
              id: account.id,
              refreshLockToken: lockToken,
            },
            data: {
              refreshLockToken: null,
              refreshLockExpiresAt: null,
            },
          })
          .catch(() => {
            // Ignore lock release failures on shutdown
          });
      }
    }

    // Another process is refreshing the token. Wait and check if the refreshed token is ready.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const refreshedAccount = await prisma.providerAccount.findUnique({
      where: { id: account.id },
    });

    if (!refreshedAccount) {
      throw new NotFoundError("Provider account", account.id);
    }
    if (refreshedAccount.status === ProviderAccountStatus.REVOKED) {
      throw new TokenRefreshError(
        "SPOTIFY",
        "Spotify authorization has been revoked or expired. Please reconnect.",
        true
      );
    }
    if (
      refreshedAccount.tokenExpiresAt &&
      refreshedAccount.tokenExpiresAt.getTime() - Date.now() > 3 * 60 * 1000
    ) {
      return decryptToken(refreshedAccount.encryptedAccessToken);
    }
  }

  throw new TokenRefreshError("SPOTIFY", "Timed out waiting for concurrent Spotify token refresh.");
}

/**
 * Disconnects a Spotify account safely.
 * Product Invariant: Disconnecting a provider NEVER deletes the user's canonical library or playlists!
 */
export async function disconnectSpotifyAccount(
  providerAccountId: string,
  userId: string
): Promise<void> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      id: providerAccountId,
      userId,
    },
  });

  if (!account) {
    throw new NotFoundError("Provider account", providerAccountId);
  }

  await prisma.providerAccount.update({
    where: { id: account.id },
    data: {
      status: ProviderAccountStatus.DISCONNECTED,
      encryptedAccessToken: "",
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
    },
  });
}
