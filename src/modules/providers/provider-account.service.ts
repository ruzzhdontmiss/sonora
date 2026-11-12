import { prisma } from "@/lib/db";
import { ProviderType, ProviderAccountStatus, ProviderAccount, Prisma } from "@prisma/client";
import { encryptToken } from "@/lib/encryption";
import { NotFoundError, ForbiddenError, ValidationError } from "@/modules/common/errors";

export interface LinkProviderAccountInput {
  provider: ProviderType;
  providerUserId: string;
  displayName: string;
  email?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes?: string[];
  metadata?: Prisma.InputJsonValue;
}

/**
 * Sanitized representation of a connected provider account safe for client exposure.
 * Never includes raw or encrypted access/refresh tokens.
 */
export interface SanitizedProviderAccount {
  id: string;
  userId: string;
  provider: ProviderType;
  providerUserId: string;
  displayName: string;
  email: string | null;
  scopes: string[];
  status: ProviderAccountStatus;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function sanitizeAccount(account: ProviderAccount): SanitizedProviderAccount {
  return {
    id: account.id,
    userId: account.userId,
    provider: account.provider,
    providerUserId: account.providerUserId,
    displayName: account.displayName,
    email: account.email,
    scopes: account.scopes,
    status: account.status,
    tokenExpiresAt: account.tokenExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/**
 * Retrieves all provider connections belonging to a user.
 * Access and refresh tokens are strictly redacted from return value.
 */
export async function getUserProviderAccounts(userId: string): Promise<SanitizedProviderAccount[]> {
  const accounts = await prisma.providerAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return accounts.map(sanitizeAccount);
}

/**
 * Retrieves a single provider account by ID, strictly verifying user ownership.
 */
export async function getUserProviderAccountById(
  userId: string,
  accountId: string
): Promise<SanitizedProviderAccount> {
  const account = await prisma.providerAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new NotFoundError("ProviderAccount", accountId);
  }

  if (account.userId !== userId) {
    throw new ForbiddenError("You do not have access to this provider connection.");
  }

  return sanitizeAccount(account);
}

/**
 * Links or updates an external provider account connection.
 * Encrypts access and refresh tokens at rest using authenticated AES-256-GCM.
 */
export async function linkProviderAccount(
  userId: string,
  input: LinkProviderAccountInput
): Promise<SanitizedProviderAccount> {
  if (!input.accessToken?.trim()) {
    throw new ValidationError("Access token is required to link a provider account.");
  }
  if (!input.providerUserId?.trim()) {
    throw new ValidationError("Provider user ID is required.");
  }

  const encryptedAccessToken = encryptToken(input.accessToken);
  const encryptedRefreshToken = input.refreshToken
    ? encryptToken(input.refreshToken)
    : null;

  const account = await prisma.providerAccount.upsert({
    where: {
      userId_provider_providerUserId: {
        userId,
        provider: input.provider,
        providerUserId: input.providerUserId,
      },
    },
    update: {
      displayName: input.displayName,
      email: input.email ?? null,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      scopes: input.scopes ?? [],
      status: ProviderAccountStatus.CONNECTED,
      metadata: input.metadata ?? undefined,
    },
    create: {
      userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      displayName: input.displayName,
      email: input.email ?? null,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      scopes: input.scopes ?? [],
      status: ProviderAccountStatus.CONNECTED,
      metadata: input.metadata ?? undefined,
    },
  });

  return sanitizeAccount(account);
}

/**
 * Safely disconnects a provider account.
 * Updates status to DISCONNECTED and clears stored token ciphertexts.
 * IMPORTANT: Invariant rule — disconnecting a provider MUST NOT delete the user's canonical library or playlists.
 */
export async function disconnectProviderAccount(
  userId: string,
  accountId: string
): Promise<{ success: boolean }> {
  const account = await prisma.providerAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new NotFoundError("ProviderAccount", accountId);
  }

  if (account.userId !== userId) {
    throw new ForbiddenError("You do not have permission to disconnect this provider connection.");
  }

  await prisma.providerAccount.update({
    where: { id: accountId },
    data: {
      status: ProviderAccountStatus.DISCONNECTED,
      encryptedAccessToken: "revoked",
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
    },
  });

  return { success: true };
}
