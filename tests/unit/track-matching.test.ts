import { describe, it, expect } from "vitest";
import {
  extractVersionInfo,
  areVersionTagsCompatible,
  isMaterialContradiction,
  normalizeString,
  TrackInput,
} from "@/modules/matching/track-matching.service";
import { Track } from "@prisma/client";

describe("Track Matching Version & Metadata Discrimination (Unit)", () => {
  describe("normalizeString", () => {
    it("strips punctuation, trims, and lowercases text", () => {
      expect(normalizeString("  The Beatles - Let It Be! (2021) ")).toBe(
        "the beatles let it be 2021"
      );
      expect(normalizeString("Björk")).toBe("bjork");
    });
  });

  describe("extractVersionInfo", () => {
    it("identifies studio recordings as having no version flags", () => {
      const info = extractVersionInfo("Bohemian Rhapsody");
      expect(info.isLive).toBe(false);
      expect(info.isRemix).toBe(false);
      expect(info.isAcoustic).toBe(false);
      expect(info.isRemastered).toBe(false);
      expect(info.isInstrumental).toBe(false);
      expect(info.isRadioEdit).toBe(false);
    });

    it("identifies live concert recordings", () => {
      expect(extractVersionInfo("Hotel California - Live at the Forum").isLive).toBe(true);
      expect(extractVersionInfo("Comfortably Numb (Live)").isLive).toBe(true);
      expect(extractVersionInfo("Layla (Acoustic / Live)").isLive).toBe(true);
      expect(extractVersionInfo("Layla (Acoustic / Live)").isAcoustic).toBe(true);
    });

    it("identifies remixes and club edits", () => {
      expect(extractVersionInfo("Levitating (Club Mix)").isRemix).toBe(true);
      expect(extractVersionInfo("Midnight City (Eric Prydz Remix)").isRemix).toBe(true);
      expect(extractVersionInfo("One More Time (Extended Mix)").isRemix).toBe(true);
    });

    it("identifies instrumental and karaoke tracks", () => {
      expect(extractVersionInfo("Yesterday (Instrumental)").isInstrumental).toBe(true);
      expect(extractVersionInfo("Rolling in the Deep (Karaoke Version)").isInstrumental).toBe(true);
    });

    it("identifies clean and radio edits", () => {
      expect(extractVersionInfo("Stan (Radio Edit)").isRadioEdit).toBe(true);
      expect(extractVersionInfo("In Da Club (Clean)").isRadioEdit).toBe(true);
    });
  });

  describe("areVersionTagsCompatible", () => {
    it("treats two clean studio recordings as compatible", () => {
      const a = extractVersionInfo("Yesterday");
      const b = extractVersionInfo("Yesterday");
      expect(areVersionTagsCompatible(a, b)).toBe(true);
    });

    it("rejects matching studio recording with live recording", () => {
      const studio = extractVersionInfo("Hotel California");
      const live = extractVersionInfo("Hotel California (Live)");
      expect(areVersionTagsCompatible(studio, live)).toBe(false);
    });

    it("rejects matching studio recording with remix", () => {
      const studio = extractVersionInfo("Stayin' Alive");
      const remix = extractVersionInfo("Stayin' Alive (Remix)");
      expect(areVersionTagsCompatible(studio, remix)).toBe(false);
    });

    it("rejects matching acoustic with instrumental", () => {
      const acoustic = extractVersionInfo("Everlong (Acoustic)");
      const instrumental = extractVersionInfo("Everlong (Instrumental)");
      expect(areVersionTagsCompatible(acoustic, instrumental)).toBe(false);
    });

    it("accepts two matching live recordings", () => {
      const live1 = extractVersionInfo("Sultans of Swing (Live at Wembley)");
      const live2 = extractVersionInfo("Sultans of Swing - Live 1985");
      expect(areVersionTagsCompatible(live1, live2)).toBe(true);
    });

    it("rejects matching radio edit / clean with original", () => {
      const radio = extractVersionInfo("Forgot About Dre (Radio Edit)");
      const original = extractVersionInfo("Forgot About Dre");
      expect(areVersionTagsCompatible(radio, original)).toBe(false);
    });
  });

  describe("isMaterialContradiction", () => {
    const canonicalTrack: Track = {
      id: "canon-1",
      isrc: "GB-AAA-75-00001",
      title: "Bohemian Rhapsody",
      artistName: "Queen",
      albumName: "A Night at the Opera",
      durationMs: 354000,
      explicit: false,
      discNumber: 1,
      trackNumber: 11,
      needsReview: false,
      conflictReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("returns false for matching track with identical metadata", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 354000,
        explicit: false,
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(false);
    });

    it("returns false for slight duration variance within 15 seconds", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 358000, // 4s difference
        explicit: false,
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(false);
    });

    it("flags material contradiction if artist names are materially different", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody",
        artistName: "David Bowie", // Contradiction!
        durationMs: 354000,
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(true);
    });

    it("flags material contradiction if song titles are materially different", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Under Pressure", // Contradiction!
        artistName: "Queen",
        durationMs: 354000,
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(true);
    });

    it("flags material contradiction if duration difference exceeds 15 seconds", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 380000, // 26s difference (> 15s)
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(true);
    });

    it("flags material contradiction if explicit flag conflicts", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody",
        artistName: "Queen",
        durationMs: 354000,
        explicit: true, // Contradicts canonicalTrack.explicit: false
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(true);
    });

    it("flags material contradiction if version modifiers conflict (e.g. Live vs Studio)", () => {
      const input: TrackInput = {
        isrc: "GB-AAA-75-00001",
        title: "Bohemian Rhapsody (Live at Live Aid)", // Contradicts studio master
        artistName: "Queen",
        durationMs: 354000,
      };
      expect(isMaterialContradiction(input, canonicalTrack)).toBe(true);
    });
  });
});
