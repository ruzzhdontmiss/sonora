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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export const GOOGLE_BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export const YOUTUBE_READONLY_SCOPES = [
  ...GOOGLE_BASE_SCOPES,
  "https://www.googleapis.com/auth/youtube.readonly",
];

export const YOUTUBE_FULL_SCOPES = [
  ...GOOGLE_BASE_SCOPES,
  "https://www.googleapis.com/auth/youtube",
];

export const GOOGLE_DATA_PORTABILITY_SCOPE =
  "https://www.googleapis.com/auth/dataportability.youtube.music";

export interface GoogleConfigStatus {
  isConfigured: boolean;
  missingVariables: string[];
}

export function getGoogleConfigStatus(): GoogleConfigStatus {
  let env;
  try {
    env = getEnv();
  } catch {
    return {
      isConfigured: false,
      missingVariables: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    };
  }

  const missing: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");

  return {
    isConfigured: missing.length === 0,
    missingVariables: missing,
  };
}

export function getGoogleCredentials(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const env = getEnv();
  const status = getGoogleConfigStatus();

  if (!status.isConfigured || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ProviderNotConfiguredError("YOUTUBE_MUSIC", status.missingVariables);
  }

  const redirectUri =
    env.GOOGLE_REDIRECT_URI || `${env.APP_URL}/api/connections/google/callback`;

  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  };
}

export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

export interface GoogleAuthorizeUrlOptions {
  hostOverride?: string;
  scopes?: string[];
  includeWriteScopes?: boolean;
  includeDataPortability?: boolean;
}

/**
 * Initiates the Google OAuth 2.0 flow with PKCE and state validation.
 */
export async function generateGoogleAuthorizeUrl(
  userId: string,
  options: GoogleAuthorizeUrlOptions = {}
): Promise<{ url: string; state: string }> {
  const { clientId, redirectUri: configuredRedirectUri } = getGoogleCredentials();

  let redirectUri = configuredRedirectUri;
  if (options.hostOverride && !getEnv().GOOGLE_REDIRECT_URI) {
    const protocol =
      options.hostOverride.startsWith("localhost") ||
      options.hostOverride.startsWith("127.0.0.1")
        ? "http"
        : "https";
    redirectUri = `${protocol}://${options.hostOverride}/api/connections/google/callback`;
  }

  const { codeVerifier, codeChallenge } = generatePKCEPair();
  const state = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await prisma.oAuthState.create({
    data: {
      provider: ProviderType.YOUTUBE_MUSIC,
      state,
      codeVerifier,
      userId,
      expiresAt,
      used: false,
    },
  });

  const selectedScopes = options.scopes
    ? options.scopes
    : options.includeWriteScopes
    ? YOUTUBE_FULL_SCOPES
    : YOUTUBE_READONLY_SCOPES;

  const scopesToRequest = [...selectedScopes];
  if (options.includeDataPortability) {
    scopesToRequest.push(GOOGLE_DATA_PORTABILITY_SCOPE);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: scopesToRequest.join(" "),
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    access_type: "offline",
    prompt: "consent", // Force consent prompt to guarantee refresh token is returned
  });

  return {
    url: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    state,
  };
}

export interface GoogleTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

export interface GoogleUserProfile {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

/**
 * Handles the OAuth callback from Google: validates state, exchanges code for tokens,
 * retrieves user profile, encrypts tokens, and stores them in ProviderAccount.
 */
export async function handleGoogleCallback(
  code: string,
  state: string,
  currentUserId: string,
  hostOverride?: string
): Promise<ProviderAccount> {
  const { clientId, clientSecret, redirectUri: configuredRedirectUri } = getGoogleCredentials();

  let redirectUri = configuredRedirectUri;
  if (hostOverride && !getEnv().GOOGLE_REDIRECT_URI) {
    const protocol =
      hostOverride.startsWith("localhost") || hostOverride.startsWith("127.0.0.1")
        ? "http"
        : "https";
    redirectUri = `${protocol}://${hostOverride}/api/connections/google/callback`;
  }

  // 1. Atomic state validation and consumption
  const stateRecord = await prisma.$transaction(async (tx) => {
    const record = await tx.oAuthState.findUnique({
      where: { state },
    });

    if (!record) {
      throw new OAuthStateValidationError("YOUTUBE_MUSIC", "State parameter is invalid or unrecognized.");
    }
    if (record.provider !== ProviderType.YOUTUBE_MUSIC) {
      throw new OAuthStateValidationError("YOUTUBE_MUSIC", "OAuth provider mismatch.");
    }
    if (record.userId !== currentUserId) {
      throw new OAuthStateValidationError("YOUTUBE_MUSIC", "OAuth session does not match authenticated user.");
    }
    if (record.used) {
      throw new OAuthStateValidationError("YOUTUBE_MUSIC", "OAuth state has already been consumed (replay attempt).");
    }
    if (record.expiresAt < new Date()) {
      throw new OAuthStateValidationError("YOUTUBE_MUSIC", "OAuth state has expired. Please initiate connection again.");
    }

    await tx.oAuthState.update({
      where: { id: record.id },
      data: { used: true },
    });

    return record;
  });

  // 2. Exchange authorization code with Google server-side
  const bodyParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: stateRecord.codeVerifier,
  });

  let tokenData: GoogleTokenResponse;
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyParams.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      throw new OAuthTokenExchangeError(
        "YOUTUBE_MUSIC",
        `Google token endpoint rejected code (HTTP ${tokenRes.status}): ${errText.slice(0, 200)}`,
        tokenRes.status
      );
    }

    tokenData = (await tokenRes.json()) as GoogleTokenResponse;
  } catch (err: unknown) {
    if (err instanceof OAuthTokenExchangeError) throw err;
    throw new OAuthTokenExchangeError(
      "YOUTUBE_MUSIC",
      `Network failure connecting to Google token endpoint: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!tokenData.access_token) {
    throw new OAuthTokenExchangeError("YOUTUBE_MUSIC", "Google response did not contain an access_token.");
  }

  // 3. Retrieve user profile
  let userProfile: GoogleUserProfile;
  try {
    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!profileRes.ok) {
      throw new ProviderAuthenticationError(
        "YOUTUBE_MUSIC",
        `Failed to fetch user profile from Google (HTTP ${profileRes.status})`
      );
    }

    userProfile = (await profileRes.json()) as GoogleUserProfile;
  } catch (err: unknown) {
    if (err instanceof ProviderAuthenticationError) throw err;
    throw new ProviderAuthenticationError(
      "YOUTUBE_MUSIC",
      `Error retrieving Google user profile: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 4. Encrypt tokens using authenticated AES-256-GCM
  const encryptedAccessToken = encryptToken(tokenData.access_token);
  const encryptedRefreshToken = tokenData.refresh_token
    ? encryptToken(tokenData.refresh_token)
    : undefined;

  const tokenExpiresAt = new Date(Date.now() + Math.max(0, tokenData.expires_in - 60) * 1000);
  const scopes = tokenData.scope ? tokenData.scope.split(" ") : YOUTUBE_READONLY_SCOPES;
  const displayName = userProfile.name || userProfile.email || userProfile.sub;

  // 5. Upsert ProviderAccount with composite ownership key
  const account = await prisma.providerAccount.upsert({
    where: {
      userId_provider_providerUserId: {
        userId: currentUserId,
        provider: ProviderType.YOUTUBE_MUSIC,
        providerUserId: userProfile.sub,
      },
    },
    create: {
      userId: currentUserId,
      provider: ProviderType.YOUTUBE_MUSIC,
      providerUserId: userProfile.sub,
      displayName,
      email: userProfile.email || null,
      encryptedAccessToken,
      encryptedRefreshToken: encryptedRefreshToken || null,
      tokenExpiresAt,
      scopes,
      status: ProviderAccountStatus.CONNECTED,
      metadata: {
        picture: userProfile.picture,
      },
    },
    update: {
      displayName,
      email: userProfile.email || null,
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      tokenExpiresAt,
      scopes,
      status: ProviderAccountStatus.CONNECTED,
      metadata: {
        picture: userProfile.picture,
      },
    },
  });

  return account;
}

/**
 * Fetches the Google user profile using an access token.
 */
export async function getUserProfile(accessToken: string): Promise<GoogleUserProfile> {
  const profileRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profileRes.ok) {
    throw new ProviderAuthenticationError("YOUTUBE_MUSIC", "Failed to fetch Google user profile.");
  }
  return (await profileRes.json()) as GoogleUserProfile;
}

/**
 * Retrieves a valid, refreshed access token for a given user's connected YouTube account.
 */
export async function getYouTubeAccessToken(userId: string): Promise<string> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: ProviderType.YOUTUBE_MUSIC,
      status: ProviderAccountStatus.CONNECTED,
    },
  });
  if (!account) {
    throw new NotFoundError("Connected YouTube account for user", userId);
  }
  return getValidYouTubeAccessToken(account.id, userId);
}

/**
 * Atomically refreshes a Google / YouTube access token if expired or nearing expiration.
 * Enforces ownership check and concurrency serialization with distributed lock.
 */
export async function getValidYouTubeAccessToken(
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
  if (account.provider !== ProviderType.YOUTUBE_MUSIC) {
    throw new ForbiddenError("Specified provider account is not a YouTube Music account.");
  }
  if (account.status === ProviderAccountStatus.DISCONNECTED) {
    throw new ForbiddenError("YouTube account is disconnected. Please re-authenticate.");
  }
  if (account.status === ProviderAccountStatus.REVOKED) {
    throw new TokenRefreshError(
      "YOUTUBE_MUSIC",
      "YouTube authorization has been revoked or expired (e.g. 7-day Testing Mode expiration). Please reconnect.",
      true
    );
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
    throw new TokenRefreshError("YOUTUBE_MUSIC", "No refresh token available; re-authentication required.", true);
  }

  // Acquire distributed lease for refresh to prevent concurrent token refresh race
  const lockToken = crypto.randomUUID();
  const lockTimeoutMs = 15_000;
  const lockStart = Date.now();

  while (Date.now() - lockStart < lockTimeoutMs) {
    const lockExpiresAt = new Date(Date.now() + 30_000);
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
      try {
        const { clientId, clientSecret } = getGoogleCredentials();
        const currentAccount = await prisma.providerAccount.findUnique({
          where: { id: account.id },
        });
        if (!currentAccount || !currentAccount.encryptedRefreshToken) {
          throw new TokenRefreshError("YOUTUBE_MUSIC", "No refresh token available; re-authentication required.", true);
        }
        const refreshToken = decryptToken(currentAccount.encryptedRefreshToken);

        const bodyParams = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });

        let refreshResponse: GoogleTokenResponse;
        try {
          const res = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
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
                "YOUTUBE_MUSIC",
                "Google authorization has been revoked or expired (e.g. 7-day Testing Mode expiration). Please reconnect.",
                true
              );
            }
            throw new TokenRefreshError("YOUTUBE_MUSIC", `Google refresh failed with status ${res.status}`);
          }

          refreshResponse = (await res.json()) as GoogleTokenResponse;
        } catch (err: unknown) {
          if (err instanceof TokenRefreshError) throw err;
          throw new TokenRefreshError(
            "YOUTUBE_MUSIC",
            `Error during token refresh: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const newAccessToken = refreshResponse.access_token;
        const encryptedAccessToken = encryptToken(newAccessToken);
        const tokenExpiresAt = new Date(
          Date.now() + Math.max(0, refreshResponse.expires_in - 60) * 1000
        );

        const encryptedRefreshToken = refreshResponse.refresh_token
          ? encryptToken(refreshResponse.refresh_token)
          : undefined;

        await prisma.providerAccount.update({
          where: { id: account.id },
          data: {
            encryptedAccessToken,
            ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
            tokenExpiresAt,
            status: ProviderAccountStatus.CONNECTED,
            refreshLockToken: null,
            refreshLockExpiresAt: null,
          },
        });

        return newAccessToken;
      } catch (refreshErr) {
        await prisma.providerAccount
          .updateMany({
            where: { id: account.id, refreshLockToken: lockToken },
            data: { refreshLockToken: null, refreshLockExpiresAt: null },
          })
          .catch(() => {});
        throw refreshErr;
      }
    }

    // Another worker is currently refreshing. Wait and poll.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const polled = await prisma.providerAccount.findUnique({
      where: { id: account.id },
    });
    if (
      polled &&
      polled.tokenExpiresAt &&
      polled.tokenExpiresAt.getTime() - Date.now() > 3 * 60 * 1000
    ) {
      return decryptToken(polled.encryptedAccessToken);
    }
  }

  throw new TokenRefreshError("YOUTUBE_MUSIC", "Timed out waiting for concurrent token refresh lock.");
}

/**
 * Disconnects a YouTube provider account and attempts server-side token revocation.
 */
export async function disconnectYouTubeAccount(
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
  if (account.provider !== ProviderType.YOUTUBE_MUSIC) {
    throw new ForbiddenError("Specified provider account is not a YouTube account.");
  }

  // Attempt server-side revocation with Google (best-effort)
  try {
    const rawToken = account.encryptedRefreshToken
      ? decryptToken(account.encryptedRefreshToken)
      : decryptToken(account.encryptedAccessToken);

    await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(rawToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }).catch(() => {});
  } catch {
    // Revocation failure should not prevent local disconnection
  }

  await prisma.providerAccount.update({
    where: { id: account.id },
    data: {
      status: ProviderAccountStatus.DISCONNECTED,
      refreshLockToken: null,
      refreshLockExpiresAt: null,
    },
  });
}
