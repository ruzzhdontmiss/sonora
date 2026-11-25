/**
 * Type definitions for SONORA Library Snapshots, Portable Exports, and Restore (P5-T06, P5-T07).
 */

import { ProviderType, SnapshotTrigger } from "@prisma/client";

export const EXPORT_SCHEMA_VERSION = "sonora-export-v1";

export interface ExportTrackItem {
  id: string; // canonical track ID or export track reference
  title: string;
  artistName: string;
  albumName: string | null;
  durationMs: number;
  explicit: boolean;
  isrc: string | null;
  discNumber: number;
  trackNumber: number | null;
  addedAt?: string;
  matches: Array<{
    provider: ProviderType;
    externalId: string;
    providerUri?: string | null;
    confidence: number;
    reviewStatus: string;
  }>;
}

export interface ExportPlaylistItem {
  position: number;
  trackId: string;
  title: string;
  artistName: string;
  isrc: string | null;
}

export interface ExportPlaylist {
  id: string;
  title: string;
  description: string | null;
  isPublic: boolean;
  itemCount: number;
  items: ExportPlaylistItem[];
}

export interface SonoraPortableExport {
  version: typeof EXPORT_SCHEMA_VERSION;
  sonoraRelease: string;
  exportedAt: string;
  checksumSha256: string;
  userSummary: {
    userId: string;
    trackCount: number;
    playlistCount: number;
  };
  library: {
    tracks: ExportTrackItem[];
  };
  playlists: ExportPlaylist[];
}

export interface SnapshotMetadata {
  id: string;
  name: string;
  trigger: SnapshotTrigger;
  itemCount: number;
  checksumSha256?: string;
  createdAt: Date;
}

export interface RestorePreviewResult {
  valid: boolean;
  version: string;
  exportedAt: string;
  totalTracksInBackup: number;
  newTracksToImport: number;
  existingTracksAlreadyInLibrary: number;
  totalPlaylistsInBackup: number;
  newPlaylistsToCreate: number;
  existingPlaylistsToUpdate: number;
  sampleTracks: Array<{
    title: string;
    artistName: string;
    isrc: string | null;
    status: "NEW" | "ALREADY_PRESENT";
  }>;
  samplePlaylists: Array<{
    title: string;
    itemCount: number;
    status: "NEW" | "EXISTING";
  }>;
}

export interface RestoreExecutionResult {
  restoredTracksCount: number;
  skippedExistingTracksCount: number;
  restoredPlaylistsCount: number;
  restoredPlaylistItemsCount: number;
  totalErrors: number;
  errors: string[];
}
