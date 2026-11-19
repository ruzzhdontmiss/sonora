import fs from "fs";
import * as jose from "jose";
import { getEnv } from "@/config/env";
import { ProviderNotConfiguredError, ProviderError } from "../errors";

export interface AppleConfigStatus {
  isConfigured: boolean;
  missingVariables: string[];
}

export function getAppleConfigStatus(): AppleConfigStatus {
  const env = getEnv();
  const missing: string[] = [];

  if (!env.APPLE_TEAM_ID) missing.push("APPLE_TEAM_ID");
  if (!env.APPLE_MUSIC_KEY_ID) missing.push("APPLE_MUSIC_KEY_ID");
  if (!env.APPLE_MUSIC_PRIVATE_KEY_PATH && !env.APPLE_MUSIC_PRIVATE_KEY) {
    missing.push("APPLE_MUSIC_PRIVATE_KEY_PATH");
  }

  return {
    isConfigured: missing.length === 0,
    missingVariables: missing,
  };
}

let cachedDeveloperToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Resets the token cache (used in tests or key rotation).
 */
export function resetAppleTokenCache(): void {
  cachedDeveloperToken = null;
}

/**
 * Loads the Apple Music private key from configured path or direct environment variable.
 * Security Invariant: The private key is strictly server-only and NEVER returned to clients.
 */
function loadApplePrivateKeyPem(): string {
  const env = getEnv();

  if (env.APPLE_MUSIC_PRIVATE_KEY) {
    let key = env.APPLE_MUSIC_PRIVATE_KEY.trim();
    const pemHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    const pemFooter = ["-----END", "PRIVATE", "KEY-----"].join(" ");
    if (!key.startsWith(pemHeader)) {
      // Handle base64-encoded or raw multi-line strings
      key = `${pemHeader}\n${key}\n${pemFooter}`;
    }
    return key;
  }

  if (env.APPLE_MUSIC_PRIVATE_KEY_PATH) {
    if (!fs.existsSync(env.APPLE_MUSIC_PRIVATE_KEY_PATH)) {
      throw new ProviderError(
        "APPLE_MUSIC",
        `Configured private key file not found at path: ${env.APPLE_MUSIC_PRIVATE_KEY_PATH}`
      );
    }
    return fs.readFileSync(env.APPLE_MUSIC_PRIVATE_KEY_PATH, "utf8").trim();
  }

  throw new ProviderNotConfiguredError("APPLE_MUSIC", ["APPLE_MUSIC_PRIVATE_KEY_PATH"]);
}

/**
 * Generates an Apple Music Developer Token signed with ES256 using the developer's .p8 private key.
 * Caches token in memory with automatic rotation 2 hours prior to expiration.
 */
export async function getAppleDeveloperToken(): Promise<string> {
  const status = getAppleConfigStatus();
  if (!status.isConfigured) {
    throw new ProviderNotConfiguredError("APPLE_MUSIC", status.missingVariables);
  }

  const nowMs = Date.now();
  // If cached token has at least 2 hours of validity remaining, reuse it
  if (cachedDeveloperToken && cachedDeveloperToken.expiresAtMs - nowMs > 2 * 60 * 60 * 1000) {
    return cachedDeveloperToken.token;
  }

  const env = getEnv();
  const teamId = env.APPLE_TEAM_ID!;
  const keyId = env.APPLE_MUSIC_KEY_ID!;
  const privateKeyPem = loadApplePrivateKeyPem();

  try {
    const privateKey = await jose.importPKCS8(privateKeyPem, "ES256");

    const tokenDurationSeconds = 24 * 60 * 60; // 24 hours
    const expiresAtMs = nowMs + tokenDurationSeconds * 1000;

    const jwt = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(Math.floor(nowMs / 1000))
      .setExpirationTime(Math.floor(expiresAtMs / 1000))
      .sign(privateKey);

    cachedDeveloperToken = {
      token: jwt,
      expiresAtMs,
    };

    return jwt;
  } catch (err: unknown) {
    throw new ProviderError(
      "APPLE_MUSIC",
      `Failed to sign Apple Music Developer Token with ES256: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
