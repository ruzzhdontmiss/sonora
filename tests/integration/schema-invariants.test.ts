import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, ProviderType, ProviderItemType, LibrarySourceProvenance } from "@prisma/client";

const prisma = new PrismaClient();

describe("Phase 2 Schema Invariants & Constraints (Integration)", () => {
  const testUserAId = "99000000-0000-0000-0000-000000000001";
  const testUserBId = "99000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    // Clean up test data if present
    await prisma.user.deleteMany({
      where: { id: { in: [testUserAId, testUserBId] } },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { id: { in: [testUserAId, testUserBId] } },
    });
    await prisma.$disconnect();
  });

  it("enforces unique constraint on User and creates sovereign Library", async () => {
    const userA = await prisma.user.create({
      data: {
        id: testUserAId,
        email: "schema-test-a@example.com",
        displayName: "User A",
        library: {
          create: {},
        },
      },
      include: { library: true },
    });

    expect(userA.library).toBeDefined();
    expect(userA.library?.userId).toBe(userA.id);

    // Re-creating the same email should fail unique constraint
    await expect(
      prisma.user.create({
        data: {
          email: "schema-test-a@example.com",
        },
      })
    ).rejects.toThrow();
  });

  it("preserves playlist item order and allows repeated track occurrences at different positions", async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: testUserAId },
      include: { library: true },
    });

    // Create a canonical track
    const track = await prisma.track.create({
      data: {
        title: "Invariant Groove",
        artistName: "Test Artist",
        durationMs: 200000,
      },
    });

    // Create a playlist
    const playlist = await prisma.playlist.create({
      data: {
        userId: user.id,
        libraryId: user.library!.id,
        title: "Test Invariant Playlist",
      },
    });

    // Add track at position 0
    const item1 = await prisma.playlistItem.create({
      data: {
        playlistId: playlist.id,
        trackId: track.id,
        position: 0,
      },
    });

    // Add THE SAME track at position 1 (verifying repeated occurrence invariant)
    const item2 = await prisma.playlistItem.create({
      data: {
        playlistId: playlist.id,
        trackId: track.id,
        position: 1,
      },
    });

    expect(item1.trackId).toBe(item2.trackId);
    expect(item1.position).toBe(0);
    expect(item2.position).toBe(1);
    expect(item1.id).not.toBe(item2.id);

    // Attempting to insert at an existing position (position 0) must violate unique constraint
    await expect(
      prisma.playlistItem.create({
        data: {
          playlistId: playlist.id,
          trackId: track.id,
          position: 0, // Conflict!
        },
      })
    ).rejects.toThrow();

    // Clean up
    await prisma.playlist.delete({ where: { id: playlist.id } });
    await prisma.track.delete({ where: { id: track.id } });
  });

  it("enforces uniqueness on ProviderTrack (provider + externalId)", async () => {
    const externalId = "spotify_ext_track_12345";

    const pTrack = await prisma.providerTrack.create({
      data: {
        provider: ProviderType.SPOTIFY,
        externalId,
        title: "External Spotify Track",
        artistName: "External Artist",
        durationMs: 210000,
      },
    });

    expect(pTrack.externalId).toBe(externalId);

    // Duplicate (provider, externalId) must fail
    await expect(
      prisma.providerTrack.create({
        data: {
          provider: ProviderType.SPOTIFY,
          externalId,
          title: "Another Spotify Track with same ID",
          artistName: "Another Artist",
          durationMs: 210000,
        },
      })
    ).rejects.toThrow();

    // Clean up
    await prisma.providerTrack.delete({ where: { id: pTrack.id } });
  });

  it("enforces uniqueness on ProviderLibraryItem (providerAccountId + itemType + externalId)", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        userId: testUserAId,
        provider: ProviderType.SPOTIFY,
        providerUserId: "spotify_user_999",
        displayName: "Spotify User",
        encryptedAccessToken: "enc_token_placeholder",
      },
    });

    const item = await prisma.providerLibraryItem.create({
      data: {
        providerAccountId: account.id,
        itemType: ProviderItemType.TRACK,
        externalId: "ext_item_999",
      },
    });

    expect(item.externalId).toBe("ext_item_999");

    // Duplicate provider library item must fail
    await expect(
      prisma.providerLibraryItem.create({
        data: {
          providerAccountId: account.id,
          itemType: ProviderItemType.TRACK,
          externalId: "ext_item_999",
        },
      })
    ).rejects.toThrow();

    // Clean up
    await prisma.providerAccount.delete({ where: { id: account.id } });
  });

  describe("Cross-User Composite Foreign Key Invariants (Database Enforcement)", () => {
    it("strictly prevents creating a Playlist linked to another user's Library at the database engine level", async () => {
      // Create User B
      const userB = await prisma.user.create({
        data: {
          id: testUserBId,
          email: "schema-test-b@example.com",
          displayName: "User B",
          library: { create: {} },
        },
        include: { library: true },
      });

      // User A attempts to create a playlist referencing User B's libraryId
      // PostgreSQL composite foreign key `FOREIGN KEY (libraryId, userId) REFERENCES libraries(id, userId)` must reject this!
      await expect(
        prisma.playlist.create({
          data: {
            title: "Cross Tenant Attack Playlist",
            userId: testUserAId,
            libraryId: userB.library!.id, // Foreign library!
          },
        })
      ).rejects.toThrow();
    });

    it("strictly prevents linking a ProviderPlaylist between User A's playlist and User B's provider account", async () => {
      const userA = await prisma.user.findUniqueOrThrow({
        where: { id: testUserAId },
        include: { library: true },
      });

      // User A's playlist
      const playlistA = await prisma.playlist.create({
        data: {
          title: "User A Sovereign Playlist",
          userId: testUserAId,
          libraryId: userA.library!.id,
        },
      });

      // User B's provider account
      const accountB = await prisma.providerAccount.create({
        data: {
          userId: testUserBId,
          provider: ProviderType.SPOTIFY,
          providerUserId: "spotify_user_b",
          displayName: "Spotify User B",
          encryptedAccessToken: "enc_token_b",
        },
      });

      // Attempt 1: user_id = User A (violates accountB foreign key constraint)
      await expect(
        prisma.providerPlaylist.create({
          data: {
            userId: testUserAId,
            playlistId: playlistA.id,
            providerAccountId: accountB.id,
            externalId: "ext_pl_attack_1",
          },
        })
      ).rejects.toThrow();

      // Attempt 2: user_id = User B (violates playlistA foreign key constraint)
      await expect(
        prisma.providerPlaylist.create({
          data: {
            userId: testUserBId,
            playlistId: playlistA.id,
            providerAccountId: accountB.id,
            externalId: "ext_pl_attack_2",
          },
        })
      ).rejects.toThrow();

      // Clean up
      await prisma.playlist.delete({ where: { id: playlistA.id } });
      await prisma.providerAccount.delete({ where: { id: accountB.id } });
    });
  });
});


