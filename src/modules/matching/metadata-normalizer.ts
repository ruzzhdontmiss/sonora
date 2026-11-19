/**
 * Deterministic Metadata Normalization Engine for SONORA (P4-T01).
 *
 * Normalizes title, artist, and version metadata across providers while strictly
 * preserving recording distinctions (original, live, remaster, acoustic, remix, etc.).
 * Guarantees idempotency and lossless retention of raw provider metadata.
 */

export type TrackRecordingType =
  | "ORIGINAL"
  | "REMASTER"
  | "LIVE"
  | "ACOUSTIC"
  | "REMIX"
  | "INSTRUMENTAL"
  | "RADIO_EDIT"
  | "EXTENDED"
  | "DEMO"
  | "COVER";

export interface NormalizedTrackMetadata {
  rawTitle: string;
  rawArtistName: string;
  rawAlbumName: string | null;

  // Canonical representations
  cleanTitle: string; // Title stripped of featuring and version wrappers
  normalizedTitle: string; // Deterministic lowercased, punctuation-normalized comparable title
  primaryArtist: string;
  normalizedPrimaryArtist: string;
  allArtists: string[];
  normalizedArtists: string[];
  featuredArtists: string[];

  // Version classification
  recordingType: TrackRecordingType;
  versionTags: string[];
  remixArtist: string | null;
  liveVenueOrYear: string | null;
  remasterYear: number | null;

  // Boolean flags for fast invariant matching
  isLive: boolean;
  isRemix: boolean;
  isAcoustic: boolean;
  isRemaster: boolean;
  isInstrumental: boolean;
  isRadioEdit: boolean;
  isExtended: boolean;
  isDemo: boolean;
  isCover: boolean;
  isExplicit: boolean;
  isClean: boolean;

  normalizedDurationMs: number;
}

export interface NormalizeTrackOptions {
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  explicit?: boolean;
}

// Well-known bands with internal separators that should not be split
const PRESERVED_MULTI_ARTIST_NAMES = new Set([
  "earth, wind & fire",
  "ac/dc",
  "crosby, stills, nash & young",
  "crosby, stills & nash",
  "simon & garfunkel",
  "hall & oates",
  "daryl hall & john oates",
  "kool & the gang",
  "the mamas & the papas",
  "huey lewis & the news",
  "emerson, lake & palmer",
  "blood, sweat & tears",
  "sly & the family stone",
  "tom petty and the heartbreakers",
  "gladio & friends",
  "king gizzard & the lizard wizard",
]);

/**
 * Standardizes Unicode and punctuation without destroying characters in non-Latin scripts.
 */
export function normalizeUnicodeAndPunctuation(str: string): string {
  if (!str) return "";

  return str
    // Normalize to NFKC (compatibility decomposition followed by canonical composition)
    .normalize("NFKC")
    // Normalize smart double quotes to standard ASCII double quote
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"')
    // Normalize smart single quotes / apostrophes to standard ASCII single quote
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060]/g, "'")
    // Normalize all dashes, hyphens, minuses to standard ASCII hyphen
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Normalize ellipses
    .replace(/\u2026/g, "...")
    // Normalize whitespace (non-breaking spaces, thin spaces, tabs) to standard space
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ")
    .trim();
}

/**
 * Normalizes a string for loose deterministic comparison (lowercase, alphanumeric + space).
 * Normalizes to NFC so non-Latin scripts (Korean, Cyrillic, Japanese) and accented European characters
 * remain cleanly composed without losing their distinct codepoints.
 */
export function normalizeComparableString(str: string): string {
  return normalizeUnicodeAndPunctuation(str)
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, "") // Preserves letters and numbers in any language/script
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts featuring artist credits from a title or artist string.
 */
function extractFeaturingCredits(text: string): { cleanedText: string; featured: string[] } {
  const featRegex = /(?:[\(\[\{]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]\}]+)[\)\]\}]|\s+(?:feat\.?|ft\.?|featuring|with)\s+([^\(\[\{\-]+))/i;
  const match = text.match(featRegex);
  const featured: string[] = [];
  let cleanedText = text;

  if (match) {
    const rawArtists = match[1] || match[2] || "";
    const parsed = splitArtistNames(rawArtists);
    for (const a of parsed) {
      if (a && !featured.includes(a)) {
        featured.push(a);
      }
    }
    cleanedText = cleanedText.replace(featRegex, "").trim();
  }

  return { cleanedText, featured };
}

/**
 * Splits multiple artist names honoring preserved legacy band names.
 */
export function splitArtistNames(artistStr: string): string[] {
  const normalized = normalizeUnicodeAndPunctuation(artistStr);
  if (!normalized) return [];

  const lower = normalized.toLowerCase();
  for (const preserved of PRESERVED_MULTI_ARTIST_NAMES) {
    if (lower === preserved) {
      return [normalized];
    }
  }

  // Split by common separators: semicolon, slash, comma, ampersand, 'x', 'vs.', 'feat.'
  const parts = normalized.split(/\s*(?:;|(?<=\S)\s*\/\s*(?=\S)|,(?!\s*(?:jr\.?|sr\.?|iii|iv|ii))\s*|\s+&\s+|\s+[xX]\s+|\s+vs\.?\s+)\s*/i);

  const result: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0 && !result.includes(trimmed)) {
      result.push(trimmed);
    }
  }

  return result.length > 0 ? result : [normalized];
}

/**
 * Inspects title and album for version and recording metadata.
 */
function extractRecordingDetails(title: string, album?: string | null): {
  cleanTitle: string;
  recordingType: TrackRecordingType;
  versionTags: string[];
  remixArtist: string | null;
  liveVenueOrYear: string | null;
  remasterYear: number | null;
  flags: {
    isLive: boolean;
    isRemix: boolean;
    isAcoustic: boolean;
    isRemaster: boolean;
    isInstrumental: boolean;
    isRadioEdit: boolean;
    isExtended: boolean;
    isDemo: boolean;
    isCover: boolean;
  };
} {
  const versionTags: string[] = [];
  let cleanTitle = title;
  let remixArtist: string | null = null;
  let liveVenueOrYear: string | null = null;
  let remasterYear: number | null = null;

  const combined = `${title} ${album || ""}`;

  // 1. Remaster detection
  const remasterRegex = /[\(\[\{]?(?:(\d{4})\s+)?(?:re-?master(?:ed)?|digital\s+remaster(?:ed)?|anniversary(?:\s+edition)?|deluxe(?:\s+edition)?)(?:\s+(\d{4}))?[\)\]\}]?/gi;
  const isRemaster = remasterRegex.test(combined);
  if (isRemaster) {
    versionTags.push("remaster");
    const yearMatch = combined.match(/\b(19\d{2}|20\d{2})\s*(?:re-?master|anniversary)/i) ||
                      combined.match(/re-?master(?:ed)?\s*[\(\[\{]?\s*(19\d{2}|20\d{2})/i);
    if (yearMatch) {
      remasterYear = parseInt(yearMatch[1], 10);
    }
    cleanTitle = cleanTitle.replace(remasterRegex, "").trim();
  }

  // 2. Live detection
  const liveRegex = /(?:[\(\[\{]\s*(?:live(?:\s+(?:at|in|from|on)\s+([^\)\]\}]+))?|in\s+concert|unplugged)\s*[\)\]\}]|\b(?:live\s+(?:at|in|from|on)\s+([^\(\[\{\-]+)|in\s+concert|unplugged)\b)/i;
  const liveMatch = combined.match(liveRegex);
  const isLive = Boolean(liveMatch);
  if (isLive) {
    versionTags.push("live");
    const venue = liveMatch?.[1] || liveMatch?.[2];
    if (venue) {
      liveVenueOrYear = venue.trim();
    }
    cleanTitle = cleanTitle.replace(liveRegex, "").trim();
  }

  // 3. Acoustic detection
  const acousticRegex = /[\(\[\{]?(?:acoustic(?:\s+version)?|stripped)[\)\]\}]?/gi;
  const isAcoustic = acousticRegex.test(combined);
  if (isAcoustic) {
    versionTags.push("acoustic");
    cleanTitle = cleanTitle.replace(acousticRegex, "").trim();
  }

  // 4. Instrumental detection
  const instrumentalRegex = /[\(\[\{]?(?:instrumental(?:\s+version)?|karaoke(?:\s+version)?)[\)\]\}]?/gi;
  const isInstrumental = instrumentalRegex.test(combined);
  if (isInstrumental) {
    versionTags.push("instrumental");
    cleanTitle = cleanTitle.replace(instrumentalRegex, "").trim();
  }

  // 5. Radio Edit detection
  const radioEditRegex = /[\(\[\{]?(?:radio\s+edit|radio\s+mix|clean\s+version|censored)[\)\]\}]?/gi;
  const isRadioEdit = radioEditRegex.test(combined);
  if (isRadioEdit) {
    versionTags.push("radio_edit");
    cleanTitle = cleanTitle.replace(radioEditRegex, "").trim();
  }

  // 6. Extended mix detection
  const extendedRegex = /[\(\[\{]?(?:extended(?:\s+(?:mix|version))?|club\s+mix|original\s+mix)[\)\]\}]?/gi;
  const isExtended = extendedRegex.test(combined);
  if (isExtended) {
    versionTags.push("extended");
    cleanTitle = cleanTitle.replace(extendedRegex, "").trim();
  }

  // 7. Demo / Alternate detection
  const demoRegex = /[\(\[\{]?(?:demo(?:\s+version)?|take\s+\d+|rough\s+mix)[\)\]\}]?/gi;
  const isDemo = demoRegex.test(combined);
  if (isDemo) {
    versionTags.push("demo");
    cleanTitle = cleanTitle.replace(demoRegex, "").trim();
  }

  // 8. Cover detection
  const coverRegex = /[\(\[\{]?(?:[^\)\]\}]+\s+cover|tribute\s+to\s+[^\)\]\}]+)[\)\]\}]?/gi;
  const isCover = coverRegex.test(combined);
  if (isCover) {
    versionTags.push("cover");
    cleanTitle = cleanTitle.replace(coverRegex, "").trim();
  }

  // 9. Remix detection (must not clash with Radio Edit or Extended alone)
  const remixRegex = /(?:[\(\[\{]\s*([^\)\]\}]+?)\s+(?:remix|mix|bootleg|dub|rework)\s*[\)\]\}]|\s*-\s*([^\-]+?)\s+(?:remix|mix|bootleg|dub|rework))/i;
  let isRemix = false;
  if (!isRadioEdit) {
    const remixMatch = title.match(remixRegex);
    if (remixMatch) {
      isRemix = true;
      versionTags.push("remix");
      const candidateRaw = (remixMatch[1] || remixMatch[2] || "").trim();
      if (candidateRaw && !remixArtist) {
        if (!/^(club|extended|radio|original|dub)$/i.test(candidateRaw)) {
          remixArtist = candidateRaw;
        }
      }
      cleanTitle = cleanTitle.replace(remixRegex, "").trim();
    }
  }

  // Determine primary recording type in priority order
  let recordingType: TrackRecordingType = "ORIGINAL";
  if (isLive) recordingType = "LIVE";
  else if (isRemix) recordingType = "REMIX";
  else if (isAcoustic) recordingType = "ACOUSTIC";
  else if (isInstrumental) recordingType = "INSTRUMENTAL";
  else if (isRadioEdit) recordingType = "RADIO_EDIT";
  else if (isExtended) recordingType = "EXTENDED";
  else if (isDemo) recordingType = "DEMO";
  else if (isCover) recordingType = "COVER";
  else if (isRemaster) recordingType = "REMASTER";

  // Strip any remaining compound version brackets (e.g. "(Acoustic - Live / MTV Unplugged)")
  cleanTitle = cleanTitle
    .replace(/[\(\[\{][^\)\]\}]*(?:live|acoustic|unplugged|remix|version|remaster|radio|stripped)[^\)\]\}]*[\)\]\}]/gi, "")
    .replace(/\s*-\s*(?:live|acoustic|unplugged|remix|remastered?|radio edit)[^\(\[\{\-]*/gi, "")
    .trim();

  // Clean trailing punctuation / brackets left behind after strip
  cleanTitle = cleanTitle
    .replace(/[\(\[\{\-\:\–\—\s]+$/, "")
    .replace(/^[\(\[\{\-\:\–\—\s]+/, "")
    .trim();

  if (cleanTitle.length === 0) {
    cleanTitle = title; // fallback to original if entire title was stripped
  }

  return {
    cleanTitle,
    recordingType,
    versionTags,
    remixArtist,
    liveVenueOrYear,
    remasterYear,
    flags: {
      isLive,
      isRemix,
      isAcoustic,
      isRemaster,
      isInstrumental,
      isRadioEdit,
      isExtended,
      isDemo,
      isCover,
    },
  };
}

/**
 * Main Deterministic Normalizer Function.
 */
export function normalizeTrackMetadata(options: NormalizeTrackOptions): NormalizedTrackMetadata {
  const rawTitle = options.title || "";
  const rawArtistName = options.artistName || "";
  const rawAlbumName = options.albumName ?? null;

  // 1. Initial Unicode & Punctuation Clean
  const unicodeTitle = normalizeUnicodeAndPunctuation(rawTitle);
  const unicodeArtist = normalizeUnicodeAndPunctuation(rawArtistName);
  const unicodeAlbum = rawAlbumName ? normalizeUnicodeAndPunctuation(rawAlbumName) : null;

  // 2. Extract featuring credits from title and artist
  const titleFeat = extractFeaturingCredits(unicodeTitle);
  const artistFeat = extractFeaturingCredits(unicodeArtist);
  const featuredArtists = Array.from(new Set([...titleFeat.featured, ...artistFeat.featured]));

  // 3. Extract recording version modifiers
  const recordingDetails = extractRecordingDetails(titleFeat.cleanedText, unicodeAlbum);

  // 4. Split all contributing artists
  const allArtists = splitArtistNames(artistFeat.cleanedText);
  for (const fa of featuredArtists) {
    if (!allArtists.includes(fa)) {
      allArtists.push(fa);
    }
  }

  const primaryArtist = allArtists[0] || unicodeArtist || "Unknown Artist";

  // 5. Explicit vs Clean
  const isExplicit =
    options.explicit === true ||
    /\b(explicit)\b/i.test(unicodeTitle) ||
    (unicodeAlbum ? /\b(explicit)\b/i.test(unicodeAlbum) : false);

  const isClean =
    recordingDetails.flags.isRadioEdit ||
    /\b(clean|clean version)\b/i.test(unicodeTitle) ||
    (unicodeAlbum ? /\b(clean)\b/i.test(unicodeAlbum) : false);

  // 6. Duration normalization (clamp to positive integer ms)
  const normalizedDurationMs = Math.max(0, Math.round(options.durationMs || 0));

  // 7. Canonical comparable strings
  const normalizedTitle = normalizeComparableString(recordingDetails.cleanTitle);
  const normalizedPrimaryArtist = normalizeComparableString(primaryArtist);
  const normalizedArtists = allArtists.map((a) => normalizeComparableString(a)).filter(Boolean);

  return {
    rawTitle,
    rawArtistName,
    rawAlbumName,

    cleanTitle: recordingDetails.cleanTitle,
    normalizedTitle,
    primaryArtist,
    normalizedPrimaryArtist,
    allArtists,
    normalizedArtists,
    featuredArtists,

    recordingType: recordingDetails.recordingType,
    versionTags: recordingDetails.versionTags,
    remixArtist: recordingDetails.remixArtist,
    liveVenueOrYear: recordingDetails.liveVenueOrYear,
    remasterYear: recordingDetails.remasterYear,

    isLive: recordingDetails.flags.isLive,
    isRemix: recordingDetails.flags.isRemix,
    isAcoustic: recordingDetails.flags.isAcoustic,
    isRemaster: recordingDetails.flags.isRemaster,
    isInstrumental: recordingDetails.flags.isInstrumental,
    isRadioEdit: recordingDetails.flags.isRadioEdit,
    isExtended: recordingDetails.flags.isExtended,
    isDemo: recordingDetails.flags.isDemo,
    isCover: recordingDetails.flags.isCover,
    isExplicit,
    isClean,

    normalizedDurationMs,
  };
}
