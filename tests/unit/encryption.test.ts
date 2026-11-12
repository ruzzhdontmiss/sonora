import { describe, it, expect, beforeAll } from "vitest";
import {
  deriveKey,
  encryptToken,
  decryptToken,
  reencryptToken,
} from "@/lib/encryption";

describe("OAuth Token Encryption & Tampering Resilience (Unit)", () => {
  const secretPayload = "oauth_refresh_token_test_abc123_!@#$%^&*()";
  const defaultTestKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || defaultTestKey;
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-super-secret-auth-key-16-bytes-min";
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://sonora:sonoradev@localhost:5432/sonora";
  });

  describe("deriveKey", () => {
    it("derives exact 32-byte buffer from 64-character hex string", () => {
      const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const keyBuf = deriveKey(hexKey);
      expect(keyBuf.length).toBe(32);
      expect(keyBuf.toString("hex")).toBe(hexKey);
    });

    it("derives 32-byte SHA-256 buffer from passphrase string", () => {
      const passphrase = "a_super_strong_passphrase_for_testing_12345";
      const keyBuf = deriveKey(passphrase);
      expect(keyBuf.length).toBe(32);
    });
  });

  describe("encryptToken and decryptToken roundtrip", () => {
    it("encrypts and decrypts secret token cleanly", () => {
      const encrypted = encryptToken(secretPayload);
      expect(encrypted.startsWith("v1:")).toBe(true);

      const decrypted = decryptToken(encrypted);
      expect(decrypted).toBe(secretPayload);
    });

    it("generates distinct ciphertexts for identical plaintext due to random IV", () => {
      const enc1 = encryptToken(secretPayload);
      const enc2 = encryptToken(secretPayload);

      expect(enc1).not.toBe(enc2);
      expect(decryptToken(enc1)).toBe(secretPayload);
      expect(decryptToken(enc2)).toBe(secretPayload);
    });
  });

  describe("Tamper Resistance (AES-256-GCM AEAD)", () => {
    it("rejects tampered ciphertext with authenticity verification error", () => {
      const encrypted = encryptToken(secretPayload);
      const parts = encrypted.split(":");
      expect(parts.length).toBe(4);

      const [version, ivHex, tagHex, dataHex] = parts;
      const dataBuf = Buffer.from(dataHex, "hex");
      // Flip the last byte of ciphertext
      dataBuf[dataBuf.length - 1] ^= 0x01;
      const tampered = `${version}:${ivHex}:${tagHex}:${dataBuf.toString("hex")}`;

      expect(() => decryptToken(tampered)).toThrow(
        "Failed to decrypt token: authenticity verification failed"
      );
    });

    it("rejects tampered IV with authenticity verification error", () => {
      const encrypted = encryptToken(secretPayload);
      const parts = encrypted.split(":");
      const [version, ivHex, tagHex, dataHex] = parts;

      const ivBuf = Buffer.from(ivHex, "hex");
      // Flip a byte in the IV
      ivBuf[0] ^= 0x01;
      const tampered = `${version}:${ivBuf.toString("hex")}:${tagHex}:${dataHex}`;

      expect(() => decryptToken(tampered)).toThrow(
        "Failed to decrypt token: authenticity verification failed"
      );
    });

    it("rejects tampered auth tag with authenticity verification error", () => {
      const encrypted = encryptToken(secretPayload);
      const parts = encrypted.split(":");
      const [version, ivHex, tagHex, dataHex] = parts;

      const tagBuf = Buffer.from(tagHex, "hex");
      // Flip a byte in the authentication tag
      tagBuf[0] ^= 0x01;
      const tampered = `${version}:${ivHex}:${tagBuf.toString("hex")}:${dataHex}`;

      expect(() => decryptToken(tampered)).toThrow(
        "Failed to decrypt token: authenticity verification failed"
      );
    });

    it("rejects malformed encrypted strings missing required components or unsupported version", () => {
      expect(() => decryptToken("invalid_format_string")).toThrow(
        "Invalid encrypted token format or unsupported version"
      );
      expect(() => decryptToken("v1:only_two_parts")).toThrow(
        "Invalid encrypted token format or unsupported version"
      );
      expect(() => decryptToken("v2:iv:tag:data")).toThrow(
        "Invalid encrypted token format or unsupported version"
      );
    });

    it("rejects empty or whitespace payloads", () => {
      expect(() => decryptToken("")).toThrow(
        "Cannot decrypt empty or null payload"
      );
    });
  });

  describe("Zero-Downtime Key Rotation", () => {
    it("decrypts legacy tokens using fallback keys and re-encrypts with active key", () => {
      const oldKey = "legacy_secret_key_from_prior_epoch_1";
      const oldKeyBuf = deriveKey(oldKey);

      // Encrypt with legacy key
      const legacyEncrypted = encryptToken(secretPayload, oldKeyBuf);

      // Decrypting with active key alone must fail
      expect(() => decryptToken(legacyEncrypted)).toThrow(
        "Failed to decrypt token: authenticity verification failed"
      );

      // Decrypting with fallback key succeeds
      const decryptedWithFallback = decryptToken(legacyEncrypted, {
        fallbackKeys: [oldKey],
      });
      expect(decryptedWithFallback).toBe(secretPayload);

      // Re-encrypt token to migrate to active key
      const migrated = reencryptToken(legacyEncrypted, {
        fallbackKeys: [oldKey],
      });
      expect(migrated).not.toBe(legacyEncrypted);

      // Migrated token now decrypts directly with active key alone
      expect(decryptToken(migrated)).toBe(secretPayload);
    });
  });
});
