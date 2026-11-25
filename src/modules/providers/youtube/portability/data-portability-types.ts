/**
 * Type declarations and constants for Google Data Portability API (P5-T04b).
 *
 * Scope: https://www.googleapis.com/auth/dataportability.youtube.music
 * Restricted Scope requiring Tier 2/3 CASA assessment and annual re-verification.
 */

export type PortabilityState =
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "CANCELLED";

export interface InitiatePortabilityArchiveRequest {
  resources: string[]; // ["YOUTUBE_MUSIC"]
}

export interface InitiatePortabilityArchiveResponse {
  archiveJobId: string;
}

export interface PortabilityArchiveJobState {
  archiveJobId: string;
  state: PortabilityState;
  urls?: string[]; // Signed download URLs valid for 6 hours
  exportTime?: string;
  error?: {
    code: number;
    message: string;
  };
}

export interface ExportedYouTubeMusicSong {
  title: string;
  artist: string;
  album?: string | null;
  videoId?: string;
  isrc?: string | null;
  playlistName?: string;
}

// Supported jurisdictions for Google Data Portability
export const DATA_PORTABILITY_SUPPORTED_REGIONS = new Set([
  // United States
  "US",
  // United Kingdom
  "GB",
  // Switzerland
  "CH",
  // European Economic Area (EEA)
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
  "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO",
]);

export const DATA_PORTABILITY_EXCLUDED_REGIONS = new Set([
  "IN", // India explicitly excluded per Google regulatory terms
]);

export interface DataPortabilityImportResult {
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
  songsImported: number;
  playlistsImported: number;
}
