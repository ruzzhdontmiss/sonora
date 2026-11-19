"use client";

import { useEffect, useState, useCallback, useTransition } from "react";
import {
  Radio,
  AlertTriangle,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  PowerOff,
  DownloadCloud,
  ExternalLink,
  Lock,
  Loader2,
  Clock,
  Music2,
} from "lucide-react";

interface ProviderAccountInfo {
  id: string;
  provider: "SPOTIFY" | "APPLE_MUSIC" | "YOUTUBE_MUSIC";
  providerUserId: string;
  displayName: string;
  email: string | null;
  status: string;
  scopes: string[];
  updatedAt: string;
}

interface SyncJobInfo {
  id: string;
  jobType: string;
  sourceProvider: string;
  targetProvider: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface ProviderStatusData {
  spotify: {
    isConfigured: boolean;
    missingVariables: string[];
    connectedAccount: ProviderAccountInfo | null;
    lastImportJob: SyncJobInfo | null;
  };
  appleMusic: {
    isConfigured: boolean;
    missingVariables: string[];
    connectedAccount: ProviderAccountInfo | null;
    lastImportJob: SyncJobInfo | null;
  };
  youtubeMusic: {
    isConfigured: boolean;
    missingVariables: string[];
    connectedAccount: ProviderAccountInfo | null;
    lastImportJob: SyncJobInfo | null;
    note: string;
  };
}

declare global {
  interface Window {
    MusicKit?: {
      configure: (config: {
        developerToken: string;
        app: { name: string; build: string };
      }) => Promise<unknown>;
      getInstance: () => {
        authorize: () => Promise<string>;
      };
    };
  }
}

export default function ConnectionsPage() {
  const [data, setData] = useState<ProviderStatusData | null>(null);
  const [recentJobs, setRecentJobs] = useState<SyncJobInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [importingProvider, setImportingProvider] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, jobsRes] = await Promise.all([
        fetch("/api/connections/status"),
        fetch("/api/connections/sync-jobs"),
      ]);

      if (statusRes.ok) {
        const json = await statusRes.json();
        setData(json);
      }
      if (jobsRes.ok) {
        const json = await jobsRes.json();
        setRecentJobs(json.syncJobs || []);
      }
    } catch (err: unknown) {
      console.error("Failed to load connection status:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();

    // Check URL parameters for OAuth redirects
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const connected = url.searchParams.get("connected");
      const error = url.searchParams.get("error");

      if (connected === "spotify") {
        setActionSuccess("Successfully connected Spotify! Ready to import playlists and saved tracks.");
        window.history.replaceState({}, "", "/dashboard/connections");
      }
      if (error) {
        setActionError(decodeURIComponent(error));
        window.history.replaceState({}, "", "/dashboard/connections");
      }
    }

    // Polling interval if any job is QUEUED or RUNNING
    const interval = setInterval(() => {
      loadStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, [loadStatus]);

  const handleConnectSpotify = () => {
    window.location.href = "/api/connections/spotify/authorize";
  };

  const handleConnectAppleMusic = async () => {
    setActionError(null);
    try {
      // 1. Get developer token from server
      const tokenRes = await fetch("/api/connections/apple/developer-token");
      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch Apple Music developer token.");
      }
      const { developerToken } = await tokenRes.json();

      // 2. Load MusicKit JS if not present
      if (!window.MusicKit) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load Apple MusicKit JS SDK."));
          document.head.appendChild(script);
        });
      }

      // 3. Configure MusicKit
      await window.MusicKit!.configure({
        developerToken,
        app: {
          name: "SONORA Music Portability",
          build: "1.0.0",
        },
      });

      const musicKit = window.MusicKit!.getInstance();
      const musicUserToken = await musicKit.authorize();

      if (!musicUserToken) {
        throw new Error("Authorization cancelled or Music User Token was not granted.");
      }

      // 4. Send MUT to server
      const authRes = await fetch("/api/connections/apple/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ musicUserToken }),
      });

      if (!authRes.ok) {
        const err = await authRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to complete Apple Music authorization.");
      }

      setActionSuccess("Successfully authorized Apple Music! Ready to import your library.");
      startTransition(() => {
        loadStatus();
      });
    } catch (err: unknown) {
      console.error("Apple Music authorization error:", err);
      setActionError(err instanceof Error ? err.message : "Failed to connect Apple Music.");
    }
  };

  const handleTriggerImport = async (providerAccountId: string, providerName: string) => {
    setActionError(null);
    setActionSuccess(null);
    setImportingProvider(providerName);

    try {
      const res = await fetch("/api/connections/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAccountId }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Failed to trigger import for ${providerName}.`);
      }

      setActionSuccess(
        `Import job for ${providerName} queued successfully. Progress will update automatically.`
      );
      await loadStatus();
    } catch (err: unknown) {
      console.error("Import error:", err);
      setActionError(err instanceof Error ? err.message : "Failed to trigger library import.");
    } finally {
      setImportingProvider(null);
    }
  };

  const handleDisconnect = async (providerAccountId: string, provider: "SPOTIFY" | "APPLE_MUSIC") => {
    if (!confirm(`Are you sure you want to disconnect? Your sovereign canonical library and playlists will NOT be deleted.`)) {
      return;
    }

    setActionError(null);
    setActionSuccess(null);
    setDisconnectingId(providerAccountId);

    try {
      const endpoint =
        provider === "SPOTIFY"
          ? "/api/connections/spotify/disconnect"
          : "/api/connections/apple/disconnect";

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAccountId }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to disconnect provider.");
      }

      setActionSuccess("Provider disconnected successfully. Your canonical library remains intact.");
      await loadStatus();
    } catch (err: unknown) {
      console.error("Disconnect error:", err);
      setActionError(err instanceof Error ? err.message : "Failed to disconnect account.");
    } finally {
      setDisconnectingId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center space-y-3 text-gray-400">
          <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
          <p className="text-sm">Loading streaming provider connections...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Streaming Provider Connections</h1>
        <p className="mt-1 text-sm text-gray-400">
          Connect your streaming services using official APIs to import playlists and saved tracks into your sovereign library.
        </p>
      </div>

      {actionSuccess && (
        <div className="p-4 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 flex items-center space-x-3 text-sm text-emerald-300">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-400" />
          <p className="flex-1">{actionSuccess}</p>
          <button
            onClick={() => setActionSuccess(null)}
            className="text-xs text-emerald-400 hover:text-emerald-200 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {actionError && (
        <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/30 flex items-center space-x-3 text-sm text-red-300">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-400" />
          <p className="flex-1">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="text-xs text-red-400 hover:text-red-200 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="p-4 rounded-2xl bg-amber-950/20 border border-amber-500/20 flex items-start space-x-3 text-xs text-amber-300">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" />
        <p className="leading-relaxed">
          <strong className="text-amber-200">Zero Audio Hosting Boundary:</strong> SONORA never streams, caches, or redistributes audio files. All operations import structured metadata (ISRCs, titles, artists, track numbers, and playlist ordering) to guarantee library sovereignty.
        </p>
      </div>

      {/* Provider Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Spotify Card */}
        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                  <Radio className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Spotify</h3>
                  <span className="text-[11px] text-gray-500">OAuth PKCE (S256)</span>
                </div>
              </div>
              {data?.spotify.connectedAccount ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Connected</span>
                </span>
              ) : !data?.spotify.isConfigured ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-950/40 text-amber-400 border border-amber-600/30">
                  Config Required
                </span>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                  Not Connected
                </span>
              )}
            </div>

            <div className="space-y-3 text-xs">
              {data?.spotify.connectedAccount ? (
                <div className="p-3 rounded-xl bg-[#191d2c] border border-[#262c44] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Account:</span>
                    <span className="font-semibold text-white">
                      {data.spotify.connectedAccount.displayName}
                    </span>
                  </div>
                  {data.spotify.connectedAccount.email && (
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400">Email:</span>
                      <span className="text-gray-300">{data.spotify.connectedAccount.email}</span>
                    </div>
                  )}
                  {data.spotify.lastImportJob && (
                    <div className="pt-2 border-t border-[#262c44] flex items-center justify-between">
                      <span className="text-gray-400">Last Import:</span>
                      <span className="text-indigo-400 font-medium">
                        {data.spotify.lastImportJob.status} ({data.spotify.lastImportJob.processedItems} items)
                      </span>
                    </div>
                  )}
                </div>
              ) : !data?.spotify.isConfigured ? (
                <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/20 text-amber-300 text-[11px] space-y-1">
                  <p className="font-semibold text-amber-200">Credentials Required</p>
                  <p className="text-amber-300/80">
                    Add <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">SPOTIFY_CLIENT_ID</code> and{" "}
                    <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">SPOTIFY_CLIENT_SECRET</code> to{" "}
                    <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">.env.local</code>.
                  </p>
                </div>
              ) : (
                <p className="text-gray-400 leading-relaxed">
                  Connect your Spotify account to import all saved playlists, playlist item positions, and liked tracks into your universal library.
                </p>
              )}

              <div>
                <span className="text-gray-500 font-medium">Read-Only Scopes:</span>
                <p className="text-gray-400 text-[11px] mt-0.5">
                  <code className="text-indigo-300">playlist-read-private</code>,{" "}
                  <code className="text-indigo-300">playlist-read-collaborative</code>,{" "}
                  <code className="text-indigo-300">user-library-read</code>
                </p>
              </div>

              <div className="pt-2 border-t border-[#1f2438]">
                <p className="text-[11px] text-gray-500 leading-relaxed italic">
                  Development Mode: Limited to 5 authorized users. App owner requires Spotify Premium.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-[#1f2438] space-y-2">
            {data?.spotify.connectedAccount ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleTriggerImport(data.spotify.connectedAccount!.id, "Spotify")
                  }
                  disabled={importingProvider === "Spotify"}
                  className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  {importingProvider === "Spotify" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <DownloadCloud className="w-3.5 h-3.5" />
                  )}
                  <span>Import</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleDisconnect(data.spotify.connectedAccount!.id, "SPOTIFY")
                  }
                  disabled={disconnectingId === data.spotify.connectedAccount.id}
                  className="w-full py-2 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/50 border border-red-500/30 text-red-300 text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectSpotify}
                disabled={!data?.spotify.isConfigured}
                className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:bg-[#1f2438]/50 disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {!data?.spotify.isConfigured ? (
                  <>
                    <Lock className="w-3.5 h-3.5" />
                    <span>Configuration Required</span>
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Connect Spotify</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Apple Music Card */}
        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-pink-500/10 border border-pink-500/20 flex items-center justify-center text-pink-400">
                  <Music2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Apple Music</h3>
                  <span className="text-[11px] text-gray-500">MusicKit JS & Developer JWT</span>
                </div>
              </div>
              {data?.appleMusic.connectedAccount ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-950/60 text-emerald-300 border border-emerald-500/40 flex items-center space-x-1">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Connected</span>
                </span>
              ) : !data?.appleMusic.isConfigured ? (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-950/40 text-amber-400 border border-amber-600/30">
                  Config Required
                </span>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                  Not Connected
                </span>
              )}
            </div>

            <div className="space-y-3 text-xs">
              {data?.appleMusic.connectedAccount ? (
                <div className="p-3 rounded-xl bg-[#191d2c] border border-[#262c44] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-400">Storefront:</span>
                    <span className="font-semibold text-white">
                      {data.appleMusic.connectedAccount.displayName}
                    </span>
                  </div>
                  {data.appleMusic.lastImportJob && (
                    <div className="pt-2 border-t border-[#262c44] flex items-center justify-between">
                      <span className="text-gray-400">Last Import:</span>
                      <span className="text-indigo-400 font-medium">
                        {data.appleMusic.lastImportJob.status} ({data.appleMusic.lastImportJob.processedItems} items)
                      </span>
                    </div>
                  )}
                </div>
              ) : !data?.appleMusic.isConfigured ? (
                <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/20 text-amber-300 text-[11px] space-y-1">
                  <p className="font-semibold text-amber-200">Credentials Required</p>
                  <p className="text-amber-300/80">
                    Set <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">APPLE_TEAM_ID</code>,{" "}
                    <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">APPLE_MUSIC_KEY_ID</code>, and{" "}
                    <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">APPLE_MUSIC_PRIVATE_KEY_PATH</code> in{" "}
                    <code className="bg-black/40 px-1 py-0.5 rounded text-amber-200">.env.local</code>.
                  </p>
                </div>
              ) : (
                <p className="text-gray-400 leading-relaxed">
                  Authorize Apple Music to import your library songs, playlists, and ordered tracks directly into SONORA.
                </p>
              )}

              <div>
                <span className="text-gray-500 font-medium">Developer Token Security:</span>
                <p className="text-gray-400 text-[11px] mt-0.5">
                  Signed server-side with ES256. Private <code className="text-pink-300">.p8</code> key is never exposed to browser.
                </p>
              </div>

              <div className="pt-2 border-t border-[#1f2438]">
                <p className="text-[11px] text-gray-500 leading-relaxed italic">
                  Requires Apple Developer Program enrollment and MusicKit key generation.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-[#1f2438] space-y-2">
            {data?.appleMusic.connectedAccount ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleTriggerImport(data.appleMusic.connectedAccount!.id, "Apple Music")
                  }
                  disabled={importingProvider === "Apple Music"}
                  className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  {importingProvider === "Apple Music" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <DownloadCloud className="w-3.5 h-3.5" />
                  )}
                  <span>Import</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleDisconnect(data.appleMusic.connectedAccount!.id, "APPLE_MUSIC")
                  }
                  disabled={disconnectingId === data.appleMusic.connectedAccount.id}
                  className="w-full py-2 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/50 border border-red-500/30 text-red-300 text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:opacity-50"
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectAppleMusic}
                disabled={!data?.appleMusic.isConfigured}
                className="w-full py-2.5 px-3 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-xs font-semibold flex items-center justify-center space-x-1.5 transition-colors disabled:bg-[#1f2438]/50 disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {!data?.appleMusic.isConfigured ? (
                  <>
                    <Lock className="w-3.5 h-3.5" />
                    <span>Configuration Required</span>
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Connect Apple Music</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* YouTube Music Card */}
        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between opacity-80">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                  <Radio className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">YouTube Music</h3>
                  <span className="text-[11px] text-gray-500">YouTube Data API v3</span>
                </div>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                Phase 5 Target
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-gray-400 leading-relaxed">
                Scheduled for implementation in Phase 5 with strict quota accounting (50 units per playlist item).
              </p>

              <div>
                <span className="text-gray-500 font-medium">Compliance Boundary:</span>
                <p className="text-gray-400 text-[11px] mt-0.5 leading-relaxed">
                  YouTube Data API v3 only. Never simulated or implied as complete YouTube Music library parity.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-[#1f2438]">
            <button
              type="button"
              disabled
              className="w-full py-2.5 px-3 rounded-xl bg-[#1f2438]/50 text-gray-500 text-xs font-semibold flex items-center justify-center space-x-1.5 cursor-not-allowed"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Inactive (Phase 5)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Recent Import Jobs History */}
      <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Clock className="w-4 h-4 text-indigo-400" />
            <h2 className="text-base font-bold text-white">Import & Synchronization History</h2>
          </div>
          <button
            onClick={loadStatus}
            className="text-xs text-gray-400 hover:text-white flex items-center space-x-1 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Refresh</span>
          </button>
        </div>

        {recentJobs.length === 0 ? (
          <div className="text-center py-8 text-xs text-gray-500">
            No library import jobs recorded yet. Connect a provider above to initiate your first import.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#1f2438] text-gray-400 font-semibold">
                  <th className="pb-3 pr-4">Provider</th>
                  <th className="pb-3 px-4">Status</th>
                  <th className="pb-3 px-4">Processed Items</th>
                  <th className="pb-3 px-4">Failed Items</th>
                  <th className="pb-3 px-4">Started At</th>
                  <th className="pb-3 pl-4">Completed At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f2438]/60 text-gray-300">
                {recentJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 pr-4 font-medium text-white flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-400" />
                      <span>{job.sourceProvider}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          job.status === "COMPLETED"
                            ? "bg-emerald-950/60 text-emerald-300 border border-emerald-500/30"
                            : job.status === "RUNNING"
                            ? "bg-indigo-950/60 text-indigo-300 border border-indigo-500/30 animate-pulse"
                            : job.status === "QUEUED"
                            ? "bg-amber-950/60 text-amber-300 border border-amber-500/30"
                            : "bg-red-950/60 text-red-300 border border-red-500/30"
                        }`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono">{job.processedItems}</td>
                    <td className="py-3 px-4 font-mono text-red-400">{job.failedItems}</td>
                    <td className="py-3 px-4 text-gray-400">
                      {job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : "—"}
                    </td>
                    <td className="py-3 pl-4 text-gray-400">
                      {job.completedAt ? new Date(job.completedAt).toLocaleTimeString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Disconnection Safety Guarantee */}
      <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex items-center space-x-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-950/40 border border-emerald-500/20 flex items-center justify-center text-emerald-400 flex-shrink-0">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div className="text-xs text-gray-400 leading-relaxed">
          <p className="font-semibold text-white mb-0.5">Sovereignty & Disconnection Guarantee</p>
          Disconnecting any provider in SONORA zeroes access credentials locally and halts background sync. It will{" "}
          <strong className="text-emerald-300">never</strong> delete your canonical library records, matched tracks, or metadata backups.
        </div>
      </div>
    </div>
  );
}
