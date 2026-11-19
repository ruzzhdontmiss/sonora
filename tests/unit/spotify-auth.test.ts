import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  generatePKCEPair,
  generateSpotifyAuthorizeUrl,
  handleSpotifyCallback,
  getValidSpotifyAccessToken,
  disconnectSpotifyAccount,
  getSpotifyConfigStatus,
  SPOTIFY_READONLY_SCOPES,
} from "@/modules/providers/spotify/spotify-auth.service";
import {
  OAuthStateValidationError,
  OAuthTokenExchangeError,
  TokenRefreshError,
  ProviderNotConfiguredError,
} from "@/modules/providers/errors";
import { encryptToken, decryptToken } from "@/lib/encryption";
import { ProviderType, ProviderAccountStatus } from "@prisma/client";

describe("Spotify OAuth & Token Lifecycle (Unit & DB Integration)", () => {
  const testUserId = "ee000000-0000-0000-0000-000000000010";

  beforeEach(async () => {
    // Set test environment variables for Spotify
    process.env["SPOTIFY_CLIENT_ID"] = "placeholder";
    process.env["SPOTIFY_CLIENT_SECRET"] = "placeholder";
    process.env["SPOTIFY_REDIRECT_URI"] = "http://127.0.0.1:3000/api/connections/spotify/callback";

    await prisma.oAuthState.deleteMany({ where: { userId: testUserId } });
    await prisma.providerAccount.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });

    await prisma.user.create({
      data: {
        id: testUserId,
        email: "spotify-tester@example.com",
        displayName: "Spotify Tester",
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.oAuthState.deleteMany({ where: { userId: testUserId } });
    await prisma.providerAccount.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
  });

  describe("PKCE Generation & Verification", () => {
    it("generates a high-entropy PKCE code_verifier and SHA-256 S256 code_challenge", () => {
      const { codeVerifier, codeChallenge } = generatePKCEPair();

      expect(codeVerifier).toBeDefined();
      expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(codeVerifier.length).toBeLessThanOrEqual(128);
      // Valid base64url characters only
      expect(/^[A-Za-z0-9_-]+$/.test(codeVerifier)).toBe(true);

      expect(codeChallenge).toBeDefined();
      expect(codeChallenge.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9_-]+$/.test(codeChallenge)).toBe(true);
    });
  });

  describe("generateSpotifyAuthorizeUrl", () => {
    it("creates an OAuthState DB record and returns a compliant Spotify authorize URL", async () => {
      const { url, state } = await generateSpotifyAuthorizeUrl(testUserId);

      expect(url).toContain("https://accounts.spotify.com/authorize");
      expect(url).toContain(`client_id=${process.env.SPOTIFY_CLIENT_ID}`);
      expect(url).toContain("response_type=code");
      expect(url).toContain("code_challenge_method=S256");
      expect(url).toContain(`state=${state}`);

      for (const scope of SPOTIFY_READONLY_SCOPES) {
        expect(url).toContain(encodeURIComponent(scope));
      }

      // Verify that full scopes include write permissions (user-library-modify and playlist-modify-private)
      expect(url).toContain(encodeURIComponent("user-library-modify"));
      expect(url).toContain(encodeURIComponent("playlist-modify-private"));
      expect(url).toContain(encodeURIComponent("playlist-modify-public"));

      // Verify OAuthState in DB
      const dbState = await prisma.oAuthState.findUnique({ where: { state } });
      expect(dbState).not.toBeNull();
      expect(dbState?.userId).toBe(testUserId);
      expect(dbState?.provider).toBe(ProviderType.SPOTIFY);
      expect(dbState?.used).toBe(false);
      expect(dbState?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("fails with ProviderNotConfiguredError if client credentials are not configured", async () => {
      const origId = process.env.SPOTIFY_CLIENT_ID;
      delete process.env.SPOTIFY_CLIENT_ID;

      await expect(generateSpotifyAuthorizeUrl(testUserId)).rejects.toThrow(
        ProviderNotConfiguredError
      );

      process.env.SPOTIFY_CLIENT_ID = origId;
    });
  });

  describe("handleSpotifyCallback", () => {
    it("exchanges code, retrieves profile, encrypts tokens at rest, and marks state used", async () => {
      const { state } = await generateSpotifyAuthorizeUrl(testUserId);

      // Mock Spotify Token Endpoint and Profile Endpoint
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("accounts.spotify.com/api/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "mock-access-token-12345",
              token_type: "Bearer",
              scope: SPOTIFY_READONLY_SCOPES.join(" "),
              expires_in: 3600,
              refresh_token: "mock-refresh-token-67890",
            }),
          });
        }
        if (url.includes("api.spotify.com/v1/me")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              id: "spotify-user-999",
              display_name: "Spotify Super User",
              email: "spotify-super@example.com",
              product: "premium",
            }),
          });
        }
        return Promise.reject(new Error(`Unhandled mock URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await handleSpotifyCallback("mock-auth-code", state, testUserId);

      expect(account).toBeDefined();
      expect(account.provider).toBe(ProviderType.SPOTIFY);
      expect(account.providerUserId).toBe("spotify-user-999");
      expect(account.displayName).toBe("Spotify Super User");
      expect(account.status).toBe(ProviderAccountStatus.CONNECTED);

      // Verify tokens are encrypted at rest
      expect(account.encryptedAccessToken).not.toBe("mock-access-token-12345");
      expect(decryptToken(account.encryptedAccessToken)).toBe("mock-access-token-12345");

      expect(account.encryptedRefreshToken).not.toBeNull();
      expect(account.encryptedRefreshToken).not.toBe("mock-refresh-token-67890");
      expect(decryptToken(account.encryptedRefreshToken!)).toBe("mock-refresh-token-67890");

      // Verify state was marked used
      const dbState = await prisma.oAuthState.findUnique({ where: { state } });
      expect(dbState?.used).toBe(true);

      // Replay attack test: second attempt with identical state MUST be rejected
      await expect(
        handleSpotifyCallback("mock-auth-code-replay", state, testUserId)
      ).rejects.toThrow(OAuthStateValidationError);
    });

    it("rejects invalid, mismatched, or expired state tokens", async () => {
      // Non-existent state
      await expect(
        handleSpotifyCallback("mock-code", "non-existent-state", testUserId)
      ).rejects.toThrow(OAuthStateValidationError);

      // Expired state
      const { state: expiredState } = await generateSpotifyAuthorizeUrl(testUserId);
      await prisma.oAuthState.update({
        where: { state: expiredState },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        handleSpotifyCallback("mock-code", expiredState, testUserId)
      ).rejects.toThrow(OAuthStateValidationError);
    });
  });

  describe("Token Refresh & Expiry Handling", () => {
    it("returns active token without network refresh if valid for > 3 minutes", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-active-token",
          displayName: "Active User",
          encryptedAccessToken: encryptToken("still-valid-access-token"),
          encryptedRefreshToken: encryptToken("active-refresh-token"),
          tokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min in future
          status: ProviderAccountStatus.CONNECTED,
        },
      });

      const token = await getValidSpotifyAccessToken(account.id, testUserId);
      expect(token).toBe("still-valid-access-token");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes expired access token, updates DB, and returns new token", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("accounts.spotify.com/api/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "brand-new-refreshed-token",
              token_type: "Bearer",
              scope: SPOTIFY_READONLY_SCOPES.join(" "),
              expires_in: 3600,
            }),
          });
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-expired-token",
          displayName: "Expired User",
          encryptedAccessToken: encryptToken("old-expired-token"),
          encryptedRefreshToken: encryptToken("valid-refresh-token"),
          tokenExpiresAt: new Date(Date.now() - 1000), // Expired
          status: ProviderAccountStatus.CONNECTED,
        },
      });

      const token = await getValidSpotifyAccessToken(account.id, testUserId);
      expect(token).toBe("brand-new-refreshed-token");

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(decryptToken(updated!.encryptedAccessToken)).toBe("brand-new-refreshed-token");
      expect(updated!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("marks account as REVOKED if Spotify token endpoint rejects refresh token (HTTP 400)", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-revoked-token",
          displayName: "Revoked User",
          encryptedAccessToken: encryptToken("old-token"),
          encryptedRefreshToken: encryptToken("revoked-refresh-token"),
          tokenExpiresAt: new Date(Date.now() - 1000),
          status: ProviderAccountStatus.CONNECTED,
        },
      });

      await expect(getValidSpotifyAccessToken(account.id, testUserId)).rejects.toThrow(TokenRefreshError);

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(updated?.status).toBe(ProviderAccountStatus.REVOKED);
    });

    it("serializes concurrent token refresh requests so only one HTTP call is made and all callers receive the fresh token", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("accounts.spotify.com/api/token")) {
          callCount++;
          // Simulate latency so concurrent callers collide on the lock
          await new Promise((res) => setTimeout(res, 250));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "concurrently-refreshed-token",
              token_type: "Bearer",
              scope: SPOTIFY_READONLY_SCOPES.join(" "),
              expires_in: 3600,
            }),
          };
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-concurrent-refresh",
          displayName: "Concurrent User",
          encryptedAccessToken: encryptToken("old-token"),
          encryptedRefreshToken: encryptToken("valid-refresh-token"),
          tokenExpiresAt: new Date(Date.now() - 5000), // Expired
          status: ProviderAccountStatus.CONNECTED,
        },
      });

      // Fire 3 simultaneous token refresh requests
      const [token1, token2, token3] = await Promise.all([
        getValidSpotifyAccessToken(account.id, testUserId),
        getValidSpotifyAccessToken(account.id, testUserId),
        getValidSpotifyAccessToken(account.id, testUserId),
      ]);

      expect(token1).toBe("concurrently-refreshed-token");
      expect(token2).toBe("concurrently-refreshed-token");
      expect(token3).toBe("concurrently-refreshed-token");
      // Only 1 HTTP call should have been made to Spotify!
      expect(callCount).toBe(1);

      // Verify lock was released
      const finalAccount = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(finalAccount?.refreshLockToken).toBeNull();
      expect(finalAccount?.refreshLockExpiresAt).toBeNull();
    });

    it("recovers and refreshes if a previous worker abandoned an expired refresh lock", async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("accounts.spotify.com/api/token")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "recovered-after-abandoned-lock-token",
              token_type: "Bearer",
              scope: SPOTIFY_READONLY_SCOPES.join(" "),
              expires_in: 3600,
            }),
          };
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });
      vi.stubGlobal("fetch", mockFetch);

      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-abandoned-lock",
          displayName: "Abandoned Lock User",
          encryptedAccessToken: encryptToken("old-token"),
          encryptedRefreshToken: encryptToken("valid-refresh-token"),
          tokenExpiresAt: new Date(Date.now() - 5000), // Expired
          status: ProviderAccountStatus.CONNECTED,
          refreshLockToken: "crashed-worker-lock-token",
          refreshLockExpiresAt: new Date(Date.now() - 10000), // Expired 10s ago
        },
      });

      const token = await getValidSpotifyAccessToken(account.id, testUserId);
      expect(token).toBe("recovered-after-abandoned-lock-token");

      const finalAccount = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(finalAccount?.refreshLockToken).toBeNull();
      expect(finalAccount?.refreshLockExpiresAt).toBeNull();
    });
  });

  describe("disconnectSpotifyAccount", () => {
    it("sets status to DISCONNECTED, wipes encrypted tokens, and preserves user records", async () => {
      const account = await prisma.providerAccount.create({
        data: {
          userId: testUserId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "user-to-disconnect",
          displayName: "To Disconnect",
          encryptedAccessToken: encryptToken("token-to-wipe"),
          encryptedRefreshToken: encryptToken("refresh-to-wipe"),
          status: ProviderAccountStatus.CONNECTED,
        },
      });

      await disconnectSpotifyAccount(account.id, testUserId);

      const updated = await prisma.providerAccount.findUnique({ where: { id: account.id } });
      expect(updated?.status).toBe(ProviderAccountStatus.DISCONNECTED);
      expect(updated?.encryptedAccessToken).toBe("");
      expect(updated?.encryptedRefreshToken).toBeNull();
      expect(updated?.tokenExpiresAt).toBeNull();

      // Crucial: User record and any canonical data must remain intact!
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).not.toBeNull();
    });
  });
});
