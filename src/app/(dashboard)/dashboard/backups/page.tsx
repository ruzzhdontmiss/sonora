"use client";

import { useState, useEffect } from "react";
import {
  HardDriveDownload,
  FileJson,
  ShieldCheck,
  Camera,
  RefreshCw,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from "lucide-react";

interface SnapshotItem {
  id: string;
  name: string;
  trigger: string;
  itemCount: number;
  createdAt: string;
}

interface RestorePreview {
  valid: boolean;
  version: string;
  totalTracksInBackup: number;
  newTracksToImport: number;
  existingTracksAlreadyInLibrary: number;
  totalPlaylistsInBackup: number;
  newPlaylistsToCreate: number;
  existingPlaylistsToUpdate: number;
}

export default function BackupsPage() {
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Restore state
  const [restorePayload, setRestorePayload] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreSuccess, setRestoreSuccess] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const fetchSnapshots = async () => {
    try {
      const res = await fetch("/api/backup/snapshots");
      if (res.ok) {
        const data = await res.json();
        setSnapshots(data.snapshots || []);
      }
    } catch {
      // Ignore initial fetch error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSnapshots();
  }, []);

  const handleCreateSnapshot = async () => {
    setCreating(true);
    setStatusMessage(null);
    try {
      const res = await fetch("/api/backup/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (res.ok) {
        setStatusMessage("Snapshot created successfully!");
        await fetchSnapshots();
      } else {
        const err = await res.json();
        setStatusMessage(`Failed: ${err.error || "Could not create snapshot"}`);
      }
    } catch {
      setStatusMessage("Failed to create snapshot");
    } finally {
      setCreating(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setRestoreError(null);
    setRestoreSuccess(null);
    setPreview(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        setRestorePayload(parsed);

        // Request dry-run preview
        setPreviewing(true);
        const res = await fetch("/api/backup/restore/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed),
        });

        if (res.ok) {
          const data = await res.json();
          setPreview(data.preview);
        } else {
          const err = await res.json();
          setRestoreError(err.error || "Failed to preview backup file");
        }
      } catch {
        setRestoreError("Uploaded file is not valid JSON.");
      } finally {
        setPreviewing(false);
      }
    };
    reader.readAsText(file);
  };

  const handleExecuteRestore = async () => {
    if (!restorePayload) return;

    setRestoring(true);
    setRestoreError(null);
    try {
      const res = await fetch("/api/backup/restore/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(restorePayload),
      });

      if (res.ok) {
        const data = await res.json();
        setRestoreSuccess(
          `Restored ${data.result.restoredTracksCount} tracks, ${data.result.restoredPlaylistsCount} playlists (${data.result.skippedExistingTracksCount} existing tracks safely reused).`
        );
        setPreview(null);
        setRestorePayload(null);
        await fetchSnapshots();
      } else {
        const err = await res.json();
        setRestoreError(err.error || "Failed to execute restore");
      }
    } catch {
      setRestoreError("Network error executing restore");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Library Backups & Portable Export
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Immutable JSON metadata snapshots, backup verification, and disaster recovery.
        </p>
      </div>

      {/* Snapshot and Export Action Controls */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Create Snapshot Card */}
        <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between space-y-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-950/50 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Create Snapshot</h2>
              <p className="text-xs text-gray-400">Capture point-in-time state of your library</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Saves an immutable snapshot with cryptographic SHA-256 integrity checksums to protect against accidental deletions.
          </p>
          <button
            onClick={handleCreateSnapshot}
            disabled={creating}
            className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs transition"
          >
            {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
            <span>{creating ? "Creating..." : "Create Library Snapshot"}</span>
          </button>
        </div>

        {/* Download Portable Export Card */}
        <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between space-y-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-950/50 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <HardDriveDownload className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Download Export</h2>
              <p className="text-xs text-gray-400">Self-contained JSON portable format</p>
            </div>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            Download your full canonical tracks, playlists, and cross-provider matches (Spotify, Apple Music, YouTube Music).
          </p>
          <a
            href="/api/backup/export"
            download
            className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-[#1f2438] hover:bg-[#282e47] text-white font-medium text-xs transition border border-gray-700/50"
          >
            <HardDriveDownload className="w-4 h-4 text-emerald-400" />
            <span>Download Portable JSON Backup</span>
          </a>
        </div>
      </div>

      {statusMessage && (
        <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 text-xs text-indigo-300">
          {statusMessage}
        </div>
      )}

      {/* Restore Section */}
      <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] space-y-6">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-amber-950/50 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Upload className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Restore from Backup</h2>
            <p className="text-xs text-gray-400">Dry-run preview diffing and idempotent restoration</p>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-[#090a0f] border border-[#1f2438] flex flex-col items-center justify-center space-y-3 text-center">
          <Upload className="w-8 h-8 text-gray-500" />
          <div>
            <label
              htmlFor="backup-file-upload"
              className="cursor-pointer font-semibold text-xs text-indigo-400 hover:text-indigo-300"
            >
              Choose a Sonora backup JSON file
            </label>
            <input
              id="backup-file-upload"
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              className="hidden"
            />
            <p className="text-[11px] text-gray-500 mt-1">Accepts sonora-export-v1 JSON archives</p>
          </div>
        </div>

        {previewing && (
          <div className="flex items-center space-x-2 text-xs text-amber-400">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Analyzing backup contents and computing preview diff...</span>
          </div>
        )}

        {preview && (
          <div className="p-4 rounded-2xl bg-[#090a0f] border border-amber-500/20 space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-gray-800 pb-3">
              <span className="font-semibold text-white">Dry-Run Preview Result</span>
              <span className="text-emerald-400 flex items-center space-x-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Verified Schema ({preview.version})</span>
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
              <div className="p-2.5 rounded-xl bg-[#12151f] border border-[#1f2438]">
                <div className="text-lg font-bold text-white">{preview.newTracksToImport}</div>
                <div className="text-[10px] text-gray-400 uppercase">New Tracks</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#12151f] border border-[#1f2438]">
                <div className="text-lg font-bold text-gray-300">{preview.existingTracksAlreadyInLibrary}</div>
                <div className="text-[10px] text-gray-400 uppercase">Existing Tracks</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#12151f] border border-[#1f2438]">
                <div className="text-lg font-bold text-white">{preview.newPlaylistsToCreate}</div>
                <div className="text-[10px] text-gray-400 uppercase">New Playlists</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#12151f] border border-[#1f2438]">
                <div className="text-lg font-bold text-gray-300">{preview.existingPlaylistsToUpdate}</div>
                <div className="text-[10px] text-gray-400 uppercase">Existing Playlists</div>
              </div>
            </div>

            <button
              onClick={handleExecuteRestore}
              disabled={restoring}
              className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium text-xs transition"
            >
              {restoring ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>{restoring ? "Restoring..." : "Apply Backup to Library"}</span>
            </button>
          </div>
        )}

        {restoreSuccess && (
          <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-300 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{restoreSuccess}</span>
          </div>
        )}

        {restoreError && (
          <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{restoreError}</span>
          </div>
        )}
      </div>

      {/* Snapshots History Table */}
      <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Clock className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-bold text-white">Snapshot History</h2>
          </div>
          <span className="text-xs text-gray-500">{snapshots.length} snapshots</span>
        </div>

        {loading ? (
          <div className="text-center py-6 text-xs text-gray-500">Loading snapshots...</div>
        ) : snapshots.length === 0 ? (
          <div className="text-center py-6 text-xs text-gray-500">
            No snapshots recorded yet. Click &quot;Create Library Snapshot&quot; above to capture one.
          </div>
        ) : (
          <div className="space-y-2">
            {snapshots.map((snap) => (
              <div
                key={snap.id}
                className="p-3 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-center justify-between text-xs"
              >
                <div className="space-y-0.5">
                  <div className="font-semibold text-white">{snap.name}</div>
                  <div className="text-[11px] text-gray-500 flex items-center space-x-2">
                    <span>{new Date(snap.createdAt).toLocaleString()}</span>
                    <span>•</span>
                    <span className="uppercase text-[10px] text-indigo-400 font-medium">
                      {snap.trigger}
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-4">
                  <div className="text-right">
                    <span className="font-medium text-gray-300">{snap.itemCount}</span>
                    <span className="text-[10px] text-gray-500 ml-1">items</span>
                  </div>
                  <a
                    href={`/api/backup/export?snapshotId=${snap.id}`}
                    download
                    className="p-1.5 rounded-lg bg-[#1f2438] hover:bg-gray-700 text-gray-300 hover:text-white transition"
                    title="Download this snapshot"
                  >
                    <HardDriveDownload className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Security and Redaction Guarantees */}
      <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] space-y-4">
        <h2 className="text-sm font-bold text-white">Security & Redaction Architecture</h2>
        <div className="space-y-3 text-xs text-gray-300">
          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <FileJson className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Versioned JSON Schema (sonora-export-v1)</p>
              <p className="text-gray-400 mt-0.5">
                Portable exports include canonical tracks, playlists with exact sequence ordering, and cross-provider catalog matches.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <ShieldCheck className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Zero Credential Leakage</p>
              <p className="text-gray-400 mt-0.5">
                Exports strictly exclude Google OAuth tokens, Spotify refresh secrets, passwords, encryption keys, and internal session IDs.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
