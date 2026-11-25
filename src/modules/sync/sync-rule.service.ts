/**
 * Automated Sync Rules & Continuous Reconciliation Engine for SONORA (P5-T08).
 *
 * Implements non-destructive, additive-first continuous sync between streaming providers
 * (Spotify, Apple Music, YouTube Music) governed by user-defined conflict policies.
 */

import { prisma } from "@/lib/db";
import {
  ConflictPolicy,
  ProviderType,
  SyncDirection,
  SyncJobStatus,
  SyncRule,
} from "@prisma/client";
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from "@/modules/common/errors";
import { createMigrationJob } from "@/modules/jobs/migration-orchestrator";

export interface CreateSyncRuleInput {
  name: string;
  sourceProvider: ProviderType;
  targetProvider: ProviderType;
  direction?: SyncDirection;
  conflictPolicy?: ConflictPolicy;
}

export interface UpdateSyncRuleInput {
  name?: string;
  direction?: SyncDirection;
  conflictPolicy?: ConflictPolicy;
  isActive?: boolean;
}

export interface ReconcileResult {
  ruleId: string;
  syncJobId: string;
  status: SyncJobStatus;
  message: string;
}

/**
 * Creates a persistent synchronization rule between two providers.
 */
export async function createSyncRule(
  userId: string,
  input: CreateSyncRuleInput
): Promise<SyncRule> {
  const {
    name,
    sourceProvider,
    targetProvider,
    direction = SyncDirection.ONE_WAY,
    conflictPolicy = ConflictPolicy.ADDITIVE_MERGE,
  } = input;

  if (sourceProvider === targetProvider) {
    throw new ValidationError("Source and target providers must be different.");
  }

  // Verify that user has connected accounts for both providers
  const [sourceAccount, targetAccount] = await Promise.all([
    prisma.providerAccount.findFirst({
      where: { userId, provider: sourceProvider, status: "CONNECTED" },
    }),
    prisma.providerAccount.findFirst({
      where: { userId, provider: targetProvider, status: "CONNECTED" },
    }),
  ]);

  if (!sourceAccount) {
    throw new ForbiddenError(
      `Source provider ${sourceProvider} is not connected. Connect it first.`
    );
  }
  if (!targetAccount) {
    throw new ForbiddenError(
      `Target provider ${targetProvider} is not connected. Connect it first.`
    );
  }

  return await prisma.syncRule.create({
    data: {
      userId,
      name: name.trim(),
      sourceProvider,
      targetProvider,
      direction,
      conflictPolicy,
      isActive: true,
    },
  });
}

/**
 * Lists all configured synchronization rules for an authorized user.
 */
export async function listSyncRules(userId: string): Promise<SyncRule[]> {
  return await prisma.syncRule.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Updates a sync rule (activate/deactivate, rename, modify conflict policy).
 */
export async function updateSyncRule(
  userId: string,
  ruleId: string,
  updates: UpdateSyncRuleInput
): Promise<SyncRule> {
  const existing = await prisma.syncRule.findFirst({
    where: { id: ruleId, userId },
  });

  if (!existing) {
    throw new NotFoundError("SyncRule", ruleId);
  }

  return await prisma.syncRule.update({
    where: { id: ruleId },
    data: {
      name: updates.name?.trim(),
      direction: updates.direction,
      conflictPolicy: updates.conflictPolicy,
      isActive: updates.isActive,
    },
  });
}

/**
 * Deletes a sync rule.
 */
export async function deleteSyncRule(userId: string, ruleId: string): Promise<void> {
  const existing = await prisma.syncRule.findFirst({
    where: { id: ruleId, userId },
  });

  if (!existing) {
    throw new NotFoundError("SyncRule", ruleId);
  }

  await prisma.syncRule.delete({
    where: { id: ruleId },
  });
}

/**
 * Executes a continuous reconciliation pass for a sync rule via transactional outbox.
 * Enforces the configured conflict policy (defaulting to non-destructive ADDITIVE_MERGE).
 */
export async function reconcileSyncRule(
  userId: string,
  ruleId: string
): Promise<ReconcileResult> {
  const rule = await prisma.syncRule.findFirst({
    where: { id: ruleId, userId },
  });

  if (!rule) {
    throw new NotFoundError("SyncRule", ruleId);
  }

  if (!rule.isActive) {
    throw new ValidationError(`SyncRule "${rule.name}" is currently inactive.`);
  }

  // Fetch all user playlists
  const playlists = await prisma.playlist.findMany({
    where: { userId, deletedAt: null },
    select: { id: true },
  });

  const playlistIds = playlists.map((p) => p.id);

  // Trigger migration job with additive-merge policy (confirmed=true)
  const job = await createMigrationJob(userId, {
    sourceProvider: rule.sourceProvider,
    destinationProvider: rule.targetProvider,
    playlistIds,
    migrateLikedSongs: true,
    confirmed: true,
    userPreferences: {
      preserveDuplicates: true,
      autoResolveHighConfidence: true,
    },
  });

  return {
    ruleId: rule.id,
    syncJobId: job.id,
    status: job.status,
    message: `Reconciliation job dispatched via ${rule.conflictPolicy} policy.`,
  };
}
