import { prisma } from "@/lib/db";
import {
  spotifyImporter,
  ImportCheckpoint as SpotifyImportCheckpoint,
} from "@/modules/providers/spotify/spotify-importer.service";
import {
  appleMusicImporter,
  AppleImportCheckpoint as AppleMusicImportCheckpoint,
} from "@/modules/providers/apple/apple-importer.service";
import {
  ProviderAccountStatus,
  ProviderType,
  SyncJob,
  SyncJobStatus,
  SyncJobType,
} from "@prisma/client";
import { NotFoundError, ForbiddenError, ValidationError } from "@/modules/common/errors";

export interface ImportJobPayload {
  syncJobId: string;
  userId: string;
  providerAccountId: string;
}

/**
 * Initiates a durable asynchronous import job for a connected streaming provider account.
 * Atomically records a SyncJob and dispatches an OutboxEvent inside PostgreSQL.
 */
export async function triggerImportJob(
  userId: string,
  providerAccountId: string
): Promise<SyncJob> {
  const account = await prisma.providerAccount.findFirst({
    where: {
      id: providerAccountId,
      userId,
    },
  });

  if (!account) {
    throw new NotFoundError("Provider account", providerAccountId);
  }
  if (account.status !== ProviderAccountStatus.CONNECTED) {
    throw new ForbiddenError(
      `Cannot import from ${account.provider}: Account status is ${account.status}. Please reconnect first.`
    );
  }

  // Prevent duplicate concurrent imports for the same provider account
  const activeJob = await prisma.syncJob.findFirst({
    where: {
      userId,
      sourceProvider: account.provider,
      status: { in: [SyncJobStatus.QUEUED, SyncJobStatus.RUNNING] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeJob) {
    return activeJob;
  }

  // Atomically create SyncJob and OutboxEvent
  return await prisma.$transaction(async (tx) => {
    const job = await tx.syncJob.create({
      data: {
        userId,
        jobType: SyncJobType.IMPORT,
        sourceProvider: account.provider,
        targetProvider: "SONORA",
        status: SyncJobStatus.QUEUED,
        totalItems: 0,
        processedItems: 0,
        failedItems: 0,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventType: "IMPORT_JOB_DISPATCHED",
        payload: {
          syncJobId: job.id,
          userId,
          providerAccountId: account.id,
        },
      },
    });

    return job;
  });
}

/**
 * Worker handler to process an import job dispatched via transactional outbox.
 * Supports durable checkpoint resumption and real-time progress updates.
 */
export async function executeImportJob(payload: unknown): Promise<void> {
  const data = payload as ImportJobPayload;
  if (!data?.syncJobId || !data?.userId || !data?.providerAccountId) {
    throw new ValidationError("Invalid import job payload: missing required fields");
  }

  const { syncJobId, userId, providerAccountId } = data;

  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
  });

  if (!job) {
    console.warn(`SyncJob [${syncJobId}] not found for execution.`);
    return;
  }

  if (job.status === SyncJobStatus.COMPLETED || job.status === SyncJobStatus.CANCELLED) {
    return;
  }

  // Mark RUNNING
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: {
      status: SyncJobStatus.RUNNING,
      startedAt: new Date(),
    },
  });

  const account = await prisma.providerAccount.findFirst({
    where: {
      id: providerAccountId,
      userId,
    },
  });

  if (!account || account.status !== ProviderAccountStatus.CONNECTED) {
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.FAILED,
        completedAt: new Date(),
      },
    });
    return;
  }

  try {
    if (account.provider === ProviderType.SPOTIFY) {
      await spotifyImporter.importLibrary({
        userId,
        providerAccountId,
        syncJobId,
        checkpoint: (job.checkpoint as unknown as SpotifyImportCheckpoint) ?? undefined,
        onProgress: async (progress) => {
          await prisma.syncJob.update({
            where: { id: syncJobId },
            data: {
              processedItems: progress.processed,
              failedItems: progress.failed,
            },
          });
        },
      });
    } else if (account.provider === ProviderType.APPLE_MUSIC) {
      await appleMusicImporter.importLibrary({
        userId,
        providerAccountId,
        syncJobId,
        checkpoint: (job.checkpoint as unknown as AppleMusicImportCheckpoint) ?? undefined,
        onProgress: async (progress) => {
          await prisma.syncJob.update({
            where: { id: syncJobId },
            data: {
              processedItems: progress.processed,
              failedItems: progress.failed,
            },
          });
        },
      });
    } else {
      throw new ValidationError(`Unsupported provider for import: ${account.provider}`);
    }

    // Complete Job
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  } catch (err: unknown) {
    console.error(`Import execution failed for SyncJob [${syncJobId}]:`, err);
    await prisma.syncJob.update({
      where: { id: syncJobId },
      data: {
        status: SyncJobStatus.FAILED,
        completedAt: new Date(),
      },
    });
    throw err;
  }
}
