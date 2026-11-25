import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isRegionSupportedForDataPortability,
  isSafeZipEntryPath,
  initiateYouTubeMusicExport,
  getYouTubeMusicArchiveJobState,
  parseExportedYouTubeMusicContent,
  extractEntriesFromZip,
} from "@/modules/providers/youtube/portability/data-portability.service";
import { ProviderError } from "@/modules/providers/errors";
import zlib from "zlib";

describe("Google Data Portability API Importer (P5-T04b)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Geographic Gating", () => {
    it("permits authorized jurisdictions (EEA, UK, Switzerland, US)", () => {
      expect(isRegionSupportedForDataPortability("US")).toBe(true);
      expect(isRegionSupportedForDataPortability("GB")).toBe(true);
      expect(isRegionSupportedForDataPortability("CH")).toBe(true);
      expect(isRegionSupportedForDataPortability("DE")).toBe(true);
      expect(isRegionSupportedForDataPortability("FR")).toBe(true);
      expect(isRegionSupportedForDataPortability("IE")).toBe(true);
      expect(isRegionSupportedForDataPortability("NO")).toBe(true);
    });

    it("explicitly denies India (IN) per regulatory scope restrictions", () => {
      expect(isRegionSupportedForDataPortability("IN")).toBe(false);
      expect(isRegionSupportedForDataPortability("in")).toBe(false);
    });

    it("denies unsupported non-EEA jurisdictions", () => {
      expect(isRegionSupportedForDataPortability("JP")).toBe(false);
      expect(isRegionSupportedForDataPortability("AU")).toBe(false);
      expect(isRegionSupportedForDataPortability("BR")).toBe(false);
      expect(isRegionSupportedForDataPortability("")).toBe(false);
    });
  });

  describe("Zip-Slip Vulnerability Protection", () => {
    it("allows standard safe relative paths within the archive", () => {
      expect(isSafeZipEntryPath("YouTube and YouTube Music/music-library-songs.csv")).toBe(true);
      expect(isSafeZipEntryPath("playlists/favorites.json")).toBe(true);
      expect(isSafeZipEntryPath("metadata.txt")).toBe(true);
    });

    it("detects and blocks directory traversal attempts", () => {
      expect(isSafeZipEntryPath("../etc/passwd")).toBe(false);
      expect(isSafeZipEntryPath("dir/../../malicious.sh")).toBe(false);
      expect(isSafeZipEntryPath("/var/log/system.log")).toBe(false);
      expect(isSafeZipEntryPath("..\\windows\\system32")).toBe(false);
      expect(isSafeZipEntryPath("")).toBe(false);
    });
  });

  describe("Export Initiation & Polling", () => {
    it("rejects initiation immediately for users in unsupported regions", async () => {
      await expect(
        initiateYouTubeMusicExport("mock-token", "IN")
      ).rejects.toThrow(ProviderError);
    });

    it("initiates archive job for authorized user in US", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          archiveJobId: "job-portability-xyz123",
        }),
      });

      const jobId = await initiateYouTubeMusicExport("mock-token", "US");
      expect(jobId).toBe("job-portability-xyz123");
    });

    it("polls archive state and returns signed download URLs", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          state: "COMPLETE",
          urls: ["https://storage.googleapis.com/takeout-signed-archive.zip"],
          exportTime: "2026-11-25T12:00:00Z",
        }),
      });

      const status = await getYouTubeMusicArchiveJobState("mock-token", "job-portability-xyz123");
      expect(status.state).toBe("COMPLETE");
      expect(status.urls).toHaveLength(1);
      expect(status.urls?.[0]).toContain("takeout-signed-archive.zip");
    });
  });

  describe("Content Parsing (CSV & JSON)", () => {
    it("parses exported Takeout CSV format", () => {
      const csv = `
Song Title,Artist Name,Album Title,Video ID,ISRC
Levitating,Dua Lipa,Future Nostalgia,vid123,GBAHT1901299
Blinding Lights,The Weeknd,After Hours,vid456,USUM71900123
      `.trim();

      const songs = parseExportedYouTubeMusicContent(csv, "music-library-songs.csv");
      expect(songs).toHaveLength(2);
      expect(songs[0].title).toBe("Levitating");
      expect(songs[0].artist).toBe("Dua Lipa");
      expect(songs[0].album).toBe("Future Nostalgia");
      expect(songs[0].videoId).toBe("vid123");
      expect(songs[0].isrc).toBe("GBAHT1901299");
    });

    it("parses exported Takeout JSON format", () => {
      const json = JSON.stringify([
        {
          songTitle: "Bad Romance",
          artistName: "Lady Gaga",
          album: "The Fame Monster",
          videoId: "vid789",
        },
      ]);

      const songs = parseExportedYouTubeMusicContent(json, "library.json");
      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe("Bad Romance");
      expect(songs[0].artist).toBe("Lady Gaga");
    });
  });

  describe("Zip Decompression with Safety Gates", () => {
    it("extracts safe uncompressed entries", () => {
      // Craft a simple uncompressed zip buffer in memory
      const fileName = Buffer.from("test.txt", "utf8");
      const fileData = Buffer.from("Hello Sonora Portability", "utf8");

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); // signature
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0, 8); // compression: 0 (stored)
      header.writeUInt32LE(fileData.length, 18); // compressed size
      header.writeUInt32LE(fileData.length, 22); // uncompressed size
      header.writeUInt16LE(fileName.length, 26); // file name length
      header.writeUInt16LE(0, 28); // extra field length

      const zipBuf = Buffer.concat([header, fileName, fileData]);
      const entries = extractEntriesFromZip(zipBuf);

      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe("test.txt");
      expect(entries[0].content.toString("utf8")).toBe("Hello Sonora Portability");
    });

    it("rejects zip entries attempting directory traversal", () => {
      const evilName = Buffer.from("../../../etc/passwd", "utf8");
      const fileData = Buffer.from("root:x:0:0", "utf8");

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(0, 8);
      header.writeUInt32LE(fileData.length, 18);
      header.writeUInt32LE(fileData.length, 22);
      header.writeUInt16LE(evilName.length, 26);
      header.writeUInt16LE(0, 28);

      const zipBuf = Buffer.concat([header, evilName, fileData]);

      expect(() => extractEntriesFromZip(zipBuf)).toThrow(/Illegal path traversal/i);
    });
  });
});
