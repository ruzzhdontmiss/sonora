import { prisma } from "@/lib/db";
import { encryptToken, decryptToken } from "@/lib/encryption";
import { getAppleDeveloperToken } from "./apple-token.service";
import { ProviderAccount, ProviderType, ProviderAccountStatus } from "@prisma/client";
import {
  ProviderAuthenticationError,
  ProviderError,
} from "../errors";
import { NotFoundError, ForbiddenError } from "@/modules/common/errors";
import crypto from "crypto";

const APPLE_MUSIC_API_BASE = "https://api.music.apple.com/v1";

export interface AppleStorefrontResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      defaultLanguageTag: string;
      name: string;
      supportedLanguageTags: string[];
    };
  }>;
}

/**
 * Validates the user's Music User Token (MUT) by querying the user's Apple Music storefront.
 * Security Invariant: Encrypts the MUT at rest using AES-256-GCM authenticated encryption.
 */
export async function saveAppleMusicUserToken(
  userId: string,
  musicUserToken: string
): Promise<ProviderAccount> {
  if (!musicUserToken || musicUserToken.trim().length === 0) {
    throw new ProviderAuthenticationError("APPLE_MUSIC", "Music user token is empty or invalid.");
  }

  const developerToken = await getAppleDeveloperToken();

  // Validate the MUT against Apple Music API
  let storefrontId = "us";
  let storefrontName = "United States";

  try {
    const res = await fetch(`${APPLE_MUSIC_API_BASE}/me/storefront`, {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Music-User-Token": musicUserToken.trim(),
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ProviderAuthenticationError(
          "APPLE_MUSIC",
          "Apple Music rejected user token. Active Apple Music subscription required."
        );
      }
      throw new ProviderError(
        "APPLE_MUSIC",
        `Failed to validate Apple Music user token (HTTP ${res.status})`
      );
    }

    const data = (await res.json()) as AppleStorefrontResponse;
    if (data.data && data.data.length > 0) {
      storefrontId = data.data[0].id;
      storefrontName = data.data[0].attributes.name || storefrontId.toUpperCase();
    }
  } catch (err: unknown) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "APPLE_MUSIC",
      `Network failure connecting to Apple Music: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Generate deterministic external identifier based on cryptographic hash of the MUT
  // Apple does not reveal the user's Apple ID email to MusicKit web clients.
  const providerUserId = `apple-user-${crypto
    .createHash("sha256")
    .update(musicUserToken.trim())
    .digest("hex")
    .slice(0, 16)}`;

  // Check if another user already connected this Apple Music account
  const existingOtherUser = await prisma.providerAccount.findFirst({
    where: {
      provider: ProviderType.APPLE_MUSIC,
      providerUserId,
      userId: { not: userId },
      status: ProviderAccountStatus.CONNECTED,
    },
  });
  if (existingOtherUser) {
    throw new ForbiddenError("This Apple Music account is already connected to another user.");
  }

  const encryptedAccessToken = encryptToken(musicUserToken.trim());
  const displayName = `Apple Music (${storefrontName})`;

  // Maintain single active Apple Music account per user on re-authorization
  const existingUserAccount = await prisma.providerAccount.findFirst({
    where: {
      userId,
      provider: ProviderType.APPLE_MUSIC,
    },
  });

  let account: ProviderAccount;
  if (existingUserAccount) {
    account = await prisma.providerAccount.update({
      where: { id: existingUserAccount.id },
      data: {
        providerUserId,
        displayName,
        encryptedAccessToken,
        status: ProviderAccountStatus.CONNECTED,
        metadata: {
          storefront: storefrontId,
          storefrontName,
        },
      },
    });
  } else {
    account = await prisma.providerAccount.create({
      data: {
        userId,
        provider: ProviderType.APPLE_MUSIC,
        providerUserId,
        displayName,
        encryptedAccessToken,
        scopes: ["music.library.read"],
        status: ProviderAccountStatus.CONNECTED,
        metadata: {
          storefront: storefrontId,
          storefrontName,
        },
      },
    });
  }

  return account;
}

/**
 * Retrieves the decrypted Apple Music User Token, verifying ownership and active status.
 */
export async function getValidAppleMusicUserToken(
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
  if (account.provider !== ProviderType.APPLE_MUSIC) {
    throw new ForbiddenError("Specified account is not an Apple Music account.");
  }
  if (account.status === ProviderAccountStatus.DISCONNECTED) {
    throw new ForbiddenError("Apple Music account is disconnected. Please re-authorize.");
  }

  return decryptToken(account.encryptedAccessToken);
}

/**
 * Disconnects an Apple Music account safely.
 * Product Invariant: Disconnecting Apple Music NEVER deletes the user's canonical library or playlists!
 */
export async function disconnectAppleMusicAccount(
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
