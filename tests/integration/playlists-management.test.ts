import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import {
  createPlaylist,
  updatePlaylist,
  archivePlaylist,
  restorePlaylist,
  addPlaylistItem,
  removePlaylistItem,
  reorderPlaylistItems,
  getUserPlaylists,
  getPlaylistById,
  calculatePlaylistSnapshotHash,
} from "@/modules/playlists/playlists.service";
import { ConcurrencyConflictError } from "@/modules/common/errors";

describe("Phase 4 Canonical Playlist Management (Integration)", () => {
  const testUserId = "p4-user-0000-0000-0000-000000000001";
  let track1Id: string;
  let track2Id: string;

  beforeAll(async () => {
    // Create test user and canonical tracks
    await prisma.user.upsert({
      where: { id: testUserId },
      update: {},
      create: {
        id: testUserId,
        email: "p4-playlist-test@sonora.dev",
        displayName: "P4 Tester",
      },
    });

    const t1 = await prisma.track.create({
      data: {
        title: "P4 Song Alpha",
        artistName: "P4 Artist",
        durationMs: 200000,
        isrc: "USP400000001",
      },
    });
    track1Id = t1.id;

    const t2 = await prisma.track.create({
      data: {
        title: "P4 Song Beta",
        artistName: "P4 Artist",
        durationMs: 240000,
        isrc: "USP400000002",
      },
    });
    track2Id = t2.id;
  });

  afterAll(async () => {
    await prisma.playlistItem.deleteMany({
      where: { playlist: { userId: testUserId } },
    });
    await prisma.playlist.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.track.deleteMany({
      where: { id: { in: [track1Id, track2Id] } },
    });
    await prisma.user.deleteMany({
      where: { id: testUserId },
    });
  });

  it("creates a playlist with version 1 and inactive archive state", async () => {
    const pl = await createPlaylist(testUserId, {
      title: "P4 Test Playlist",
      description: "Testing Phase 4 canonical playlist features",
    });

    expect(pl.id).toBeDefined();
    expect(pl.version).toBe(1);
    expect(pl.isArchived).toBe(false);
    expect(pl.archivedAt).toBeNull();
  });

  it("enforces optimistic concurrency version checking on playlist update", async () => {
    const pl = await createPlaylist(testUserId, { title: "Versioned Playlist" });
    expect(pl.version).toBe(1);

    // Stale version update must reject with ConcurrencyConflictError
    await expect(
      updatePlaylist(testUserId, pl.id, { title: "Stale Update" }, 999)
    ).rejects.toThrow(ConcurrencyConflictError);

    // Matching version update succeeds and increments version
    const updated = await updatePlaylist(
      testUserId,
      pl.id,
      { title: "Updated Versioned Playlist" },
      1
    );
    expect(updated.title).toBe("Updated Versioned Playlist");
    expect(updated.version).toBe(2);
  });

  it("archives and restores a playlist, filtering correctly in listings", async () => {
    const pl = await createPlaylist(testUserId, { title: "Archive Me" });

    // Archive
    const archived = await archivePlaylist(testUserId, pl.id, pl.version);
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(pl.version + 1);

    // Default listing excludes archived playlists
    const defaultList = await getUserPlaylists(testUserId, { limit: 50 });
    expect(defaultList.items.some((item) => item.id === pl.id)).toBe(false);

    // Listing with includeArchived: true includes it
    const listWithArchived = await getUserPlaylists(testUserId, {
      limit: 50,
      includeArchived: true,
    });
    expect(listWithArchived.items.some((item) => item.id === pl.id)).toBe(true);

    // Restore
    const restored = await restorePlaylist(testUserId, pl.id, archived.version);
    expect(restored.isArchived).toBe(false);
    expect(restored.archivedAt).toBeNull();
    expect(restored.version).toBe(archived.version + 1);

    // Now present in default listing again
    const restoredList = await getUserPlaylists(testUserId, { limit: 50 });
    expect(restoredList.items.some((item) => item.id === pl.id)).toBe(true);
  });

  it("preserves repeated track occurrences and updates snapshotHash deterministically", async () => {
    const pl = await createPlaylist(testUserId, { title: "Duplicate Occurrence Playlist" });

    // Add track 1 (occurrence 1)
    const item1 = await addPlaylistItem(testUserId, pl.id, { trackId: track1Id }, pl.version);
    expect(item1.position).toBe(0);

    const plAfter1 = await getPlaylistById(testUserId, pl.id);
    expect(plAfter1.snapshotHash).not.toBeNull();
    const hash1 = plAfter1.snapshotHash;

    // Add track 1 AGAIN (occurrence 2) — must be distinct PlaylistItem
    const item2 = await addPlaylistItem(testUserId, pl.id, { trackId: track1Id }, plAfter1.version);
    expect(item2.id).not.toBe(item1.id);
    expect(item2.position).toBe(1);

    const plAfter2 = await getPlaylistById(testUserId, pl.id);
    expect(plAfter2.snapshotHash).not.toBe(hash1); // Hash changed

    // Add track 2 (occurrence 1)
    const item3 = await addPlaylistItem(testUserId, pl.id, { trackId: track2Id }, plAfter2.version);
    expect(item3.position).toBe(2);

    const fullPl = await getPlaylistById(testUserId, pl.id);
    expect(fullPl.items).toHaveLength(3);
    expect(fullPl.items[0].trackId).toBe(track1Id);
    expect(fullPl.items[1].trackId).toBe(track1Id); // Duplicate occurrence preserved!
    expect(fullPl.items[2].trackId).toBe(track2Id);

    // Verify snapshotHash recalculation matches
    const expectedHash = await calculatePlaylistSnapshotHash(pl.id);
    expect(fullPl.snapshotHash).toBe(expectedHash);
  });

  it("resequences positions and updates snapshotHash when removing an occurrence", async () => {
    const pl = await createPlaylist(testUserId, { title: "Remove Item Playlist" });
    const it0 = await addPlaylistItem(testUserId, pl.id, { trackId: track1Id });
    const it1 = await addPlaylistItem(testUserId, pl.id, { trackId: track2Id });
    const it2 = await addPlaylistItem(testUserId, pl.id, { trackId: track1Id });

    // Remove middle item (it1)
    await removePlaylistItem(testUserId, pl.id, it1.id);

    const updatedPl = await getPlaylistById(testUserId, pl.id);
    expect(updatedPl.items).toHaveLength(2);
    expect(updatedPl.items[0].id).toBe(it0.id);
    expect(updatedPl.items[0].position).toBe(0);
    expect(updatedPl.items[1].id).toBe(it2.id);
    expect(updatedPl.items[1].position).toBe(1); // Shifted down from 2 to 1!
  });

  it("atomically reorders items and updates version & snapshotHash", async () => {
    const pl = await createPlaylist(testUserId, { title: "Reorder Playlist" });
    const it0 = await addPlaylistItem(testUserId, pl.id, { trackId: track1Id });
    const it1 = await addPlaylistItem(testUserId, pl.id, { trackId: track2Id });

    const plBefore = await getPlaylistById(testUserId, pl.id);
    const hashBefore = plBefore.snapshotHash;

    // Swap [it1, it0]
    await reorderPlaylistItems(testUserId, pl.id, [it1.id, it0.id], plBefore.version);

    const plAfter = await getPlaylistById(testUserId, pl.id);
    expect(plAfter.items[0].id).toBe(it1.id);
    expect(plAfter.items[0].position).toBe(0);
    expect(plAfter.items[1].id).toBe(it0.id);
    expect(plAfter.items[1].position).toBe(1);
    expect(plAfter.version).toBe(plBefore.version + 1);
    expect(plAfter.snapshotHash).not.toBe(hashBefore);
  });
});
