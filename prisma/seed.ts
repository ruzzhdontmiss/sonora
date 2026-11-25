/**
 * Synthetic Data Seed Script for SONORA
 * Strictly uses synthetic / demo data only.
 * No real user data or live credentials.
 */

import {
  PrismaClient,
  LibrarySourceProvenance,
  ProviderType,
  MatchMethod,
  TrackMatchReviewStatus,
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding realistic synthetic demo database for SONORA...");

  const syntheticUserId = "00000000-0000-0000-0000-000000000001";
  const syntheticLibraryId = "00000000-0000-0000-0000-000000000002";

  // 1. Repeatable upsert for synthetic demo user
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

  // 3. 24 Canonical synthetic demo tracks across 6 artists and 6 albums
  const demoTracks = [
    // The Algorithms — Binary Horizons
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
      title: "Outbox Dispatch (Reprise)",
      artistName: "The Algorithms",
      albumName: "Binary Horizons",
      durationMs: 242000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000003",
      isrc: "US-S1Z-26-00003",
      title: "Recursive Rhythms",
      artistName: "The Algorithms",
      albumName: "Binary Horizons",
      durationMs: 195000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000004",
      isrc: "US-S1Z-26-00004",
      title: "Fencing Token Anthem",
      artistName: "The Algorithms",
      albumName: "Binary Horizons",
      durationMs: 230000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },

    // Data Stream — State Machine
    {
      id: "10000000-0000-0000-0000-000000000005",
      isrc: "US-S1Z-26-00005",
      title: "Deterministic Groove",
      artistName: "Data Stream",
      albumName: "State Machine",
      durationMs: 185000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000006",
      isrc: "US-S1Z-26-00006",
      title: "Stream Buffer",
      artistName: "Data Stream",
      albumName: "State Machine",
      durationMs: 210000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000007",
      isrc: "US-S1Z-26-00007",
      title: "Throughput Echo",
      artistName: "Data Stream",
      albumName: "State Machine",
      durationMs: 228000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000008",
      isrc: "US-S1Z-26-00008",
      title: "Backoff with Jitter",
      artistName: "Data Stream",
      albumName: "State Machine",
      durationMs: 198000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },

    // Lossless Port — Universal Sound
    {
      id: "10000000-0000-0000-0000-000000000009",
      isrc: "US-S1Z-26-00009",
      title: "Idempotent Echoes",
      artistName: "Lossless Port",
      albumName: "Universal Sound",
      durationMs: 204000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000010",
      isrc: "US-S1Z-26-00010",
      title: "Audio Payload",
      artistName: "Lossless Port",
      albumName: "Universal Sound",
      durationMs: 215000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000011",
      isrc: "US-S1Z-26-00011",
      title: "Codec Dreams",
      artistName: "Lossless Port",
      albumName: "Universal Sound",
      durationMs: 176000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000012",
      isrc: "US-S1Z-26-00012",
      title: "Bitrate Horizon",
      artistName: "Lossless Port",
      albumName: "Universal Sound",
      durationMs: 250000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },

    // Binary Echoes — Latency Dreams
    {
      id: "10000000-0000-0000-0000-000000000013",
      isrc: "US-S1Z-26-00013",
      title: "Latency Dreams",
      artistName: "Binary Echoes",
      albumName: "Latency Dreams",
      durationMs: 190000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000014",
      isrc: "US-S1Z-26-00014",
      title: "Ping Interval",
      artistName: "Binary Echoes",
      albumName: "Latency Dreams",
      durationMs: 220000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000015",
      isrc: "US-S1Z-26-00015",
      title: "TTL Sunset",
      artistName: "Binary Echoes",
      albumName: "Latency Dreams",
      durationMs: 205000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000016",
      isrc: "US-S1Z-26-00016",
      title: "Heartbeat Loop",
      artistName: "Binary Echoes",
      albumName: "Latency Dreams",
      durationMs: 212000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },

    // Neural Canvas — Gradient Descents
    {
      id: "10000000-0000-0000-0000-000000000017",
      isrc: "US-S1Z-26-00017",
      title: "Gradient Descents",
      artistName: "Neural Canvas",
      albumName: "Gradient Descents",
      durationMs: 240000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000018",
      isrc: "US-S1Z-26-00018",
      title: "Embedding Space",
      artistName: "Neural Canvas",
      albumName: "Gradient Descents",
      durationMs: 201000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000019",
      isrc: "US-S1Z-26-00019",
      title: "Attention Wave",
      artistName: "Neural Canvas",
      albumName: "Gradient Descents",
      durationMs: 188000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000020",
      isrc: "US-S1Z-26-00020",
      title: "Loss Function Solace",
      artistName: "Neural Canvas",
      albumName: "Gradient Descents",
      durationMs: 225000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },

    // Vector Shift — Zero Matrix
    {
      id: "10000000-0000-0000-0000-000000000021",
      isrc: "US-S1Z-26-00021",
      title: "Zero Matrix",
      artistName: "Vector Shift",
      albumName: "Zero Matrix",
      durationMs: 218000,
      explicit: false,
      discNumber: 1,
      trackNumber: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000022",
      isrc: "US-S1Z-26-00022",
      title: "Cosine Distance",
      artistName: "Vector Shift",
      albumName: "Zero Matrix",
      durationMs: 207000,
      explicit: false,
      discNumber: 1,
      trackNumber: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000023",
      isrc: "US-S1Z-26-00023",
      title: "Dimension Fall",
      artistName: "Vector Shift",
      albumName: "Zero Matrix",
      durationMs: 195000,
      explicit: false,
      discNumber: 1,
      trackNumber: 3,
    },
    {
      id: "10000000-0000-0000-0000-000000000024",
      isrc: "US-S1Z-26-00024",
      title: "Cluster Point",
      artistName: "Vector Shift",
      albumName: "Zero Matrix",
      durationMs: 232000,
      explicit: false,
      discNumber: 1,
      trackNumber: 4,
    },
  ];

  for (const trackData of demoTracks) {
    await prisma.track.upsert({
      where: { id: trackData.id },
      update: trackData,
      create: trackData,
    });
  }

  // 4. Seed user canonical saved tracks (all 24 in LibraryTrack)
  for (const track of demoTracks) {
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
        userNotes: "Synthetic demo saved library track",
      },
    });
  }

  // 5. Seed Playlist 1: "Synthetic Morning Mix" (preserves duplicate track occurrences)
  const playlist1Id = "20000000-0000-0000-0000-000000000001";
  const playlist1 = await prisma.playlist.upsert({
    where: { id: playlist1Id },
    update: {
      userId: syntheticUser.id,
      title: "Synthetic Morning Mix",
      description: "Demonstrating canonical ordering and duplicate track occurrence preservation.",
    },
    create: {
      id: playlist1Id,
      userId: syntheticUser.id,
      libraryId: library.id,
      title: "Synthetic Morning Mix",
      description: "Demonstrating canonical ordering and duplicate track occurrence preservation.",
    },
  });

  await prisma.playlistItem.deleteMany({ where: { playlistId: playlist1.id } });

  // Track 1 appears at pos 0 AND pos 3; Track 5 appears at pos 1 AND pos 5 (duplicate preservation)
  const playlist1Items = [
    {
      id: "30000000-0000-0000-0000-000000000001",
      playlistId: playlist1.id,
      trackId: demoTracks[0].id, // Synthetic Sunrise
      position: 0,
      notes: "First occurrence of Synthetic Sunrise",
    },
    {
      id: "30000000-0000-0000-0000-000000000002",
      playlistId: playlist1.id,
      trackId: demoTracks[4].id, // Deterministic Groove
      position: 1,
      notes: "First occurrence of Deterministic Groove",
    },
    {
      id: "30000000-0000-0000-0000-000000000003",
      playlistId: playlist1.id,
      trackId: demoTracks[1].id, // Outbox Dispatch
      position: 2,
      notes: "Outbox Dispatch (Reprise)",
    },
    {
      id: "30000000-0000-0000-0000-000000000004",
      playlistId: playlist1.id,
      trackId: demoTracks[0].id, // Duplicate occurrence of Synthetic Sunrise!
      position: 3,
      notes: "Second occurrence of Synthetic Sunrise (Encore)",
    },
    {
      id: "30000000-0000-0000-0000-000000000005",
      playlistId: playlist1.id,
      trackId: demoTracks[8].id, // Idempotent Echoes
      position: 4,
      notes: "Idempotent Echoes",
    },
    {
      id: "30000000-0000-0000-0000-000000000006",
      playlistId: playlist1.id,
      trackId: demoTracks[4].id, // Duplicate occurrence of Deterministic Groove!
      position: 5,
      notes: "Second occurrence of Deterministic Groove",
    },
  ];

  for (const item of playlist1Items) {
    await prisma.playlistItem.create({ data: item });
  }

  // 6. Seed Playlist 2: "Deep Focus Synthwave"
  const playlist2Id = "20000000-0000-0000-0000-000000000002";
  const playlist2 = await prisma.playlist.upsert({
    where: { id: playlist2Id },
    update: {
      userId: syntheticUser.id,
      title: "Deep Focus Synthwave",
      description: "Atmospheric electronic and synthwave tracks for coding and deep work.",
    },
    create: {
      id: playlist2Id,
      userId: syntheticUser.id,
      libraryId: library.id,
      title: "Deep Focus Synthwave",
      description: "Atmospheric electronic and synthwave tracks for coding and deep work.",
    },
  });

  await prisma.playlistItem.deleteMany({ where: { playlistId: playlist2.id } });

  const playlist2Items = [
    demoTracks[12], // Latency Dreams
    demoTracks[13], // Ping Interval
    demoTracks[16], // Gradient Descents
    demoTracks[17], // Embedding Space
    demoTracks[20], // Zero Matrix
    demoTracks[21], // Cosine Distance
  ];

  for (let i = 0; i < playlist2Items.length; i++) {
    await prisma.playlistItem.create({
      data: {
        id: `30000000-0000-0000-0000-00000000010${i + 1}`,
        playlistId: playlist2.id,
        trackId: playlist2Items[i].id,
        position: i,
        notes: `Focus track ${i + 1}`,
      },
    });
  }

  // 7. Seed Playlist 3: "Chill Electronica"
  const playlist3Id = "20000000-0000-0000-0000-000000000003";
  const playlist3 = await prisma.playlist.upsert({
    where: { id: playlist3Id },
    update: {
      userId: syntheticUser.id,
      title: "Chill Electronica",
      description: "Down-tempo algorithmic beats.",
    },
    create: {
      id: playlist3Id,
      userId: syntheticUser.id,
      libraryId: library.id,
      title: "Chill Electronica",
      description: "Down-tempo algorithmic beats.",
    },
  });

  await prisma.playlistItem.deleteMany({ where: { playlistId: playlist3.id } });

  const playlist3Items = [demoTracks[2], demoTracks[6], demoTracks[10], demoTracks[18]];
  for (let i = 0; i < playlist3Items.length; i++) {
    await prisma.playlistItem.create({
      data: {
        id: `30000000-0000-0000-0000-00000000020${i + 1}`,
        playlistId: playlist3.id,
        trackId: playlist3Items[i].id,
        position: i,
      },
    });
  }

  // 8. Seed ambiguous matches needing review for /dashboard/matching
  // ProviderTrack 1: TTL Sunset (Remix) on Spotify -> conflicts with canonical TTL Sunset
  const provTrack1 = await prisma.providerTrack.upsert({
    where: {
      provider_externalId: {
        provider: ProviderType.SPOTIFY,
        externalId: "spotify:track:demo_remix_001",
      },
    },
    update: {},
    create: {
      id: "40000000-0000-0000-0000-000000000001",
      provider: ProviderType.SPOTIFY,
      externalId: "spotify:track:demo_remix_001",
      title: "TTL Sunset (Club Remix)",
      artistName: "Binary Echoes feat. DJ Resync",
      albumName: "Latency Dreams (Remixes)",
      durationMs: 275000,
      isrc: "US-S1Z-26-90001",
      providerUri: "spotify:track:demo_remix_001",
    },
  });

  await prisma.trackMatch.upsert({
    where: {
      canonicalTrackId_providerTrackId: {
        canonicalTrackId: demoTracks[14].id, // TTL Sunset
        providerTrackId: provTrack1.id,
      },
    },
    update: {},
    create: {
      id: "50000000-0000-0000-0000-000000000001",
      canonicalTrackId: demoTracks[14].id,
      providerTrackId: provTrack1.id,
      matchConfidence: 0.65,
      matchMethod: MatchMethod.METADATA_FUZZY,
      reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
      conflictReason: "Candidate is a remix version but canonical track is original studio recording",
      evidence: {
        breakdown: {
          isrcMatch: false,
          titleSimilarity: 0.72,
          artistOverlap: 0.85,
          durationDiffMs: 70000,
        },
      },
    },
  });

  // ProviderTrack 2: Attention Wave (Live Session) on Apple Music -> duration mismatch
  const provTrack2 = await prisma.providerTrack.upsert({
    where: {
      provider_externalId: {
        provider: ProviderType.APPLE_MUSIC,
        externalId: "apple:track:demo_live_002",
      },
    },
    update: {},
    create: {
      id: "40000000-0000-0000-0000-000000000002",
      provider: ProviderType.APPLE_MUSIC,
      externalId: "apple:track:demo_live_002",
      title: "Attention Wave [Live at Neural Hall]",
      artistName: "Neural Canvas",
      albumName: "Gradient Descents (Live)",
      durationMs: 235000,
      isrc: "US-S1Z-26-90002",
      providerUri: "apple:track:demo_live_002",
    },
  });

  await prisma.trackMatch.upsert({
    where: {
      canonicalTrackId_providerTrackId: {
        canonicalTrackId: demoTracks[18].id, // Attention Wave
        providerTrackId: provTrack2.id,
      },
    },
    update: {},
    create: {
      id: "50000000-0000-0000-0000-000000000002",
      canonicalTrackId: demoTracks[18].id,
      providerTrackId: provTrack2.id,
      matchConfidence: 0.7,
      matchMethod: MatchMethod.METADATA_FUZZY,
      reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
      conflictReason: "Duration difference of 47s; candidate is a live concert recording",
      evidence: {
        breakdown: {
          isrcMatch: false,
          titleSimilarity: 0.82,
          artistOverlap: 1.0,
          durationDiffMs: 47000,
        },
      },
    },
  });

  // ProviderTrack 3: Dimension Fall (Radio Edit) on Spotify -> duration delta
  const provTrack3 = await prisma.providerTrack.upsert({
    where: {
      provider_externalId: {
        provider: ProviderType.SPOTIFY,
        externalId: "spotify:track:demo_edit_003",
      },
    },
    update: {},
    create: {
      id: "40000000-0000-0000-0000-000000000003",
      provider: ProviderType.SPOTIFY,
      externalId: "spotify:track:demo_edit_003",
      title: "Dimension Fall - Radio Edit",
      artistName: "Vector Shift",
      albumName: "Zero Matrix (Single)",
      durationMs: 182000,
      isrc: "US-S1Z-26-90003",
      providerUri: "spotify:track:demo_edit_003",
    },
  });

  await prisma.trackMatch.upsert({
    where: {
      canonicalTrackId_providerTrackId: {
        canonicalTrackId: demoTracks[22].id, // Dimension Fall
        providerTrackId: provTrack3.id,
      },
    },
    update: {},
    create: {
      id: "50000000-0000-0000-0000-000000000003",
      canonicalTrackId: demoTracks[22].id,
      providerTrackId: provTrack3.id,
      matchConfidence: 0.78,
      matchMethod: MatchMethod.METADATA_FUZZY,
      reviewStatus: TrackMatchReviewStatus.NEEDS_REVIEW,
      conflictReason: "Radio edit variant with 13-second duration difference",
      evidence: {
        breakdown: {
          isrcMatch: false,
          titleSimilarity: 0.88,
          artistOverlap: 1.0,
          durationDiffMs: 13000,
        },
      },
    },
  });

  console.log(`✅ Seeded synthetic user: ${syntheticUser.email} (${syntheticUser.id})`);
  console.log(`✅ Seeded canonical library (${library.id}) with ${demoTracks.length} canonical tracks`);
  console.log(`✅ Seeded 3 playlists:`);
  console.log(`   1. "${playlist1.title}" (6 items, preserving duplicate track occurrences)`);
  console.log(`   2. "${playlist2.title}" (6 items)`);
  console.log(`   3. "${playlist3.title}" (4 items)`);
  console.log(`✅ Seeded 3 ambiguous track matches for manual review in /dashboard/matching`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
