/**
 * Google Data Portability API Service for YouTube Music (P5-T04b).
 *
 * Implements auxiliary export initiation, polling, and secure memory-bounded
 * archive ingestion with Zip-Slip protection and regional compliance.
 */

import zlib from "zlib";
import path from "path";
import {
  DATA_PORTABILITY_SUPPORTED_REGIONS,
  DATA_PORTABILITY_EXCLUDED_REGIONS,
  InitiatePortabilityArchiveResponse,
  PortabilityArchiveJobState,
  ExportedYouTubeMusicSong,
  DataPortabilityImportResult,
} from "./data-portability-types";
import { ProviderError } from "../../errors";
import { addTrackToLibrary } from "@/modules/library/library.service";
import { prisma } from "@/lib/db";
import {
  LibrarySourceProvenance,
  ProviderItemStatus,
  ProviderItemType,
  ProviderType,
} from "@prisma/client";

const DATA_PORTABILITY_API_BASE = "https://dataportability.googleapis.com/v1";

/**
 * Checks whether the user's geographic jurisdiction is authorized to invoke Google Data Portability.
 * Authorized: EEA, UK, Switzerland, and US.
 * Explicitly excluded: India (IN) and unsupported regions.
 */
export function isRegionSupportedForDataPortability(countryCode: string): boolean {
  if (!countryCode) return false;
  const upper = countryCode.trim().toUpperCase();

  if (DATA_PORTABILITY_EXCLUDED_REGIONS.has(upper)) {
    return false;
  }

  return DATA_PORTABILITY_SUPPORTED_REGIONS.has(upper);
}

/**
 * Validates a zip archive entry path against directory traversal (Zip-Slip vulnerability).
 */
export function isSafeZipEntryPath(entryPath: string): boolean {
  if (!entryPath || typeof entryPath !== "string") return false;

  // Disallow absolute paths
  if (entryPath.startsWith("/") || entryPath.startsWith("\\") || path.isAbsolute(entryPath)) {
    return false;
  }

  // Disallow parent traversal
  if (entryPath.includes("..")) {
    return false;
  }

  // Normalize and recheck
  const normalized = path.normalize(entryPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return false;
  }

  return true;
}

/**
 * Initiates an asynchronous Google Data Portability archive job for YouTube Music.
 * Enforces geographic gating and scope authorization.
 */
export async function initiateYouTubeMusicExport(
  accessToken: string,
  userCountryCode: string
): Promise<string> {
  if (!isRegionSupportedForDataPortability(userCountryCode)) {
    throw new ProviderError(
      "YOUTUBE_MUSIC",
      `Google Data Portability is not available in region "${userCountryCode}". Supported regions: EEA, UK, Switzerland, and US.`
    );
  }

  const url = `${DATA_PORTABILITY_API_BASE}/portabilityArchive:initiate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resources: ["YOUTUBE_MUSIC"],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new ProviderError(
      "YOUTUBE_MUSIC",
      `Failed to initiate Google Data Portability export (${res.status}): ${errText.slice(0, 250)}`
    );
  }

  const data = (await res.json()) as InitiatePortabilityArchiveResponse;
  if (!data?.archiveJobId) {
    throw new ProviderError("YOUTUBE_MUSIC", "Google Data Portability API did not return an archiveJobId.");
  }

  return data.archiveJobId;
}

/**
 * Checks the processing state of a Data Portability archive job.
 */
export async function getYouTubeMusicArchiveJobState(
  accessToken: string,
  archiveJobId: string
): Promise<PortabilityArchiveJobState> {
  const url = `${DATA_PORTABILITY_API_BASE}/archiveJobs/${encodeURIComponent(archiveJobId)}/portabilityArchiveState`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new ProviderError(
      "YOUTUBE_MUSIC",
      `Failed to query archive job status (${res.status}): ${errText.slice(0, 250)}`
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    archiveJobId,
    state: (data["state"] as PortabilityArchiveJobState["state"]) || "IN_PROGRESS",
    urls: (data["urls"] as string[]) || undefined,
    exportTime: (data["exportTime"] as string) || undefined,
    error: (data["error"] as PortabilityArchiveJobState["error"]) || undefined,
  };
}

/**
 * Parses in-memory zip archive buffer, safely decompressing entries while
 * enforcing Zip-Slip validation and a 50MB per-file decompression ceiling.
 */
export function extractEntriesFromZip(
  zipBuffer: Buffer,
  maxEntrySizeBytes = 50 * 1024 * 1024 // 50MB
): Array<{ path: string; content: Buffer }> {
  const entries: Array<{ path: string; content: Buffer }> = [];
  let offset = 0;

  while (offset + 30 <= zipBuffer.length) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      // Local file header signature not found (may have reached central directory)
      break;
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

    if (uncompressedSize > maxEntrySizeBytes) {
      throw new Error(`Zip entry exceeds maximum safe decompression size (${uncompressedSize} > ${maxEntrySizeBytes})`);
    }

    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const entryPath = zipBuffer.toString("utf8", fileNameStart, fileNameEnd);

    // Enforce Zip-Slip protection
    if (!isSafeZipEntryPath(entryPath)) {
      throw new Error(`Illegal path traversal detected in zip archive: "${entryPath}"`);
    }

    const dataStart = fileNameEnd + extraFieldLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBuffer.length) {
      break;
    }

    const compressedData = zipBuffer.subarray(dataStart, dataEnd);
    let decompressed: Buffer;

    if (compressionMethod === 0) {
      // Stored (no compression)
      decompressed = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      // Deflated
      decompressed = zlib.inflateRawSync(compressedData);
    } else {
      // Skip unsupported compression methods
      offset = dataEnd;
      continue;
    }

    if (!entryPath.endsWith("/")) {
      entries.push({ path: entryPath, content: decompressed });
    }

    offset = dataEnd;
  }

  return entries;
}

/**
 * Parses exported YouTube Music library CSV or JSON contents.
 */
export function parseExportedYouTubeMusicContent(
  content: string,
  fileName: string
): ExportedYouTubeMusicSong[] {
  const songs: ExportedYouTubeMusicSong[] = [];
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed) ? parsed : parsed.songs || parsed.tracks || [];

      for (const it of items) {
        const title = it.title || it.songTitle || it.name;
        const artist = it.artist || it.artistName || it.channelTitle || "Unknown Artist";
        if (title) {
          songs.push({
            title: String(title).trim(),
            artist: String(artist).trim(),
            album: it.album ? String(it.album).trim() : null,
            videoId: it.videoId ? String(it.videoId).trim() : undefined,
            isrc: it.isrc ? String(it.isrc).trim().toUpperCase() : null,
            playlistName: it.playlistName ? String(it.playlistName).trim() : undefined,
          });
        }
      }
    } catch {
      // JSON parse error
    }
  } else if (lowerName.endsWith(".csv")) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 1) {
      const headerLine = lines[0].toLowerCase();
      const headers = headerLine.split(",").map((h) => h.replace(/["']/g, "").trim());

      const titleIdx = headers.findIndex((h) => h.includes("title") || h.includes("song"));
      const artistIdx = headers.findIndex((h) => h.includes("artist"));
      const albumIdx = headers.findIndex((h) => h.includes("album"));
      const videoIdIdx = headers.findIndex((h) => h.includes("video") || h.includes("id"));
      const isrcIdx = headers.findIndex((h) => h.includes("isrc"));

      for (let i = 1; i < lines.length; i++) {
        // Simple CSV splitter
        const cols = lines[i].split(",").map((c) => c.replace(/^["']|["']$/g, "").trim());
        const title = titleIdx >= 0 ? cols[titleIdx] : "";
        const artist = artistIdx >= 0 ? cols[artistIdx] : "Unknown Artist";

        if (title) {
          songs.push({
            title,
            artist: artist || "Unknown Artist",
            album: albumIdx >= 0 ? cols[albumIdx] || null : null,
            videoId: videoIdIdx >= 0 ? cols[videoIdIdx] || undefined : undefined,
            isrc: isrcIdx >= 0 ? cols[isrcIdx] || null : null,
          });
        }
      }
    }
  }

  return songs;
}

export class YouTubeDataPortabilityService {
  /**
   * Processes a signed archive download URL, ingesting songs into the user's sovereign library.
   * Cleans up all buffers immediately in finally block.
   */
  public async processSignedArchive(
    signedUrl: string,
    userId: string,
    providerAccountId: string
  ): Promise<DataPortabilityImportResult> {
    let archiveBuffer: Buffer | null = null;
    let totalProcessed = 0;
    const totalSkipped = 0;
    let totalFailed = 0;
    let songsImported = 0;
    const playlistsImported = 0;

    try {
      const res = await fetch(signedUrl);
      if (!res.ok) {
        throw new ProviderError(
          "YOUTUBE_MUSIC",
          `Failed to download portability archive (${res.status}): ${res.statusText}`
        );
      }

      const arrayBuf = await res.arrayBuffer();
      archiveBuffer = Buffer.from(arrayBuf);

      const entries = extractEntriesFromZip(archiveBuffer);

      for (const entry of entries) {
        const textContent = entry.content.toString("utf8");
        const parsedSongs = parseExportedYouTubeMusicContent(textContent, entry.path);

        for (const song of parsedSongs) {
          try {
            await addTrackToLibrary(userId, {
              title: song.title,
              artistName: song.artist,
              albumName: song.album,
              durationMs: 0,
              isrc: song.isrc,
              sourceProvenance: LibrarySourceProvenance.YOUTUBE_MUSIC_IMPORT,
              providerSource: song.videoId
                ? {
                    provider: ProviderType.YOUTUBE_MUSIC,
                    externalId: song.videoId,
                    providerAccountId,
                    rawMetadata: {
                      source: "GOOGLE_DATA_PORTABILITY",
                      title: song.title,
                      artist: song.artist,
                    },
                  }
                : undefined,
            });

            if (song.videoId) {
              await prisma.providerLibraryItem.upsert({
                where: {
                  providerAccountId_itemType_externalId: {
                    providerAccountId,
                    itemType: ProviderItemType.TRACK,
                    externalId: song.videoId,
                  },
                },
                create: {
                  providerAccountId,
                  itemType: ProviderItemType.TRACK,
                  externalId: song.videoId,
                  status: ProviderItemStatus.ACTIVE,
                  syncedAt: new Date(),
                },
                update: {
                  status: ProviderItemStatus.ACTIVE,
                  syncedAt: new Date(),
                },
              });
            }

            totalProcessed++;
            songsImported++;
          } catch (err: unknown) {
            totalFailed++;
            console.error(`Failed to ingest portability track "${song.title}":`, err);
          }
        }
      }
    } finally {
      // Ephemeral cleanup: wipe in-memory buffer reference
      archiveBuffer = null;
    }

    return {
      totalProcessed,
      totalSkipped,
      totalFailed,
      songsImported,
      playlistsImported,
    };
  }
}

export const youTubeDataPortabilityService = new YouTubeDataPortabilityService();
