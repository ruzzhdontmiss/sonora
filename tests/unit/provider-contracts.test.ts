import { describe, it, expect, beforeEach } from "vitest";
import { ProviderType } from "@prisma/client";
import { providerRegistry } from "@/modules/providers/registry";
import { FakeMusicProviderAdapter } from "@/modules/providers/testing/fake-adapter";
import { UnsupportedOperationError } from "@/modules/common/errors";

describe("Phase 2 Provider Adapter Contracts & Capabilities (Unit)", () => {
  let fakeSpotify: FakeMusicProviderAdapter;
  let fakeYouTube: FakeMusicProviderAdapter;

  beforeEach(() => {
    fakeSpotify = new FakeMusicProviderAdapter({
      provider: ProviderType.SPOTIFY,
      capabilities: {
        canReadPlaylists: true,
        canWritePlaylists: true,
        canReadLikedTracks: true,
      },
      cannedPlaylists: [
        {
          externalId: "sp_pl_01",
          title: "My Spotify Mix",
          itemCount: 2,
        },
      ],
    });

    fakeYouTube = new FakeMusicProviderAdapter({
      provider: ProviderType.YOUTUBE_MUSIC,
      capabilities: {
        canReadPlaylists: true,
        canWritePlaylists: false, // Read-only / limited capability
        canReadLikedTracks: false,
      },
    });

    providerRegistry.register(fakeSpotify);
    providerRegistry.register(fakeYouTube);
  });

  it("retrieves registered provider adapters from the registry", () => {
    expect(providerRegistry.has(ProviderType.SPOTIFY)).toBe(true);
    expect(providerRegistry.has(ProviderType.YOUTUBE_MUSIC)).toBe(true);

    const adapter = providerRegistry.get(ProviderType.SPOTIFY);
    expect(adapter.provider).toBe(ProviderType.SPOTIFY);
  });

  it("verifies explicit capability flags for different providers", () => {
    const spotifyCaps = fakeSpotify.getCapabilities();
    const youtubeCaps = fakeYouTube.getCapabilities();

    expect(spotifyCaps.canWritePlaylists).toBe(true);
    expect(youtubeCaps.canWritePlaylists).toBe(false);
  });

  it("asserts capabilities and passes for supported operations", () => {
    const adapter = providerRegistry.assertCapability(
      ProviderType.SPOTIFY,
      "canWritePlaylists"
    );
    expect(adapter).toBeDefined();
  });

  it("asserts capabilities and fails fast with typed UnsupportedOperationError for unsupported operations", () => {
    expect(() => {
      providerRegistry.assertCapability(ProviderType.YOUTUBE_MUSIC, "canWritePlaylists");
    }).toThrow(UnsupportedOperationError);
  });

  it("fails fast when invoking an unsupported method directly on the adapter", async () => {
    await expect(
      fakeYouTube.createPlaylist("dummy_token", { title: "New Playlist" })
    ).rejects.toThrow(UnsupportedOperationError);

    await expect(
      fakeYouTube.getUserLikedTracks("dummy_token")
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it("executes supported read and write operations deterministically with canned data", async () => {
    const playlists = await fakeSpotify.getUserPlaylists("dummy_token");
    expect(playlists.items.length).toBe(1);
    expect(playlists.items[0].title).toBe("My Spotify Mix");

    const created = await fakeSpotify.createPlaylist("dummy_token", {
      title: "Newly Created Playlist",
    });
    expect(created.success).toBe(true);
    expect(created.externalId).toBeDefined();

    const updatedPlaylists = await fakeSpotify.getUserPlaylists("dummy_token");
    expect(updatedPlaylists.items.length).toBe(2);
  });
});

