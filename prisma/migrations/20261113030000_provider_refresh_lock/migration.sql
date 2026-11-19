-- AlterTable: Add refresh lock columns to provider_accounts for multi-process concurrency control
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "refreshLockToken" TEXT;
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "refreshLockExpiresAt" TIMESTAMP(3);
