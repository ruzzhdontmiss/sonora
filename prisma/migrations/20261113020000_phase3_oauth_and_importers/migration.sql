-- AlterTable: Add checkpoint column to sync_jobs
ALTER TABLE "sync_jobs" ADD COLUMN IF NOT EXISTS "checkpoint" JSONB;

-- CreateTable: oauth_states for PKCE flow with replay protection
CREATE TABLE IF NOT EXISTS "oauth_states" (
    "id" TEXT NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_states_state_idx" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "oauth_states_userId_provider_idx" ON "oauth_states"("userId", "provider");
