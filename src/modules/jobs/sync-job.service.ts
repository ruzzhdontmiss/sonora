import { prisma } from "@/lib/db";
import {
  SyncJobType,
  SyncJobStatus,
  SyncOperationAction,
  SyncOperationStatus,
} from "@prisma/client";
import { NotFoundError, ForbiddenError } from "@/modules/common/errors";

export interface CreateSyncJobInput {
  userId: string;
  jobType: SyncJobType;
  sourceProvider: string;
  targetProvider: string;
  totalItems?: number;
}

export interface RecordOperationInput {
  itemType: string;
  sourceId: string;
  targetId?: string | null;
  action: SyncOperationAction;
  status: SyncOperationStatus;
  errorMessage?: string | null;
}

/**
 * Creates a durable sync job record with initial QUEUED status.
 */
export async function createSyncJob(input: CreateSyncJobInput) {
  return await prisma.syncJob.create({
    data: {
      userId: input.userId,
      jobType: input.jobType,
      sourceProvider: input.sourceProvider,
      targetProvider: input.targetProvider,
      status: SyncJobStatus.QUEUED,
      totalItems: input.totalItems ?? 0,
      processedItems: 0,
      failedItems: 0,
    },
  });
}

/**
 * Transitions job to RUNNING and sets startedAt timestamp.
 */
export async function startSyncJob(jobId: string) {
  return await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: SyncJobStatus.RUNNING,
      startedAt: new Date(),
    },
  });
}

/**
 * Records an individual item outcome within a SyncJob and updates job counters.
 */
export async function recordSyncOperation(
  jobId: string,
  input: RecordOperationInput
) {
  return await prisma.$transaction(async (tx) => {
    const op = await tx.syncOperation.create({
      data: {
        syncJobId: jobId,
        itemType: input.itemType,
        sourceId: input.sourceId,
        targetId: input.targetId ?? null,
        action: input.action,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
      },
    });

    const isFailure = input.status === SyncOperationStatus.ERROR;

    await tx.syncJob.update({
      where: { id: jobId },
      data: {
        processedItems: { increment: 1 },
        failedItems: isFailure ? { increment: 1 } : undefined,
      },
    });

    return op;
  });
}

/**
 * Completes a sync job, marking COMPLETED or FAILED and setting completedAt timestamp.
 */
export async function completeSyncJob(
  jobId: string,
  status: SyncJobStatus = SyncJobStatus.COMPLETED
) {
  return await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status,
      completedAt: new Date(),
    },
  });
}

/**
 * Retrieves a sync job by ID with operations, enforcing user ownership.
 */
export async function getSyncJobById(userId: string, jobId: string) {
  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    include: {
      operations: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!job) {
    throw new NotFoundError("SyncJob", jobId);
  }

  if (job.userId !== userId) {
    throw new ForbiddenError("You do not have access to this sync job.");
  }

  return job;
}

