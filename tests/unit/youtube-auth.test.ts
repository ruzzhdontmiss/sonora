import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";

process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.AUTH_SECRET =
  process.env.AUTH_SECRET || "test-super-secret-auth-key-16-bytes-min";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://sonora:sonoradev@localhost:5432/sonora";
process.env["GOOGLE_CLIENT_ID"] = "placeholder";
process.env["GOOGLE_CLIENT_SECRET"] = "placeholder";

import { prisma } from "@/lib/db";
import { ProviderType, ProviderAccountStatus } from "@prisma/client";
import {
  generatePKCEPair,
  getGoogleConfigStatus,
  generateGoogleAuthorizeUrl,
  handleGoogleCallback,
  getValidYouTubeAccessToken,
  disconnectYouTubeAccount,
  YOUTUBE_READONLY_SCOPES,
  YOUTUBE_FULL_SCOPES,
  GOOGLE_DATA_PORTABILITY_SCOPE,
} from "@/modules/providers/youtube/youtube-auth.service";
import {
  OAuthStateValidationError,
  OAuthTokenExchangeError,
  TokenRefreshError,
  ProviderAuthenticationError,
} from "@/modules/providers/errors";
import { decryptToken } from "@/lib/encryption";
import { NotFoundError, ForbiddenError } from "@/modules/common/errors";

describe("Google OAuth 2.0 & YouTube Account Connection (P5-T02)", () => {
  const testUserId = "user_oauth_test_01";
  const testUserId2 = "user_oauth_test_02";

  beforeAll(async () => {
    // Ensure test users exist in DB
    await prisma.user.upsert({
      where: { id: testUserId },
      create: {
        id: testUserId,
        email: "oauth-tester@example.com",
        passwordHash: "hash",
      },
      update: {},
    });

    await prisma.user.upsert({
      where: { id: testUserId2 },
      create: {
        id: testUserId2,
        email: "oauth-tester-2@example.com",
        passwordHash: "hash",
      },
      update: {},
    });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.oAuthState.deleteMany({
      where: { userId: { in: [testUserId, testUserId2] } },
    });
    await prisma.providerAccount.deleteMany({
      where: { userId: { in: [testUserId, testUserId2] } },
    });
  });

  describe("PKCE Generation & Config Validation", () => {
    it("generates valid RFC 7636 PKCE pair with S256 challenge", () => {
      const { codeVerifier, codeChallenge } = generatePKCEPair();
      expect(codeVerifier).toBeDefined();
      expect(codeChallenge).toBeDefined();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
      // S256 base64url challenge
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("verifies Google configuration status", () => {
      const status = getGoogleConfigStatus();
      expect(status.isConfigured).toBe(true);
      expect(status.missingVariables.length).toBe(0);
    });
  });

  describe("generateGoogleAuthorizeUrl", () => {
    it("generates secure authorization URL with PKCE and stores state record in database", async () => {
      const { url, state } = await generateGoogleAuthorizeUrl(testUserId);

      expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url).toContain("code_challenge_method=S256");
      expect(url).toContain("access_type=offline");
      expect(url).toContain("prompt=consent");

      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get("state")).toBe(state);
      expect(parsedUrl.searchParams.get("client_id")).toBe(process.env.GOOGLE_CLIENT_ID);

      // Verify DB record
      const dbState = await prisma.oAuthState.findUnique({
        where: { state },
      });
      expect(dbState).toBeDefined();
      expect(dbState?.userId).toBe(testUserId);
      expect(dbState?.provider).toBe(ProviderType.YOUTUBE_MUSIC);
      expect(dbState?.used).toBe(false);
      expect(dbState?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("supports incremental scopes: read-only by default, full write on demand", async () => {
      // Default: read-only
      const readOnly = await generateGoogleAuthorizeUrl(testUserId);
      expect(readOnly.url).toContain("youtube.readonly");
      expect(readOnly.url).not.toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube+");

      // Full write scopes
      const full = await generateGoogleAuthorizeUrl(testUserId, { includeWriteScopes: true });
      expect(full.url).toContain("https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube");

      // Data Portability
      const portability = await generateGoogleAuthorizeUrl(testUserId, {
        includeDataPortability: true,
      });
      expect(portability.url).toContain("dataportability.youtube.music");
    });
  });

  describe("handleGoogleCallback", () => {
    it("rejects invalid, expired, or replayed state parameters", async () => {
      // Non-existent state
      await expect(
        handleGoogleCallback("fake_code", "non_existent_state", testUserId)
      ).rejects.toThrow(OAuthStateValidationError);

      // State belonging to another user
      const { state: user2State } = await generateGoogleAuthorizeUrl(testUserId2);
      await expect(
        handleGoogleCallback("fake_code", user2State, testUserId)
      ).rejects.toThrow(OAuthStateValidationError);

      // Replayed state
      const { state: validState } = await generateGoogleAuthorizeUrl(testUserId);
      await prisma.oAuthState.update({
        where: { state: validState },
        data: { used: true },
      });
      await expect(
        handleGoogleCallback("fake_code", validState, testUserId)
      ).rejects.toThrow(OAuthStateValidationError);

      // Expired state
      const { state: expiredState } = await generateGoogleAuthorizeUrl(testUserId);
      await prisma.oAuthState.update({
        where: { state: expiredState },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        handleGoogleCallback("fake_code", expiredState, testUserId)
      ).rejects.toThrow(OAuthStateValidationError);
    });

    it("exchanges code for tokens, encrypts them at rest, and creates ProviderAccount", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);

      // Mock Google token endpoint & userinfo endpoint
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "google_mock_access_token_123",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: "google_mock_refresh_token_456",
                scope: YOUTUBE_READONLY_SCOPES.join(" "),
              }),
          });
        }
        if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                sub: "google_sub_10987654321",
                name: "YouTube Tester",
                email: "tester@youtube.com",
                picture: "https://example.com/avatar.jpg",
              }),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleGoogleCallback("valid_google_code", state, testUserId);

      expect(account).toBeDefined();
      expect(account.provider).toBe(ProviderType.YOUTUBE_MUSIC);
      expect(account.providerUserId).toBe("google_sub_10987654321");
      expect(account.displayName).toBe("YouTube Tester");
      expect(account.email).toBe("tester@youtube.com");
      expect(account.status).toBe(ProviderAccountStatus.CONNECTED);

      // Verify tokens are encrypted at rest!
      expect(account.encryptedAccessToken).not.toBe("google_mock_access_token_123");
      expect(decryptToken(account.encryptedAccessToken)).toBe("google_mock_access_token_123");

      expect(account.encryptedRefreshToken).toBeDefined();
      expect(account.encryptedRefreshToken).not.toBe("google_mock_refresh_token_456");
      expect(decryptToken(account.encryptedRefreshToken!)).toBe("google_mock_refresh_token_456");

      // Verify state was consumed
      const dbState = await prisma.oAuthState.findUnique({ where: { state } });
      expect(dbState?.used).toBe(true);
    });
  });

  describe("getValidYouTubeAccessToken", () => {
    it("returns active decrypted token without refreshing if valid", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "active_token_123",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: "refresh_token_123",
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sub: "google_123", name: "User" }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleGoogleCallback("code_1", state, testUserId);

      // Clear fetch calls
      mockFetch.mockClear();

      const token = await getValidYouTubeAccessToken(account.id, testUserId);
      expect(token).toBe("active_token_123");
      // Fetch should NOT have been called because token is still fresh!
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes expired token and acquires distributed refresh lock", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("userinfo")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sub: "google_exp_123", name: "User Exp" }),
          });
        }
        if (url.includes("oauth2.googleapis.com/token")) {
          callCount++;
          if (callCount === 1) {
            // First call: initial code exchange
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  access_token: "initial_google_token_111",
                  token_type: "Bearer",
                  expires_in: 3600,
                  refresh_token: "initial_google_refresh_token_222",
                }),
            });
          }
          // Second call: token refresh
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: "refreshed_google_token_999",
                token_type: "Bearer",
                expires_in: 3600,
              }),
          });
        }
        return Promise.reject(new Error("Unknown url"));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleGoogleCallback("code_exp", state, testUserId);

      // Expire token manually in DB
      await prisma.providerAccount.update({
        where: { id: account.id },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      });

      const token = await getValidYouTubeAccessToken(account.id, testUserId);
      expect(token).toBe("refreshed_google_token_999");

      // Verify DB was updated with new token
      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(decryptToken(updated!.encryptedAccessToken)).toBe("refreshed_google_token_999");
      expect(updated?.refreshLockToken).toBeNull();
    });

    it("marks account REVOKED when Google returns invalid_grant", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("userinfo")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sub: "google_rev_123", name: "User Rev" }),
          });
        }
        if (url.includes("token")) {
          callCount++;
          if (callCount === 1) {
            // Initial exchange succeeds
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  access_token: "initial_token_rev",
                  token_type: "Bearer",
                  expires_in: 3600,
                  refresh_token: "refresh_token_rev",
                }),
            });
          }
          // Subsequent refresh fails with invalid_grant (e.g. revoked or 7-day Testing mode expiration)
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve(JSON.stringify({ error: "invalid_grant" })),
          });
        }
        return Promise.reject(new Error("Unknown url"));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleGoogleCallback("code_rev", state, testUserId);
      // Expire token
      await prisma.providerAccount.update({
        where: { id: account.id },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        getValidYouTubeAccessToken(account.id, testUserId)
      ).rejects.toThrow(TokenRefreshError);

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(updated?.status).toBe(ProviderAccountStatus.REVOKED);
    });

    it("strictly enforces tenant ownership", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sub: "tenant_sub", access_token: "t", expires_in: 3600 }),
          })
        )
      );
      const account = await handleGoogleCallback("code", state, testUserId);

      // User 2 cannot access User 1's provider account
      await expect(
        getValidYouTubeAccessToken(account.id, testUserId2)
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("disconnectYouTubeAccount", () => {
    it("calls Google revocation endpoint and marks account DISCONNECTED", async () => {
      const { state } = await generateGoogleAuthorizeUrl(testUserId);
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("revoke")) {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sub: "disc_user", access_token: "token_to_disc", expires_in: 3600 }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleGoogleCallback("code_disc", state, testUserId);

      await disconnectYouTubeAccount(account.id, testUserId);

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(updated?.status).toBe(ProviderAccountStatus.DISCONNECTED);

      // Attempting to use disconnected account must fail
      await expect(
        getValidYouTubeAccessToken(account.id, testUserId)
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
