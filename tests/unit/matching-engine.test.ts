import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  calculateLevenshteinDistance,
  calculateStringSimilarity,
  calculateArtistOverlap,
  scoreCandidate,
  evaluateCandidates,
  searchSpotifyCatalog,
  searchAppleMusicCatalog,
  retrieveAndMatchCandidates,
  CandidateTrack,
} from "@/modules/matching/matching-engine";
import { normalizeTrackMetadata } from "@/modules/matching/metadata-normalizer";
import { MatchMethod, ProviderType, TrackMatchReviewStatus } from "@prisma/client";

describe("Deterministic Matching Engine (P4-T02)", () => {
  describe("String & Artist Similarity", () => {
    it("computes accurate Levenshtein distance", () => {
      expect(calculateLevenshteinDistance("kitten", "sitting")).toBe(3);
      expect(calculateLevenshteinDistance("hello", "hello")).toBe(0);
      expect(calculateLevenshteinDistance("", "abc")).toBe(3);
    });

    it("evaluates string similarity between titles correctly", () => {
      // Identical strings
      expect(calculateStringSimilarity("Bohemian Rhapsody", "Bohemian Rhapsody")).toBe(1.0);

      // Minor punctuation / case differences
      const sim = calculateStringSimilarity(
        "Don't Stop Believin'",
        "Dont Stop Believin"
      );
      expect(sim).toBeGreaterThan(0.90);

      // Completely unrelated titles
      expect(calculateStringSimilarity("Hotel California", "Bad Romance")).toBeLessThan(0.20);
    });

    it("evaluates artist overlap recognizing featured artists and primary artists", () => {
      const src = normalizeTrackMetadata({
        title: "Levitating (feat. DaBaby)",
        artistName: "Dua Lipa",
        durationMs: 203000,
      });
      const cand = normalizeTrackMetadata({
        title: "Levitating",
        artistName: "Dua Lipa, DaBaby",
        durationMs: 203000,
      });

      const overlap = calculateArtistOverlap(src, cand);
      expect(overlap).toBeGreaterThanOrEqual(0.90);
    });
  });

  describe("Candidate Scoring & Version Isolation", () => {
    const baseSource = {
      title: "Hotel California",
      artistName: "Eagles",
      albumName: "Hotel California",
      durationMs: 391000,
      isrc: "USEE10001234",
      explicit: false,
    };

    it("awards EXACT status for matching ISRC, title, artist, and duration", () => {
      const candidate: CandidateTrack = {
        id: "spotify-1",
        provider: ProviderType.SPOTIFY,
        title: "Hotel California",
        artistName: "Eagles",
        albumName: "Hotel California",
        durationMs: 391500, // 500ms diff
        isrc: "USEE10001234", // ISRC match!
        explicit: false,
      };

      const breakdown = scoreCandidate(baseSource, candidate);
      expect(breakdown.isrcMatch).toBe(true);
      expect(breakdown.isrcScore).toBe(0.60);
      expect(breakdown.durationScore).toBe(0.10); // <=3s
      expect(breakdown.versionScore).toBe(0.05); // both original
      expect(breakdown.finalScore).toBeGreaterThanOrEqual(0.95);
    });

    it("isolates Remaster from Original with version mismatch penalty", () => {
      const remasterCandidate: CandidateTrack = {
        id: "spotify-remaster",
        provider: ProviderType.SPOTIFY,
        title: "Hotel California - 2013 Remaster",
        artistName: "Eagles",
        albumName: "Hotel California (Remastered)",
        durationMs: 391500,
        isrc: "USEE10001234",
        explicit: false,
      };

      const breakdown = scoreCandidate(baseSource, remasterCandidate);
      expect(breakdown.sourceRecordingType).toBe("ORIGINAL");
      expect(breakdown.candidateRecordingType).toBe("REMASTER");
      expect(breakdown.versionScore).toBe(-0.40);
    });

    it("scores non-ISRC candidate accurately without ISRC boost", () => {
      const candidate: CandidateTrack = {
        id: "apple-1",
        provider: ProviderType.APPLE_MUSIC,
        title: "Hotel California",
        artistName: "Eagles",
        albumName: "Hotel California",
        durationMs: 391200,
        isrc: null, // No ISRC
        explicit: false,
      };

      const breakdown = scoreCandidate(baseSource, candidate);
      expect(breakdown.isrcMatch).toBe(false);
      expect(breakdown.isrcScore).toBe(0.0);
      expect(breakdown.titleScore).toBeCloseTo(0.25, 1);
      expect(breakdown.artistScore).toBeCloseTo(0.20, 1);
      expect(breakdown.durationScore).toBe(0.10);
      expect(breakdown.albumScore).toBe(0.05);
      expect(breakdown.finalScore).toBeGreaterThanOrEqual(0.60);
    });

    it("applies penalty for large duration variance (> 30s)", () => {
      const candidate: CandidateTrack = {
        id: "cand-short",
        provider: ProviderType.SPOTIFY,
        title: "Hotel California",
        artistName: "Eagles",
        durationMs: 180000, // 3 minutes vs 6.5 minutes (> 30s difference)
        isrc: null,
      };

      const breakdown = scoreCandidate(baseSource, candidate);
      expect(breakdown.durationScore).toBe(-0.30);
    });

    it("strictly isolates Live versions from Studio originals with heavy penalty", () => {
      const liveCandidate: CandidateTrack = {
        id: "live-1",
        provider: ProviderType.SPOTIFY,
        title: "Hotel California (Live at The Forum, 1976)",
        artistName: "Eagles",
        durationMs: 420000,
        isrc: null,
        explicit: false,
      };

      const breakdown = scoreCandidate(baseSource, liveCandidate);
      expect(breakdown.sourceRecordingType).toBe("ORIGINAL");
      expect(breakdown.candidateRecordingType).toBe("LIVE");
      expect(breakdown.versionScore).toBe(-0.40);
      expect(breakdown.finalScore).toBeLessThan(0.50);
    });

    it("penalizes explicit vs clean mismatches", () => {
      const explicitSource = {
        ...baseSource,
        title: "In Da Club",
        artistName: "50 Cent",
        explicit: true,
      };

      const cleanCandidate: CandidateTrack = {
        id: "clean-1",
        provider: ProviderType.SPOTIFY,
        title: "In Da Club (Clean Version)",
        artistName: "50 Cent",
        durationMs: 193000,
        explicit: false, // Mismatch!
      };

      const breakdown = scoreCandidate(explicitSource, cleanCandidate);
      expect(breakdown.explicitMismatch).toBe(true);
      expect(breakdown.explicitPenalty).toBe(0.15);
    });
  });

  describe("Ambiguity, Conflict Detection & Auto-Match Gate", () => {
    it("flags ambiguity when top 2 candidates have score difference < 0.08", () => {
      const source = {
        title: "Stayin' Alive",
        artistName: "Bee Gees",
        durationMs: 285000,
        explicit: false,
      };

      const candidates: CandidateTrack[] = [
        {
          id: "cand-1",
          provider: ProviderType.SPOTIFY,
          title: "Stayin' Alive",
          artistName: "Bee Gees",
          albumName: "Saturday Night Fever (The Original Movie Sound Track)",
          durationMs: 285000,
        },
        {
          id: "cand-2",
          provider: ProviderType.SPOTIFY,
          title: "Stayin' Alive",
          artistName: "Bee Gees",
          albumName: "The Ultimate Bee Gees",
          durationMs: 285500,
        },
      ];

      const result = evaluateCandidates(source, candidates);
      expect(result.isAmbiguous).toBe(true);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(result.evidence?.isAmbiguous).toBe(true);
      expect(result.evidence?.scoreDifferenceWithNext).toBeLessThan(0.08);
    });

    it("detects conflicting ISRC assignments where ISRC matches but metadata contradicts", () => {
      const source = {
        title: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 354000,
        isrc: "GBUM71029604",
      };

      const conflictingCandidate: CandidateTrack = {
        id: "fake-isrc-track",
        provider: ProviderType.SPOTIFY,
        title: "A completely unrelated polka track",
        artistName: "Accordion Ensemble",
        durationMs: 150000,
        isrc: "GBUM71029604", // Same ISRC!
      };

      const result = evaluateCandidates(source, [conflictingCandidate]);
      expect(result.isConflict).toBe(true);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(result.conflictReason).toContain("Conflicting ISRC");
      expect(result.evidence?.isConflict).toBe(true);
    });

    it("flags conflicting ISRC when duration difference exceeds 20 seconds despite title/artist match", () => {
      const source = {
        title: "Stairway to Heaven",
        artistName: "Led Zeppelin",
        durationMs: 482000, // 8:02
        isrc: "USAT20000123",
      };

      const alteredDurationCandidate: CandidateTrack = {
        id: "short-edit-cand",
        provider: ProviderType.SPOTIFY,
        title: "Stairway to Heaven",
        artistName: "Led Zeppelin",
        durationMs: 450000, // 32s difference (> 20s)
        isrc: "USAT20000123",
      };

      const result = evaluateCandidates(source, [alteredDurationCandidate]);
      expect(result.isConflict).toBe(true);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(result.conflictReason).toContain("Conflicting ISRC");
      expect(result.method).not.toBe(MatchMethod.EXACT_ISRC);
    });

    it("flags version conflict when source is ORIGINAL and candidate is LIVE or REMIX", () => {
      const source = {
        title: "Comfortably Numb",
        artistName: "Pink Floyd",
        durationMs: 382000,
        isrc: "GBUM70000123",
      };

      const liveCandidate: CandidateTrack = {
        id: "pf-live",
        provider: ProviderType.SPOTIFY,
        title: "Comfortably Numb (Live at Pompeii)",
        artistName: "Pink Floyd",
        durationMs: 385000,
      };

      const result = evaluateCandidates(source, [liveCandidate]);
      expect(result.isConflict).toBe(true);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(result.conflictReason).toContain("Version conflict: source track is ORIGINAL while candidate is LIVE");
    });

    it("flags version conflict when source is LIVE and candidate is ORIGINAL", () => {
      const liveSource = {
        title: "Free Bird (Live at Fox Theatre, 1976)",
        artistName: "Lynyrd Skynyrd",
        durationMs: 840000,
      };

      const studioCandidate: CandidateTrack = {
        id: "skynyrd-studio",
        provider: ProviderType.SPOTIFY,
        title: "Free Bird",
        artistName: "Lynyrd Skynyrd",
        durationMs: 548000,
      };

      const result = evaluateCandidates(liveSource, [studioCandidate]);
      expect(result.isConflict).toBe(true);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.NEEDS_REVIEW);
      expect(result.conflictReason).toContain("Version conflict: source track is LIVE while candidate is ORIGINAL");
    });

    it("auto-matches high confidence candidates with score >= 0.85 without ambiguity or conflict", () => {
      const source = {
        title: "Billie Jean",
        artistName: "Michael Jackson",
        albumName: "Thriller",
        durationMs: 294000,
        isrc: "USSM18200407",
        explicit: false,
      };

      const clearWinner: CandidateTrack = {
        id: "mj-1",
        provider: ProviderType.SPOTIFY,
        title: "Billie Jean",
        artistName: "Michael Jackson",
        albumName: "Thriller",
        durationMs: 294000,
        isrc: "USSM18200407",
        explicit: false,
      };

      const distantDistractor: CandidateTrack = {
        id: "cover-1",
        provider: ProviderType.SPOTIFY,
        title: "Billie Jean (Acoustic Tribute)",
        artistName: "Various Artists",
        durationMs: 240000,
        isrc: null,
      };

      const result = evaluateCandidates(source, [clearWinner, distantDistractor]);
      expect(result.bestMatch?.id).toBe("mj-1");
      expect(result.isAmbiguous).toBe(false);
      expect(result.isConflict).toBe(false);
      expect(result.reviewStatus).toBe(TrackMatchReviewStatus.AUTO_MATCHED);
      expect(result.category).toBe("EXACT");
      expect(result.method).toBe(MatchMethod.EXACT_ISRC);
      expect(result.evidence).not.toBeNull();
      expect(result.evidence?.breakdown.isrcMatch).toBe(true);
    });
  });

  describe("Catalog Search & Fallback Strategies (Mocked HTTP)", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("searches Spotify catalog and parses track attributes cleanly", async () => {
      const mockSpotifyResponse = {
        tracks: {
          items: [
            {
              id: "spot-123",
              name: "Blinding Lights",
              uri: "spotify:track:spot-123",
              duration_ms: 200040,
              explicit: false,
              external_ids: { isrc: "CAUM71900764" },
              artists: [{ id: "art-1", name: "The Weeknd" }],
              album: { id: "alb-1", name: "After Hours" },
            },
          ],
        },
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockSpotifyResponse,
      } as any);

      const candidates = await searchSpotifyCatalog("Blinding Lights The Weeknd", "mock-token");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("spot-123");
      expect(candidates[0].title).toBe("Blinding Lights");
      expect(candidates[0].artistName).toBe("The Weeknd");
      expect(candidates[0].isrc).toBe("CAUM71900764");
      expect(candidates[0].provider).toBe(ProviderType.SPOTIFY);
    });

    it("searches Apple Music catalog and parses song attributes cleanly", async () => {
      const mockAppleResponse = {
        results: {
          songs: {
            data: [
              {
                id: "apple-456",
                type: "songs",
                href: "/v1/catalog/us/songs/apple-456",
                attributes: {
                  name: "As It Was",
                  artistName: "Harry Styles",
                  albumName: "Harry's House",
                  durationInMillis: 167303,
                  isrc: "USSM12200612",
                  contentRating: "clean",
                },
              },
            ],
          },
        },
      };

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        json: async () => mockAppleResponse,
      } as any);

      const candidates = await searchAppleMusicCatalog("As It Was Harry Styles", "mock-dev-token", "us");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe("apple-456");
      expect(candidates[0].title).toBe("As It Was");
      expect(candidates[0].artistName).toBe("Harry Styles");
      expect(candidates[0].isrc).toBe("USSM12200612");
      expect(candidates[0].provider).toBe(ProviderType.APPLE_MUSIC);
    });

    it("executes multi-stage search fallback when stage 1 yields no results", async () => {
      // First call (stage 1) returns empty items
      // Second call (stage 2) returns candidate
      const mockFetch = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ tracks: { items: [] } }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tracks: {
              items: [
                {
                  id: "fallback-track",
                  name: "Rare Obscure Song",
                  duration_ms: 210000,
                  artists: [{ name: "Indie Artist" }],
                },
              ],
            },
          }),
        } as any);

      const result = await retrieveAndMatchCandidates(
        {
          title: "Rare Obscure Song (Feat. Guest)",
          artistName: "Indie Artist",
          durationMs: 210000,
        },
        ProviderType.SPOTIFY,
        { spotifyAccessToken: "test-token" }
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.bestMatch?.id).toBe("fallback-track");
    });
  });
});
