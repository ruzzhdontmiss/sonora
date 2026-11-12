import crypto from "crypto";
import { getEnv } from "@/config/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Derives or decodes an exact 32-byte (256-bit) encryption key.
 * - If the key is a 64-character hexadecimal string, decodes directly to 32 bytes.
 * - Otherwise, derives a 32-byte key via SHA-256 digest of the input string.
 * Both paths guarantee an exactly 32-byte buffer required by AES-256-GCM.
 */
export function deriveKey(rawKey: string): Buffer {
  if (!rawKey || typeof rawKey !== "string") {
    throw new Error("Invalid encryption key: key must be a non-empty string");
  }

  // If 64 hex characters (32 bytes hex-encoded)
  if (rawKey.length === 64 && /^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, "hex");
  }

  // Derive exact 32-byte buffer via SHA-256
  return crypto.createHash("sha256").update(rawKey, "utf8").digest();
}

/**
 * Gets the primary active encryption key derived from environment configuration.
 */
function getActiveKey(): Buffer {
  const env = getEnv();
  return deriveKey(env.TOKEN_ENCRYPTION_KEY);
}

/**
 * Encrypts sensitive plaintext (such as OAuth access or refresh tokens)
 * using authenticated AES-256-GCM.
 * Format: v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptToken(plaintext: string, key?: Buffer): string {
  if (!plaintext) {
    throw new Error("Cannot encrypt empty or null token");
  }

  const activeKey = key ?? getActiveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, activeKey, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypts an authenticated ciphertext token string.
 * Validates the authentication tag to ensure data integrity and authenticity.
 * Supports optional fallback keys to enable zero-downtime key rotation.
 */
export function decryptToken(
  encryptedPayload: string,
  options?: { fallbackKeys?: string[] }
): string {
  if (!encryptedPayload) {
    throw new Error("Cannot decrypt empty or null payload");
  }

  const parts = encryptedPayload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token format or unsupported version");
  }

  const [, ivHex, tagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Invalid IV or authentication tag length");
  }

  // Build candidate key list: active key first, then fallbacks
  const candidateKeys: Buffer[] = [getActiveKey()];
  if (options?.fallbackKeys) {
    for (const fb of options.fallbackKeys) {
      try {
        candidateKeys.push(deriveKey(fb));
      } catch {
        // Skip invalid fallback
      }
    }
  }

  // Attempt decryption with candidate keys
  for (const candidateKey of candidateKeys) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, candidateKey, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return decrypted.toString("utf8");
    } catch {
      // Continue to next key candidate if authentication tag check fails
      continue;
    }
  }

  // All key candidates failed
  throw new Error("Failed to decrypt token: authenticity verification failed");
}

/**
 * Re-encrypts an existing encrypted token with the current active key.
 * Used during key rotation migration tasks.
 */
export function reencryptToken(
  encryptedPayload: string,
  options?: { fallbackKeys?: string[] }
): string {
  const plaintext = decryptToken(encryptedPayload, options);
  return encryptToken(plaintext);
}
