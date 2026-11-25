/**
 * YouTube Music and Video Metadata Normalizer for SONORA (P5-T03).
 *
 * Provides specialized extraction and normalization for YouTube catalog items:
 * - Strips resolution/quality noise ([4K], [HD], 1080p, etc.)
 * - Strips video/audio tags ((Official Music Video), [Official Audio], (Visualizer), etc.)
 * - Disentangles "Artist - Title" prefixes from video titles
 * - Classifies version characteristics (Live, Remix, Acoustic, Instrumental, Cover, etc.)
 * - Extracts ISRC from video descriptions (Topic channels and metadata disclosures)
 * - Parses ISO 8601 duration strings into milliseconds
 */

import {
  normalizeUnicodeAndPunctuation,
  normalizeComparableString,
  splitArtistNames,
  TrackRecordingType,
} from "./metadata-normalizer";

export interface ParsedYouTubeTitle {
  rawTitle: string;
  artist: string;
  title: string;
  cleanTitle: string;
  normalizedTitle: string;
  normalizedArtist: string;
  allArtists: string[];
  recordingType: TrackRecordingType;
  versionTags: string[];
  isTopicChannel: boolean;
  isOfficialAudio: boolean;
  isMusicVideo: boolean;
  isCover: boolean;
  isLive: boolean;
  isRemix: boolean;
  isAcoustic: boolean;
  isInstrumental: boolean;
  isRadioEdit: boolean;
  isExtended: boolean;
  isExplicit: boolean;
}

/**
 * Parses ISO 8601 duration strings (e.g., "PT3M45S", "PT1H2M3S", "PT45S") to milliseconds.
 */
export function parseYouTubeDuration(isoDuration: string): number {
  if (!isoDuration || typeof isoDuration !== "string") return 0;

  const match = isoDuration.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;

  const days = parseInt(match[1] || "0", 10);
  const hours = parseInt(match[2] || "0", 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);

  return (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Extracts ISRC from YouTube video descriptions or metadata fields.
 * Topic channel videos regularly publish ISRC in the description:
 * e.g., "ISRC: USUM71900123" or "isrc: GBAHT1901299".
 */
export function extractIsrcFromYouTubeDescription(description: string): string | null {
  if (!description || typeof description !== "string") return null;

  // Pattern 1: Explicit ISRC label
  const labeledMatch = description.match(
    /\b(?:ISRC|isrc)[\s:=]+([A-Z]{2}[- ]?[A-Z0-9]{3}[- ]?[0-9]{2}[- ]?[0-9]{5})\b/i
  );
  if (labeledMatch && labeledMatch[1]) {
    const clean = labeledMatch[1].replace(/[- ]/g, "").toUpperCase();
    if (clean.length === 12) return clean;
  }

  // Pattern 2: Standalone ISRC format in line
  const standaloneMatch = description.match(
    /\b([A-Z]{2}[A-Z0-9]{3}[0-9]{7})\b/
  );
  if (standaloneMatch && standaloneMatch[1]) {
    return standaloneMatch[1].toUpperCase();
  }

  return null;
}

/**
 * Normalizes channel titles, stripping standard YouTube channel qualifiers:
 * - "Artist - Topic" -> "Artist"
 * - "ArtistVEVO" -> "Artist"
 * - "Artist Official" -> "Artist"
 */
export function cleanYouTubeChannelTitle(channelTitle: string): string {
  if (!channelTitle) return "";

  let cleaned = normalizeUnicodeAndPunctuation(channelTitle);

  // Strip " - Topic"
  cleaned = cleaned.replace(/\s*-\s*Topic\s*$/i, "").trim();

  // Strip trailing "VEVO" (case-insensitive)
  cleaned = cleaned.replace(/VEVO$/i, "").trim();

  // Strip trailing "Official", "Official Channel", "Records"
  cleaned = cleaned
    .replace(/\s+(?:Official(?:\s+Channel|\s+Artist\s+Channel)?|Music|Records)$/i, "")
    .trim();

  return cleaned;
}

// Regex matching common video/audio noise tags
const RESOLUTION_TAGS_REGEX =
  /[\(\[\{]?(?:4K(?:\s+UHD|\s+60fps)?|HD|HQ|1080p|720p|Official\s+4K\s+Video|Ultra\s+HD|HDR)[\)\]\}]?/gi;

const VIDEO_AUDIO_TAGS_REGEX =
  /[\(\[\{]\s*(?:Official\s+(?:Music\s+Video|Video|Audio|Lyric\s+Video|Visualizer)|Music\s+Video|Performance\s+Video|Vertical\s+Video|Lyric\s+Video|Visualizer|Audio|Video|Lyrics|Full\s+Track|HQ\s+Audio)\s*[\)\]\}]/gi;

const TRAILING_DASH_NOISE_REGEX =
  /\s*-\s*(?:Official\s+(?:Music\s+Video|Video|Audio|Visualizer)|Music\s+Video|Lyric\s+Video|Visualizer|Lyrics)\s*$/i;

/**
 * Strips resolution, quality, and video/audio tags from a YouTube video title.
 */
export function stripYouTubeVideoNoise(rawTitle: string): string {
  if (!rawTitle) return "";

  let cleaned = normalizeUnicodeAndPunctuation(rawTitle);

  // Strip bracketed video / audio tags: "(Official Music Video)", "[Official Audio]", etc.
  cleaned = cleaned.replace(VIDEO_AUDIO_TAGS_REGEX, " ");

  // Strip resolution tags: "[4K]", "(HD)", "1080p", etc.
  cleaned = cleaned.replace(RESOLUTION_TAGS_REGEX, " ");

  // Strip trailing hyphenated video tags: " - Official Video", " - Lyric Video"
  cleaned = cleaned.replace(TRAILING_DASH_NOISE_REGEX, " ");

  // Normalize quotes and whitespace
  cleaned = cleaned
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

/**
 * Parses and decomposes a YouTube video title into canonical artist, song title, and version tags.
 */
export function parseYouTubeVideoTitle(
  rawTitle: string,
  rawChannelTitle?: string,
  description?: string
): ParsedYouTubeTitle {
  const channelClean = cleanYouTubeChannelTitle(rawChannelTitle || "");
  const isTopicChannel = Boolean(
    rawChannelTitle && /-\s*Topic$/i.test(rawChannelTitle)
  );
  const isOfficialAudio = Boolean(
    /official\s+audio/i.test(rawTitle) ||
      (description && /Provided to YouTube by/i.test(description)) ||
      isTopicChannel
  );
  const isMusicVideo = Boolean(
    /official\s+(?:music\s+)?video/i.test(rawTitle) ||
      /\[music\s+video\]/i.test(rawTitle)
  );

  // Strip resolution and video/audio tags
  const cleaned = stripYouTubeVideoNoise(rawTitle);

  // Check version modifiers
  const lower = cleaned.toLowerCase();
  const isCover =
    /\b(cover|cover\s+by|tribute\s+to)\b/i.test(lower) ||
    /[\(\[\{][^\)\]\}]*(?:cover|tribute)[^\)\]\}]*[\)\]\}]/i.test(cleaned);
  const isLive =
    /\b(live|in\s+concert|unplugged)\b/i.test(lower) ||
    /[\(\[\{][^\)\]\}]*(?:live|concert|unplugged)[^\)\]\}]*[\)\]\}]/i.test(cleaned);
  const isRemix =
    (/\b(remix|mix|bootleg|dub|rework)\b/i.test(lower) && !/\b(radio\s+edit)\b/i.test(lower)) ||
    /[\(\[\{][^\)\]\}]*(?:remix|dub|rework)[^\)\]\}]*[\)\]\}]/i.test(cleaned);
  const isAcoustic =
    /\b(acoustic|stripped)\b/i.test(lower) ||
    /[\(\[\{][^\)\]\}]*(?:acoustic|stripped)[^\)\]\}]*[\)\]\}]/i.test(cleaned);
  const isInstrumental =
    /\b(instrumental|karaoke|backing\s+track)\b/i.test(lower) ||
    /[\(\[\{][^\)\]\}]*(?:instrumental|karaoke)[^\)\]\}]*[\)\]\}]/i.test(cleaned);
  const isRadioEdit =
    /\b(radio\s+edit|radio\s+mix|clean\s+version|censored)\b/i.test(lower);
  const isExtended =
    /\b(extended|extended\s+(?:mix|version)|club\s+mix)\b/i.test(lower);
  const isExplicit =
    /\b(explicit)\b/i.test(lower) || /\b(explicit)\b/i.test(rawTitle);

  const versionTags: string[] = [];
  if (isLive) versionTags.push("live");
  if (isRemix) versionTags.push("remix");
  if (isAcoustic) versionTags.push("acoustic");
  if (isInstrumental) versionTags.push("instrumental");
  if (isRadioEdit) versionTags.push("radio_edit");
  if (isExtended) versionTags.push("extended");
  if (isCover) versionTags.push("cover");

  let recordingType: TrackRecordingType = "ORIGINAL";
  if (isCover) recordingType = "COVER";
  else if (isLive) recordingType = "LIVE";
  else if (isRemix) recordingType = "REMIX";
  else if (isAcoustic) recordingType = "ACOUSTIC";
  else if (isInstrumental) recordingType = "INSTRUMENTAL";
  else if (isRadioEdit) recordingType = "RADIO_EDIT";
  else if (isExtended) recordingType = "EXTENDED";

  // Try splitting "Artist - Title"
  let extractedArtist = "";
  let extractedTitle = cleaned;

  // Check for common delimiter " - " or " – " or " — "
  const dashSplitMatch = cleaned.match(/^(.+?)\s*[\–\—\-]\s*(.+)$/);
  if (dashSplitMatch) {
    const part1 = dashSplitMatch[1].trim();
    const part2 = dashSplitMatch[2].trim();

    // Disambiguate which part is artist using channelTitle
    const normPart2 = normalizeComparableString(part2);
    const normChannel = normalizeComparableString(channelClean);

    if (normChannel && (normChannel === normPart2 || normPart2.includes(normChannel))) {
      // Inverted: "Title - Artist"
      extractedArtist = part2;
      extractedTitle = part1;
    } else {
      // Standard: "Artist - Title"
      extractedArtist = part1;
      extractedTitle = part2;
    }
  } else if (channelClean) {
    // No dash separator: video title is track title, channel title is artist
    extractedArtist = channelClean;
    extractedTitle = cleaned;
  } else {
    extractedArtist = "Unknown Artist";
    extractedTitle = cleaned;
  }

  // Clean remaining quotation marks from extracted title
  extractedTitle = extractedTitle
    .replace(/^["'«»“”„]+|["'«»“”„]+$/g, "")
    .trim();

  // Strip version parentheticals from cleanTitle for matching comparison
  let cleanTitle = extractedTitle
    .replace(/[\(\[\{][^\)\]\}]*(?:live|acoustic|unplugged|remix|version|remaster|radio|stripped|cover)[^\)\]\}]*[\)\]\}]/gi, "")
    .replace(/\s*-\s*(?:live|acoustic|unplugged|remix|remastered?|radio edit|cover)[^\(\[\{\-]*/gi, "")
    .replace(/[\(\[\{\-\:\–\—\s]+$/, "")
    .replace(/^[\(\[\{\-\:\–\—\s]+/, "")
    .trim();

  if (!cleanTitle) {
    cleanTitle = extractedTitle;
  }

  const allArtists = splitArtistNames(extractedArtist);

  return {
    rawTitle,
    artist: extractedArtist,
    title: extractedTitle,
    cleanTitle,
    normalizedTitle: normalizeComparableString(cleanTitle),
    normalizedArtist: normalizeComparableString(extractedArtist),
    allArtists,
    recordingType,
    versionTags,
    isTopicChannel,
    isOfficialAudio,
    isMusicVideo,
    isCover,
    isLive,
    isRemix,
    isAcoustic,
    isInstrumental,
    isRadioEdit,
    isExtended,
    isExplicit,
  };
}
