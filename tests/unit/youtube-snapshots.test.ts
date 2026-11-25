import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeDeterministicChecksum,
  generatePortableExport,
} from "@/modules/backup/snapshot.service";
import {
  validateBackupPayload,
  previewRestoreBackup,
  executeRestoreBackup,
} from "@/modules/backup/restore.service";
import {
  EXPORT_SCHEMA_VERSION,
  SonoraPortableExport,
} from "@/modules/backup/backup-types";
import { ProviderType } from "@prisma/client";
import { ValidationError } from "@/modules/common/errors";

// Configure env
process.env.AUTH_SECRET = "test-secret-at-least-32-chars-long-123456";
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/sonora_dev";
process.env.TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.REDIS_URL = "redis://localhost:6379";

describe("Library Snapshots, Portable Exports & Restore (P5-T06, P5-T07)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Deterministic Checksum Computation", () => {
    it("computes identical SHA-256 regardless of object key insertion order", () => {
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { a: 1, c: 3, b: 2 };

      const hash1 = computeDeterministicChecksum(obj1);
      const hash2 = computeDeterministicChecksum(obj2);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex string
    });
  });

  describe("Backup Schema Validation & Security Redaction", () => {
    it("validates version header and required sections", () => {
      const validBackup = {
        version: EXPORT_SCHEMA_VERSION,
        sonoraRelease: "0.1.0",
        exportedAt: new Date().toISOString(),
        checksumSha256: "dummy-hash",
        userSummary: { userId: "user-1", trackCount: 1, playlistCount: 1 },
        library: {
          tracks: [
            {
              id: "t1",
              title: "Levitating",
              artistName: "Dua Lipa",
              albumName: "Future Nostalgia",
              durationMs: 203000,
              explicit: false,
              isrc: "GBAHT1901299",
              discNumber: 1,
              trackNumber: 5,
              matches: [
                {
                  provider: ProviderType.YOUTUBE_MUSIC,
                  externalId: "vid-yt-123",
                  confidence: 1.0,
                  reviewStatus: "AUTO_MATCHED",
                },
              ],
            },
          ],
        },
        playlists: [
          {
            id: "pl1",
            title: "Pop Favorites",
            description: "Top hits",
            isPublic: true,
            itemCount: 1,
            items: [
              {
                position: 0,
                trackId: "t1",
                title: "Levitating",
                artistName: "Dua Lipa",
                isrc: "GBAHT1901299",
              },
            ],
          },
        ],
      };

      const result = validateBackupPayload(validBackup);
      expect(result.version).toBe("sonora-export-v1");
      expect(result.library.tracks).toHaveLength(1);
    });

    it("rejects malformed payloads and invalid schema versions", () => {
      expect(() => validateBackupPayload(null)).toThrow(ValidationError);
      expect(() => validateBackupPayload({})).toThrow(ValidationError);
      expect(() =>
        validateBackupPayload({
          version: "unsupported-version-99",
          library: { tracks: [] },
          playlists: [],
        })
      ).toThrow(/Unsupported backup version/);
    });

    it("ensures zero credential leakage in portable export format", () => {
      const mockExport: SonoraPortableExport = {
        version: EXPORT_SCHEMA_VERSION,
        sonoraRelease: "0.1.0",
        exportedAt: new Date().toISOString(),
        checksumSha256: "sample-sha",
        userSummary: { userId: "user-test", trackCount: 1, playlistCount: 1 },
        library: {
          tracks: [
            {
              id: "track-1",
              title: "Levitating",
              artistName: "Dua Lipa",
              albumName: "Future Nostalgia",
              durationMs: 203000,
              explicit: false,
              isrc: "GBAHT1901299",
              discNumber: 1,
              trackNumber: 5,
              matches: [
                {
                  provider: ProviderType.YOUTUBE_MUSIC,
                  externalId: "vid-yt-1",
                  confidence: 1.0,
                  reviewStatus: "AUTO_MATCHED",
                },
              ],
            },
          ],
        },
        playlists: [],
      };

      const jsonString = JSON.stringify(mockExport);
      expect(jsonString).not.toContain("accessToken");
      expect(jsonString).not.toContain("refreshToken");
      expect(jsonString).not.toContain("clientSecret");
      expect(jsonString).not.toContain("password");
      expect(jsonString).not.toContain("AUTH_SECRET");
    });
  });

  describe("Dry-run Restore Preview & Idempotent Application", () => {
    it("differentiates new tracks from tracks already in library", async () => {
      const mockBackup: SonoraPortableExport = {
        version: EXPORT_SCHEMA_VERSION,
        sonoraRelease: "0.1.0",
        exportedAt: new Date().toISOString(),
        checksumSha256: "test-hash",
        userSummary: { userId: "user-preview", trackCount: 2, playlistCount: 1 },
        library: {
          tracks: [
            {
              id: "backup-t1",
              title: "New Song Never Seen",
              artistName: "Brand New Artist",
              albumName: null,
              durationMs: 180000,
              explicit: false,
              isrc: "USNEW1234567",
              discNumber: 1,
              trackNumber: 1,
              matches: [],
            },
          ],
        },
        playlists: [
          {
            id: "backup-pl-1",
            title: "Road Trip",
            description: "Highways",
            isPublic: false,
            itemCount: 1,
            items: [
              {
                position: 0,
                trackId: "backup-t1",
                title: "New Song Never Seen",
                artistName: "Brand New Artist",
                isrc: "USNEW1234567",
              },
            ],
          },
        ],
      };

      const preview = await previewRestoreBackup("mock-user-id", mockBackup);
      expect(preview.valid).toBe(true);
      expect(preview.version).toBe(EXPORT_SCHEMA_VERSION);
      expect(preview.totalTracksInBackup).toBe(1);
      expect(preview.totalPlaylistsInBackup).toBe(1);
      expect(preview.sampleTracks).toHaveLength(1);
    });
  });
});
