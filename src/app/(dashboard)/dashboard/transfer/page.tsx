"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeftRight,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  Loader2,
  RefreshCw,
  Check,
  Sparkles,
  Info,
  Clock,
  ListMusic,
  Heart,
  Ban,
} from "lucide-react";
import Link from "next/link";

type ProviderType = "SPOTIFY" | "APPLE_MUSIC";

interface ProviderAccountInfo {
  provider: ProviderType;
  displayName: string;
  status: string;
}

interface PlaylistOption {
  id: string;
  title: string;
  description?: string | null;
  trackCount: number;
}

interface MigrationPreviewItem {
  canonicalTrackId: string;
  title: string;
  artistName: string;
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  matchStatus: "EXACT" | "HIGH" | "NEEDS_REVIEW" | "UNMATCHED";
  confidence: number;
  matchedDestinationId?: string | null;
  conflictReason?: string | null;
}

interface LikedSongsSummary {
  total: number;
  matched: number;
  unmatched: number;
  destinationSemantic: string;
  requiredScope: string;
  warningNote?: string;
  untransferableItems: Array<{
    title: string;
    artistName: string;
    reason: string;
  }>;
}

interface MigrationPlan {
  sourceProvider: ProviderType;
  destinationProvider: ProviderType;
  totalItems: number;
  exactMatchesCount: number;
  highConfidenceCount: number;
  needsReviewCount: number;
  unmatchedCount: number;
  estimatedDurationSeconds: number;
  playlists: Array<{ id: string; title: string; trackCount: number }>;
  includesLikedSongs: boolean;
  likedSongsSummary?: LikedSongsSummary;
  sampleItems: MigrationPreviewItem[];
}

interface ActiveJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt?: string | null;
  completedAt?: string | null;
  checkpoint?: Record<string, unknown> | null;
  operations?: Array<{
    id: string;
    itemType: string;
    sourceId: string;
    targetId?: string | null;
    status: string;
    errorMessage?: string | null;
  }>;
}

export default function TransferPage() {
  // Provider connections
  const [connections, setConnections] = useState<{
    spotify: ProviderAccountInfo | null;
    apple: ProviderAccountInfo | null;
  }>({ spotify: null, apple: null });
  const [loadingConnections, setLoadingConnections] = useState(true);

  // Form selections
  const [sourceProvider, setSourceProvider] = useState<ProviderType>("SPOTIFY");
  const [destinationProvider, setDestinationProvider] = useState<ProviderType>("APPLE_MUSIC");
  const [userPlaylists, setUserPlaylists] = useState<PlaylistOption[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState<string[]>([]);
  const [migrateLikedSongs, setMigrateLikedSongs] = useState(false);

  // Preview state
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewPlan, setPreviewPlan] = useState<MigrationPlan | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Explicit confirmation gate
  const [confirmed, setConfirmed] = useState(false);

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Load connection status
  const loadConnections = useCallback(async () => {
    setLoadingConnections(true);
    try {
      const res = await fetch("/api/connections/status");
      const data = await res.json();
      if (res.ok) {
        setConnections({
          spotify: data.spotify?.account || null,
          apple: data.apple?.account || null,
        });
      }
    } catch (err) {
      console.error("Failed to load connection status:", err);
    } finally {
      setLoadingConnections(false);
    }
  }, []);

  // Load user playlists
  const loadPlaylists = useCallback(async () => {
    setLoadingPlaylists(true);
    try {
      const res = await fetch("/api/playlists?limit=100");
      const data = await res.json();
      if (res.ok && data.playlists) {
        setUserPlaylists(
          data.playlists.map(
            (p: {
              id: string;
              title: string;
              description?: string | null;
              _count?: { items: number };
              items?: unknown[];
            }) => ({
              id: p.id,
              title: p.title,
              description: p.description,
              trackCount: p._count?.items ?? p.items?.length ?? 0,
            })
          )
        );
      }
    } catch (err) {
      console.error("Failed to load playlists:", err);
    } finally {
      setLoadingPlaylists(false);
    }
  }, []);

  useEffect(() => {
    loadConnections();
    loadPlaylists();
  }, [loadConnections, loadPlaylists]);

  // Adjust destination provider when source changes
  const handleSourceChange = (newSource: ProviderType) => {
    setSourceProvider(newSource);
    setDestinationProvider(newSource === "SPOTIFY" ? "APPLE_MUSIC" : "SPOTIFY");
    setPreviewPlan(null);
    setConfirmed(false);
  };

  // Toggle playlist selection
  const togglePlaylist = (id: string) => {
    setSelectedPlaylistIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
    setPreviewPlan(null);
    setConfirmed(false);
  };

  const selectAllPlaylists = () => {
    setSelectedPlaylistIds(userPlaylists.map((p) => p.id));
    setPreviewPlan(null);
    setConfirmed(false);
  };

  const deselectAllPlaylists = () => {
    setSelectedPlaylistIds([]);
    setPreviewPlan(null);
    setConfirmed(false);
  };

  // Request Migration Preview
  const handleGeneratePreview = async () => {
    if (selectedPlaylistIds.length === 0 && !migrateLikedSongs) {
      setPreviewError("Please select at least one playlist or include Liked Songs to transfer.");
      return;
    }

    setGeneratingPreview(true);
    setPreviewError(null);
    setConfirmed(false);

    try {
      const res = await fetch("/api/migration/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProvider,
          destinationProvider,
          playlistIds: selectedPlaylistIds,
          migrateLikedSongs,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate migration preview");
      }

      setPreviewPlan(data.plan);
    } catch (err: unknown) {
      setPreviewError(err instanceof Error ? err.message : "Failed to generate preview");
    } finally {
      setGeneratingPreview(false);
    }
  };

  // Execute Migration Job
  const handleExecuteMigration = async () => {
    if (!confirmed) {
      setJobError("You must explicitly confirm the migration preview before starting.");
      return;
    }

    setExecuting(true);
    setJobError(null);

    try {
      const res = await fetch("/api/migration/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceProvider,
          destinationProvider,
          playlistIds: selectedPlaylistIds,
          migrateLikedSongs,
          confirmed: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to initiate migration job");
      }

      setActiveJob(data.job);
    } catch (err: unknown) {
      setJobError(err instanceof Error ? err.message : "Failed to execute migration");
    } finally {
      setExecuting(false);
    }
  };

  // Poll active migration job status
  useEffect(() => {
    if (!activeJob?.id) return;
    if (activeJob.status === "COMPLETED" || activeJob.status === "FAILED" || activeJob.status === "CANCELLED") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/migration/${activeJob.id}`);
        const data = await res.json();
        if (res.ok && data.job) {
          setActiveJob(data.job);
        }
      } catch (err) {
        console.error("Failed to poll migration status:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeJob?.id, activeJob?.status]);

  // Cancel Job
  const handleCancelJob = async () => {
    if (!activeJob?.id) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/migration/${activeJob.id}`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.job) {
        setActiveJob(data.job);
      }
    } catch (err) {
      console.error("Failed to cancel migration job:", err);
    } finally {
      setCancelling(false);
    }
  };

  const isSourceConnected =
    sourceProvider === "SPOTIFY" ? Boolean(connections.spotify) : Boolean(connections.apple);
  const isDestConnected =
    destinationProvider === "SPOTIFY" ? Boolean(connections.spotify) : Boolean(connections.apple);

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white flex items-center space-x-3">
          <ArrowLeftRight className="w-6 h-6 text-indigo-400" />
          <span>Cross-Provider Library Transfer</span>
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Deterministic cross-platform playlist and library migration engine with preview-first safety.
        </p>
      </div>

      {/* Active Job Overlay / Monitor */}
      {activeJob && (
        <div className="p-6 rounded-2xl bg-[#12151f] border border-indigo-500/30 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {activeJob.status === "RUNNING" || activeJob.status === "QUEUED" ? (
                <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center animate-spin">
                  <RefreshCw className="w-5 h-5" />
                </div>
              ) : activeJob.status === "COMPLETED" ? (
                <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
              ) : activeJob.status === "CANCELLED" ? (
                <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
                  <Ban className="w-5 h-5" />
                </div>
              ) : (
                <div className="w-9 h-9 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              )}
              <div>
                <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                  <span>Transfer Job {activeJob.status}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[#1e2337] text-gray-400 font-mono">
                    {activeJob.id.slice(0, 8)}
                  </span>
                </h3>
                <p className="text-xs text-gray-400">
                  {activeJob.status === "QUEUED" && "Waiting in durable outbox queue..."}
                  {activeJob.status === "RUNNING" && "Writing playlists and tracks to destination provider..."}
                  {activeJob.status === "COMPLETED" && (
                    Boolean((activeJob.checkpoint as Record<string, unknown> | null)?.pendingCloudLibrarySync) ||
                    activeJob.operations?.some((op) => op.errorMessage?.includes("ACCEPTED_PENDING") || op.errorMessage?.includes("HTTP 202"))
                      ? "Transfer accepted by Apple Music (HTTP 202). Songs are queued for Cloud Library ingestion and are propagating across your devices."
                      : "Transfer completed successfully with destination read-back verification."
                  )}
                  {activeJob.status === "CANCELLED" && "Transfer was safely cancelled. No further writes will occur."}
                  {activeJob.status === "FAILED" && `Transfer failed: ${activeJob.checkpoint?.error || "Unknown error"}`}
                </p>
              </div>
            </div>

            {(activeJob.status === "RUNNING" || activeJob.status === "QUEUED") && (
              <button
                onClick={handleCancelJob}
                disabled={cancelling}
                className="px-3.5 py-1.5 rounded-xl bg-rose-950/40 text-rose-300 border border-rose-800/40 hover:bg-rose-900/60 transition text-xs font-medium flex items-center space-x-1.5"
              >
                {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                <span>Cancel Transfer</span>
              </button>
            )}
          </div>

          {/* Progress bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-gray-400">
              <span>
                Processed {activeJob.processedItems} of {activeJob.totalItems} tracks
              </span>
              <span>
                {activeJob.totalItems > 0
                  ? Math.round((activeJob.processedItems / activeJob.totalItems) * 100)
                  : 0}
                %
              </span>
            </div>
            <div className="w-full h-2 rounded-full bg-[#0a0c13] overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  activeJob.status === "COMPLETED"
                    ? "bg-emerald-500"
                    : activeJob.status === "FAILED"
                    ? "bg-rose-500"
                    : activeJob.status === "CANCELLED"
                    ? "bg-amber-500"
                    : "bg-indigo-500"
                }`}
                style={{
                  width: `${
                    activeJob.totalItems > 0
                      ? Math.min(100, Math.round((activeJob.processedItems / activeJob.totalItems) * 100))
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>

          {activeJob.failedItems > 0 && (
            <div className="text-xs text-amber-400 bg-amber-950/20 border border-amber-800/30 px-3 py-2 rounded-xl flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>
                {activeJob.failedItems} tracks were omitted or unmatched on destination platform.
              </span>
            </div>
          )}

          {/* Operations Breakdown */}
          {activeJob.operations && activeJob.operations.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-[#1f2438]">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                Transfer Operations Detail
              </span>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {activeJob.operations.map((op) => {
                  const isAccepted = op.errorMessage?.includes("HTTP 202") || op.errorMessage?.includes("Accepted");
                  return (
                    <div
                      key={op.id}
                      className="flex items-center justify-between p-2.5 rounded-xl bg-[#0a0c13] border border-[#1f2438] text-xs"
                    >
                      <div className="flex items-center space-x-2">
                        {op.itemType === "LIKED_SONGS" ? (
                          <Heart className="w-3.5 h-3.5 text-rose-400" />
                        ) : (
                          <ListMusic className="w-3.5 h-3.5 text-indigo-400" />
                        )}
                        <span className="font-medium text-white">
                          {op.itemType === "LIKED_SONGS" ? "Liked Songs Library" : `Playlist (${op.targetId || op.sourceId})`}
                        </span>
                        {isAccepted && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-950/60 text-purple-300 border border-purple-800/40">
                            Accepted (Syncing)
                          </span>
                        )}
                      </div>
                      <div className="flex items-center space-x-2">
                        {isAccepted ? (
                          <span className="text-purple-300 flex items-center space-x-1 font-medium">
                            <Clock className="w-3 h-3 animate-pulse" />
                            <span>Accepted (Syncing)</span>
                          </span>
                        ) : op.status === "SUCCESS" ? (
                          <span className="text-emerald-400 flex items-center space-x-1 font-medium">
                            <Check className="w-3 h-3" />
                            <span>Verified</span>
                          </span>
                        ) : op.status === "WARNING" ? (
                          <span className="text-amber-400 flex items-center space-x-1 font-medium">
                            <AlertTriangle className="w-3 h-3" />
                            <span>Partial</span>
                          </span>
                        ) : op.status === "ERROR" ? (
                          <span className="text-rose-400 flex items-center space-x-1 font-medium">
                            <Ban className="w-3 h-3" />
                            <span>Failed</span>
                          </span>
                        ) : (
                          <span className="text-indigo-400 flex items-center space-x-1 font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Writing...</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeJob.status === "COMPLETED" && (
            <div className="pt-2 flex justify-end">
              <button
                onClick={() => {
                  setActiveJob(null);
                  setPreviewPlan(null);
                  setConfirmed(false);
                }}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                Start Another Transfer
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 1: Provider Direction Selection */}
      <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] space-y-5">
        <h2 className="text-base font-semibold text-white flex items-center space-x-2">
          <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-400 text-xs font-bold flex items-center justify-center">
            1
          </span>
          <span>Select Transfer Direction</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Source */}
          <div className="p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] space-y-3">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Source Service
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleSourceChange("SPOTIFY")}
                className={`flex-1 p-3 rounded-xl border flex items-center justify-between text-sm font-medium transition ${
                  sourceProvider === "SPOTIFY"
                    ? "bg-[#18281e] border-emerald-500/50 text-emerald-300"
                    : "bg-[#12151f] border-[#1f2438] text-gray-400 hover:text-white"
                }`}
              >
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-500" />
                  <span>Spotify</span>
                </div>
                {sourceProvider === "SPOTIFY" && <Check className="w-4 h-4 text-emerald-400" />}
              </button>

              <button
                type="button"
                onClick={() => handleSourceChange("APPLE_MUSIC")}
                className={`flex-1 p-3 rounded-xl border flex items-center justify-between text-sm font-medium transition ${
                  sourceProvider === "APPLE_MUSIC"
                    ? "bg-[#28181e] border-rose-500/50 text-rose-300"
                    : "bg-[#12151f] border-[#1f2438] text-gray-400 hover:text-white"
                }`}
              >
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500" />
                  <span>Apple Music</span>
                </div>
                {sourceProvider === "APPLE_MUSIC" && <Check className="w-4 h-4 text-rose-400" />}
              </button>
            </div>
            {!isSourceConnected && !loadingConnections && (
              <p className="text-xs text-amber-400 flex items-center space-x-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>
                  Source {sourceProvider} not connected. Visit{" "}
                  <Link href="/dashboard/connections" className="underline font-semibold">
                    Connections
                  </Link>
                  .
                </span>
              </p>
            )}
          </div>

          {/* Destination */}
          <div className="p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] space-y-3">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Destination Service
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setDestinationProvider("SPOTIFY");
                  setSourceProvider("APPLE_MUSIC");
                  setPreviewPlan(null);
                  setConfirmed(false);
                }}
                className={`flex-1 p-3 rounded-xl border flex items-center justify-between text-sm font-medium transition ${
                  destinationProvider === "SPOTIFY"
                    ? "bg-[#18281e] border-emerald-500/50 text-emerald-300"
                    : "bg-[#12151f] border-[#1f2438] text-gray-400 hover:text-white"
                }`}
              >
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-500" />
                  <span>Spotify</span>
                </div>
                {destinationProvider === "SPOTIFY" && <Check className="w-4 h-4 text-emerald-400" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  setDestinationProvider("APPLE_MUSIC");
                  setSourceProvider("SPOTIFY");
                  setPreviewPlan(null);
                  setConfirmed(false);
                }}
                className={`flex-1 p-3 rounded-xl border flex items-center justify-between text-sm font-medium transition ${
                  destinationProvider === "APPLE_MUSIC"
                    ? "bg-[#28181e] border-rose-500/50 text-rose-300"
                    : "bg-[#12151f] border-[#1f2438] text-gray-400 hover:text-white"
                }`}
              >
                <div className="flex items-center space-x-2">
                  <div className="w-3 h-3 rounded-full bg-rose-500" />
                  <span>Apple Music</span>
                </div>
                {destinationProvider === "APPLE_MUSIC" && <Check className="w-4 h-4 text-rose-400" />}
              </button>
            </div>
            {!isDestConnected && !loadingConnections && (
              <p className="text-xs text-amber-400 flex items-center space-x-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>
                  Destination {destinationProvider} not connected. Visit{" "}
                  <Link href="/dashboard/connections" className="underline font-semibold">
                    Connections
                  </Link>
                  .
                </span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Step 2: Content Selection */}
      <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white flex items-center space-x-2">
            <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-400 text-xs font-bold flex items-center justify-center">
              2
            </span>
            <span>Choose Playlists & Library Content</span>
          </h2>

          <div className="flex space-x-2 text-xs">
            <button
              onClick={selectAllPlaylists}
              className="text-indigo-400 hover:text-indigo-300 font-medium"
            >
              Select All
            </button>
            <span className="text-gray-600">|</span>
            <button
              onClick={deselectAllPlaylists}
              className="text-gray-400 hover:text-gray-300 font-medium"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Liked Songs Toggle */}
        <div className="p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-pink-500/20 text-pink-400 flex items-center justify-center">
              <Heart className="w-4 h-4 fill-pink-400/20" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">Include Liked / Saved Songs</p>
              <p className="text-xs text-gray-400">
                Transfer your saved library tracks to {destinationProvider === "SPOTIFY" ? "Spotify Liked Songs" : "Apple Music Cloud Library"}.
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            checked={migrateLikedSongs}
            onChange={(e) => {
              setMigrateLikedSongs(e.target.checked);
              setPreviewPlan(null);
              setConfirmed(false);
            }}
            className="w-5 h-5 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
          />
        </div>

        {/* Playlists List */}
        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
          {loadingPlaylists ? (
            <div className="p-6 text-center text-xs text-gray-400 flex items-center justify-center space-x-2">
              <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
              <span>Loading playlists...</span>
            </div>
          ) : userPlaylists.length === 0 ? (
            <div className="p-6 text-center text-xs text-gray-400 bg-[#090a0f] rounded-xl border border-[#1f2438]">
              No canonical playlists found. Import from Spotify or Apple Music first.
            </div>
          ) : (
            userPlaylists.map((pl) => (
              <div
                key={pl.id}
                onClick={() => togglePlaylist(pl.id)}
                className={`p-3.5 rounded-xl border cursor-pointer transition flex items-center justify-between ${
                  selectedPlaylistIds.includes(pl.id)
                    ? "bg-indigo-950/20 border-indigo-500/40 text-white"
                    : "bg-[#090a0f] border-[#1f2438] text-gray-300 hover:border-gray-700"
                }`}
              >
                <div className="flex items-center space-x-3">
                  <ListMusic className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{pl.title}</p>
                    <p className="text-xs text-gray-500">{pl.trackCount} tracks</p>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={selectedPlaylistIds.includes(pl.id)}
                  onChange={() => {}} // Handled by parent div onClick
                  className="w-4 h-4 rounded border-gray-700 bg-gray-900 text-indigo-600 pointer-events-none"
                />
              </div>
            ))
          )}
        </div>

        {/* Preview Button */}
        <div className="pt-2 flex justify-end">
          <button
            onClick={handleGeneratePreview}
            disabled={
              generatingPreview ||
              (!migrateLikedSongs && selectedPlaylistIds.length === 0) ||
              !isSourceConnected ||
              !isDestConnected
            }
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center space-x-2 shadow-lg shadow-indigo-600/20 transition"
          >
            {generatingPreview ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Simulating Matches & Writes...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Generate Transfer Preview</span>
              </>
            )}
          </button>
        </div>

        {previewError && (
          <div className="p-3.5 rounded-xl bg-rose-950/30 border border-rose-800/40 text-xs text-rose-300 flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{previewError}</span>
          </div>
        )}
      </div>

      {/* Step 3: Preview Inspection & Confirmation Gate */}
      {previewPlan && (
        <div className="p-6 rounded-2xl bg-[#12151f] border border-indigo-500/30 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white flex items-center space-x-2">
              <span className="w-6 h-6 rounded-lg bg-indigo-500/20 text-indigo-400 text-xs font-bold flex items-center justify-center">
                3
              </span>
              <span>Inspect Transfer Preview</span>
            </h2>
            <div className="flex items-center space-x-1.5 text-xs text-gray-400">
              <Clock className="w-3.5 h-3.5" />
              <span>Est. time: ~{previewPlan.estimatedDurationSeconds}s</span>
            </div>
          </div>

          {/* Metrics Overview */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="p-3 rounded-xl bg-[#090a0f] border border-[#1f2438]">
              <span className="text-xs text-gray-400">Total Items</span>
              <p className="text-xl font-bold text-white mt-1">{previewPlan.totalItems}</p>
            </div>
            <div className="p-3 rounded-xl bg-[#090a0f] border border-emerald-500/20">
              <span className="text-xs text-emerald-400">Exact Matches</span>
              <p className="text-xl font-bold text-emerald-300 mt-1">
                {previewPlan.exactMatchesCount}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-[#090a0f] border border-blue-500/20">
              <span className="text-xs text-blue-400">High Confidence</span>
              <p className="text-xl font-bold text-blue-300 mt-1">
                {previewPlan.highConfidenceCount}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-[#090a0f] border border-amber-500/20">
              <span className="text-xs text-amber-400">Needs Review</span>
              <p className="text-xl font-bold text-amber-300 mt-1">
                {previewPlan.needsReviewCount}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-[#090a0f] border border-rose-500/20">
              <span className="text-xs text-rose-400">Unmatched</span>
              <p className="text-xl font-bold text-rose-300 mt-1">
                {previewPlan.unmatchedCount}
              </p>
            </div>
          </div>

          {previewPlan.needsReviewCount > 0 && (
            <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/40 text-xs text-amber-300 flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>
                  {previewPlan.needsReviewCount} tracks have ambiguous matches or conflict flags.
                </span>
              </div>
              <Link
                href="/dashboard/matching"
                className="underline font-semibold hover:text-amber-200"
              >
                Resolve Matches First →
              </Link>
            </div>
          )}

          {/* Liked Songs Semantics Card */}
          {previewPlan.likedSongsSummary && (
            <div className="p-4 rounded-xl bg-[#0d101a] border border-indigo-500/20 space-y-2">
              <div className="flex items-center space-x-2 text-xs font-semibold text-indigo-300">
                <Info className="w-4 h-4" />
                <span>Provider Liked Songs Capability Notice</span>
              </div>
              <p className="text-xs text-gray-300 leading-relaxed">
                Target Operation:{" "}
                <span className="font-mono text-indigo-400">
                  {previewPlan.likedSongsSummary.destinationSemantic}
                </span>
                . Required scope: {previewPlan.likedSongsSummary.requiredScope}.
              </p>
              {previewPlan.likedSongsSummary.warningNote && (
                <p className="text-xs text-amber-400/90 leading-relaxed">
                  {previewPlan.likedSongsSummary.warningNote}
                </p>
              )}
              {previewPlan.likedSongsSummary.unmatched > 0 && (
                <p className="text-xs text-rose-400">
                  ⚠️ {previewPlan.likedSongsSummary.unmatched} liked songs have no catalog match on{" "}
                  {previewPlan.destinationProvider} and cannot be saved.
                </p>
              )}
            </div>
          )}

          {/* Sample preview items */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Sample Tracks Preview
            </h3>
            <div className="border border-[#1f2438] rounded-xl overflow-hidden bg-[#090a0f]">
              <table className="w-full text-left text-xs text-gray-300">
                <thead className="bg-[#12151f] text-gray-400 border-b border-[#1f2438]">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Track</th>
                    <th className="py-2.5 px-4 font-medium">Artist</th>
                    <th className="py-2.5 px-4 font-medium">Match Status</th>
                    <th className="py-2.5 px-4 font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2438]">
                  {previewPlan.sampleItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-[#12151f]/50">
                      <td className="py-2.5 px-4 font-medium text-white">{item.title}</td>
                      <td className="py-2.5 px-4 text-gray-400">{item.artistName}</td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`px-2 py-0.5 rounded-full font-medium ${
                            item.matchStatus === "EXACT"
                              ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40"
                              : item.matchStatus === "HIGH"
                              ? "bg-blue-950/60 text-blue-400 border border-blue-800/40"
                              : item.matchStatus === "NEEDS_REVIEW"
                              ? "bg-amber-950/60 text-amber-400 border border-amber-800/40"
                              : "bg-rose-950/60 text-rose-400 border border-rose-800/40"
                          }`}
                        >
                          {item.matchStatus}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-gray-400">
                        {item.confidence > 0 ? `${Math.round(item.confidence * 100)}%` : "N/A"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Explicit Confirmation Gate */}
          <div className="pt-4 border-t border-[#1f2438] space-y-4">
            <label className="flex items-start space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="w-5 h-5 mt-0.5 rounded border-gray-700 bg-gray-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span className="text-xs text-gray-300 leading-relaxed select-none">
                <strong className="text-white">Pre-Flight Write Confirmation:</strong> I have
                inspected the transfer preview above. I authorize SONORA to create playlists and
                write matched tracks into my {previewPlan.destinationProvider} account. I understand
                that unmatched tracks will be omitted, and order and repeated tracks will be preserved.
              </span>
            </label>

            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-gray-500 flex items-center space-x-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Deterministic writes with read-back verification</span>
              </div>

              <button
                onClick={handleExecuteMigration}
                disabled={!confirmed || executing}
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center space-x-2 shadow-lg shadow-emerald-600/20 transition"
              >
                {executing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Initiating Transfer...</span>
                  </>
                ) : (
                  <>
                    <ArrowLeftRight className="w-4 h-4" />
                    <span>Execute Migration ({previewPlan.totalItems} tracks)</span>
                  </>
                )}
              </button>
            </div>

            {jobError && (
              <div className="p-3.5 rounded-xl bg-rose-950/30 border border-rose-800/40 text-xs text-rose-300 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{jobError}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}