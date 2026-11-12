/**
 * Synthetic Data Seed Script for SONORA
 * Strictly uses synthetic / demo data only.
 * No real user data or live credentials.
 */

import { PrismaClient, LibrarySourceProvenance } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding synthetic test database...");

  const syntheticUserId = "00000000-0000-0000-0000-000000000001";
  const syntheticLibraryId = "00000000-0000-0000-0000-000000000002";

  // 1. Repeatable upsert for synthetic test user
  const syntheticUser = await prisma.user.upsert({
    where: { email: "synthetic-user@example.com" },
    update: {
      displayName: "Synthetic Demo User",
    },
    create: {
      id: syntheticUserId,
      email: "synthetic-user@example.com",
      displayName: "Synthetic Demo User",
      passwordHash: "synthetic_test_hash_not_a_real_credential",
    },
  });

  // 2. Ensure canonical Library exists
  const library = await prisma.library.upsert({
    where: { userId: syntheticUser.id },
    update: {},
    create: {
      id: syntheticLibraryId,
      userId: syntheticUser.id,
    },
  });

  // 3. Seed canonical synthetic tracks
  const sampleTracks = [
    {
      id: "10000000-0000-0000-0000-000000000001",
      isrc: "US-S1Z-26-00001",
      title: "Synthetic Sunrise",
      artistName: "The Algorithms",
      albumName: "Binary Horizons",
      durationMs: 214000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000002",
      isrc: "US-S1Z-26-00002",
      title: "Deterministic Groove",
      artistName: "Data Stream",
      albumName: "State Machine",
      durationMs: 185000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000003",
      isrc: "US-S1Z-26-00003",
      title: "Outbox Dispatch (Reprise)",
      artistName: "The Algorithms",
      albumName: "Binary Horizons",
      durationMs: 242000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000004",
      isrc: "US-S1Z-26-00004",
      title: "Idempotent Echoes",
      artistName: "Lossless Port",
      albumName: "Universal Sound",
      durationMs: 198000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
  ];

  for (const trackData of sampleTracks) {
    await prisma.track.upsert({
      where: { id: trackData.id },
      update: trackData,
      create: trackData,
    });
  }

  // 4. Seed user canonical saved tracks (LibraryTrack)
  for (const track of sampleTracks.slice(0, 3)) {
    await prisma.libraryTrack.upsert({
      where: {
        libraryId_trackId: {
          libraryId: library.id,
          trackId: track.id,
        },
      },
      update: {},
      create: {
        libraryId: library.id,
        trackId: track.id,
        sourceProvenance: LibrarySourceProvenance.MANUAL,
        userNotes: "Synthetic demo saved track",
      },
    });
  }

  // 5. Seed sample canonical playlist with preserved order and repeated track
  const playlistId = "20000000-0000-0000-0000-000000000001";
  const playlist = await prisma.playlist.upsert({
    where: { id: playlistId },
    update: {
      userId: syntheticUser.id,
      title: "Synthetic Morning Mix",
      description: "Demonstrating canonical ordering and duplicate track occurrence preservation.",
    },
    create: {
      id: playlistId,
      userId: syntheticUser.id,
      libraryId: library.id,
      title: "Synthetic Morning Mix",
      description: "Demonstrating canonical ordering and duplicate track occurrence preservation.",
    },
  });

  // Clear existing items for clean repeatable seed of ordered items
  await prisma.playlistItem.deleteMany({
    where: { playlistId: playlist.id },
  });

  // Track 1 appears at position 0 AND position 3 (verifying duplicate occurrence invariant)
  const playlistItemsData = [
    {
      id: "30000000-0000-0000-0000-000000000001",
      playlistId: playlist.id,
      trackId: sampleTracks[0].id,
      position: 0,
      notes: "First occurrence of Synthetic Sunrise",
    },
    {
      id: "30000000-0000-0000-0000-000000000002",
      playlistId: playlist.id,
      trackId: sampleTracks[1].id,
      position: 1,
      notes: "Deterministic Groove",
    },
    {
      id: "30000000-0000-0000-0000-000000000003",
      playlistId: playlist.id,
      trackId: sampleTracks[2].id,
      position: 2,
      notes: "Outbox Dispatch (Reprise)",
    },
    {
      id: "30000000-0000-0000-0000-000000000004",
      playlistId: playlist.id,
      trackId: sampleTracks[0].id, // Same track as position 0!
      position: 3,
      notes: "Second occurrence of Synthetic Sunrise (Encore)",
    },
  ];

  for (const item of playlistItemsData) {
    await prisma.playlistItem.create({
      data: item,
    });
  }

  console.log(`✅ Seeded synthetic user: ${syntheticUser.email} (${syntheticUser.id})`);
  console.log(`✅ Seeded canonical library (${library.id}) with ${sampleTracks.length} tracks`);
  console.log(`✅ Seeded playlist "${playlist.title}" with 4 ordered items (including duplicate track occurrence)`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
