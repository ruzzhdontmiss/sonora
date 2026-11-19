import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSpotifyConfigStatus, generateSpotifyAuthorizeUrl } from "@/modules/providers/spotify/spotify-auth.service";
import { getAppleConfigStatus, getAppleDeveloperToken, resetAppleTokenCache } from "@/modules/providers/apple/apple-token.service";
import { ProviderNotConfiguredError } from "@/modules/providers/errors";

describe("Credential-Free Execution Mode (Integration & Invariant Guard)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    delete process.env.SPOTIFY_REDIRECT_URI;
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_MUSIC_KEY_ID;
    delete process.env.APPLE_MUSIC_PRIVATE_KEY_PATH;
    delete process.env.APPLE_MUSIC_PRIVATE_KEY;
    resetAppleTokenCache();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    resetAppleTokenCache();
  });

  it("reports Spotify as unconfigured without throwing or crashing", () => {
    const status = getSpotifyConfigStatus();
    expect(status.isConfigured).toBe(false);
    expect(status.missingVariables).toContain("SPOTIFY_CLIENT_ID");
    expect(status.missingVariables).toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("fails fast with ProviderNotConfiguredError when Spotify authorization is attempted without credentials", async () => {
    await expect(
      generateSpotifyAuthorizeUrl("test-user-id")
    ).rejects.toThrow(ProviderNotConfiguredError);
  });

  it("reports Apple Music as unconfigured without throwing or crashing", () => {
    const status = getAppleConfigStatus();
    expect(status.isConfigured).toBe(false);
    expect(status.missingVariables).toContain("APPLE_TEAM_ID");
    expect(status.missingVariables).toContain("APPLE_MUSIC_KEY_ID");
    expect(status.missingVariables).toContain("APPLE_MUSIC_PRIVATE_KEY_PATH");
  });

  it("fails fast with ProviderNotConfiguredError when Apple Developer Token is requested without credentials", async () => {
    await expect(getAppleDeveloperToken()).rejects.toThrow(ProviderNotConfiguredError);
  });
});
