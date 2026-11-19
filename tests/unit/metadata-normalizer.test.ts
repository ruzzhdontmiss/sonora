import { describe, it, expect } from "vitest";
import {
  normalizeTrackMetadata,
  normalizeUnicodeAndPunctuation,
  normalizeComparableString,
  splitArtistNames,
} from "@/modules/matching/metadata-normalizer";

describe("Deterministic Metadata Normalizer (P4-T01)", () => {
  describe("Unicode and Punctuation Normalization", () => {
    it("handles smart quotes, em-dashes, ellipses and whitespace variations", () => {
      const input = "“Song’s Title” — Live…   Edition";
      const normalized = normalizeUnicodeAndPunctuation(input);
      expect(normalized).toBe('"Song\'s Title" - Live... Edition');
    });

    it("normalizes fullwidth characters and Unicode compatibility forms", () => {
      const fullwidth = "Ｓｏｎｇ　Ｔｉｔｌｅ";
      expect(normalizeUnicodeAndPunctuation(fullwidth)).toBe("Song Title");

      const ligature = "ﬁnding ﬂowers";
      expect(normalizeUnicodeAndPunctuation(ligature)).toBe("finding flowers");
    });

    it("preserves non-Latin scripts (Japanese, Korean, Cyrillic, Arabic)", () => {
      const japanese = "夜に駆ける";
      expect(normalizeUnicodeAndPunctuation(japanese)).toBe("夜に駆ける");
      expect(normalizeComparableString(japanese)).toBe("夜に駆ける");

      const korean = "봄날 (Spring Day)";
      expect(normalizeComparableString(korean)).toBe("봄날 spring day");

      const cyrillic = "Кино — Группа крови";
      expect(normalizeComparableString(cyrillic)).toBe("кино группа крови");
    });

    it("handles accented European characters cleanly without destroying accents", () => {
      const spanish = "Canción del Mariachi (feat. Los Lobos)";
      const res = normalizeTrackMetadata({
        title: spanish,
        artistName: "Antonio Banderas",
        durationMs: 180000,
      });

      expect(res.cleanTitle).toBe("Canción del Mariachi");
      expect(res.featuredArtists).toContain("Los Lobos");
      expect(res.normalizedTitle).toBe("canción del mariachi");
    });
  });

  describe("Featuring Credits Extraction", () => {
    it("extracts featuring artists from title and cleans title", () => {
      const res = normalizeTrackMetadata({
        title: "Empire State of Mind (feat. Alicia Keys)",
        artistName: "JAY-Z",
        durationMs: 276000,
      });

      expect(res.cleanTitle).toBe("Empire State of Mind");
      expect(res.featuredArtists).toEqual(["Alicia Keys"]);
      expect(res.allArtists).toContain("JAY-Z");
      expect(res.allArtists).toContain("Alicia Keys");
    });

    it("extracts featuring artists using ft., featuring, or with in brackets and parens", () => {
      const res1 = normalizeTrackMetadata({
        title: "Levitating [ft. DaBaby]",
        artistName: "Dua Lipa",
        durationMs: 203000,
      });
      expect(res1.cleanTitle).toBe("Levitating");
      expect(res1.featuredArtists).toEqual(["DaBaby"]);

      const res2 = normalizeTrackMetadata({
        title: "Under Pressure (with David Bowie)",
        artistName: "Queen",
        durationMs: 248000,
      });
      expect(res2.cleanTitle).toBe("Under Pressure");
      expect(res2.featuredArtists).toEqual(["David Bowie"]);
    });
  });

  describe("Multiple Artist Handling & Preserved Bands", () => {
    it("splits multiple artists with comma, ampersand, slash, and semicolon", () => {
      expect(splitArtistNames("David Guetta & Bebe Rexha")).toEqual([
        "David Guetta",
        "Bebe Rexha",
      ]);
      expect(splitArtistNames("Drake, Kanye West, Lil Wayne & Eminem")).toEqual([
        "Drake",
        "Kanye West",
        "Lil Wayne",
        "Eminem",
      ]);
      expect(splitArtistNames("Skrillex / Diplo / Justin Bieber")).toEqual([
        "Skrillex",
        "Diplo",
        "Justin Bieber",
      ]);
    });

    it("preserves well-known band names that contain internal separators", () => {
      expect(splitArtistNames("Earth, Wind & Fire")).toEqual(["Earth, Wind & Fire"]);
      expect(splitArtistNames("AC/DC")).toEqual(["AC/DC"]);
      expect(splitArtistNames("Crosby, Stills, Nash & Young")).toEqual([
        "Crosby, Stills, Nash & Young",
      ]);
      expect(splitArtistNames("Simon & Garfunkel")).toEqual(["Simon & Garfunkel"]);
      expect(splitArtistNames("Hall & Oates")).toEqual(["Hall & Oates"]);
    });
  });

  describe("Recording Version Classification & Disambiguation", () => {
    it("distinguishes Remastered versions and extracts remaster year", () => {
      const res = normalizeTrackMetadata({
        title: "Bohemian Rhapsody - 2011 Remaster",
        artistName: "Queen",
        albumName: "A Night at the Opera (Deluxe Edition)",
        durationMs: 354000,
      });

      expect(res.cleanTitle).toBe("Bohemian Rhapsody");
      expect(res.recordingType).toBe("REMASTER");
      expect(res.isRemaster).toBe(true);
      expect(res.remasterYear).toBe(2011);
      expect(res.isLive).toBe(false);
      expect(res.isRemix).toBe(false);
    });

    it("distinguishes Live versions and extracts venue/context", () => {
      const res = normalizeTrackMetadata({
        title: "Hotel California (Live at The Forum, 1976)",
        artistName: "Eagles",
        durationMs: 410000,
      });

      expect(res.cleanTitle).toBe("Hotel California");
      expect(res.recordingType).toBe("LIVE");
      expect(res.isLive).toBe(true);
      expect(res.liveVenueOrYear).toBe("The Forum, 1976");
      expect(res.isRemaster).toBe(false);
    });

    it("distinguishes Acoustic and Stripped recordings", () => {
      const res = normalizeTrackMetadata({
        title: "Everlong (Acoustic Version)",
        artistName: "Foo Fighters",
        durationMs: 251000,
      });

      expect(res.cleanTitle).toBe("Everlong");
      expect(res.recordingType).toBe("ACOUSTIC");
      expect(res.isAcoustic).toBe(true);
    });

    it("distinguishes Remixes and extracts remix artist", () => {
      const res = normalizeTrackMetadata({
        title: "Titanium (Alesso Remix)",
        artistName: "David Guetta",
        durationMs: 380000,
      });

      expect(res.cleanTitle).toBe("Titanium");
      expect(res.recordingType).toBe("REMIX");
      expect(res.isRemix).toBe(true);
      expect(res.remixArtist).toBe("Alesso");
    });

    it("distinguishes Instrumental and Karaoke recordings", () => {
      const res = normalizeTrackMetadata({
        title: "Clocks (Instrumental)",
        artistName: "Coldplay",
        durationMs: 307000,
      });

      expect(res.cleanTitle).toBe("Clocks");
      expect(res.recordingType).toBe("INSTRUMENTAL");
      expect(res.isInstrumental).toBe(true);
    });

    it("distinguishes Radio Edit and Clean recordings", () => {
      const res = normalizeTrackMetadata({
        title: "Stan (Radio Edit)",
        artistName: "Eminem",
        durationMs: 238000,
      });

      expect(res.cleanTitle).toBe("Stan");
      expect(res.recordingType).toBe("RADIO_EDIT");
      expect(res.isRadioEdit).toBe(true);
      expect(res.isClean).toBe(true);
    });

    it("ensures different versions of the same song produce distinct recording types and never accidentally merge", () => {
      const original = normalizeTrackMetadata({
        title: "Layla",
        artistName: "Derek & The Dominos",
        durationMs: 424000,
      });

      const live = normalizeTrackMetadata({
        title: "Layla (Live at the Royal Albert Hall)",
        artistName: "Eric Clapton",
        durationMs: 400000,
      });

      const acoustic = normalizeTrackMetadata({
        title: "Layla (Acoustic - Live / MTV Unplugged)",
        artistName: "Eric Clapton",
        durationMs: 289000,
      });

      // Same normalized base title, but different recording types!
      expect(original.normalizedTitle).toBe("layla");
      expect(live.normalizedTitle).toBe("layla");
      expect(acoustic.normalizedTitle).toBe("layla");

      expect(original.recordingType).toBe("ORIGINAL");
      expect(live.recordingType).toBe("LIVE");
      expect(acoustic.recordingType).toBe("LIVE"); // live + acoustic
      expect(acoustic.isAcoustic).toBe(true);
    });
  });

  describe("Lossless Raw Metadata Retention", () => {
    it("preserves rawTitle, rawArtistName, and rawAlbumName without alteration", () => {
      const rawTitle = "  Paranoid Android (Remastered)   ";
      const rawArtist = "Radiohead  ";
      const rawAlbum = "OK Computer (OKNOTOK 1997 2017)";

      const res = normalizeTrackMetadata({
        title: rawTitle,
        artistName: rawArtist,
        albumName: rawAlbum,
        durationMs: 387000.8,
      });

      expect(res.rawTitle).toBe(rawTitle);
      expect(res.rawArtistName).toBe(rawArtist);
      expect(res.rawAlbumName).toBe(rawAlbum);
      expect(res.normalizedDurationMs).toBe(387001);
      expect(res.cleanTitle).toBe("Paranoid Android");
    });

    it("gracefully handles missing, empty, or negative inputs", () => {
      const res = normalizeTrackMetadata({
        title: "",
        artistName: "",
        albumName: null,
        durationMs: -500,
      });

      expect(res.cleanTitle).toBe("");
      expect(res.normalizedDurationMs).toBe(0);
      expect(res.primaryArtist).toBe("Unknown Artist");
      expect(res.recordingType).toBe("ORIGINAL");
    });
  });
});
