"use client";

import { useState, useEffect, useCallback } from "react";
import {
  CheckCheck,
  AlertTriangle,
  Search,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Music2,
  Sparkles,
  Info,
  Clock,
  Disc,
  Radio,
} from "lucide-react";

interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  isrc?: string | null;
  explicit?: boolean;
}

interface ProviderTrackInfo extends TrackInfo {
  provider: "SPOTIFY" | "APPLE_MUSIC";
  externalId: string;
  providerUri?: string | null;
}

interface EvidenceBreakdown {
  isrcMatch?: boolean;
  titleSimilarity?: number;
  titleScore?: number;
  artistOverlap?: number;
  artistScore?: number;
  durationDiffMs?: number;
  durationScore?: number;
}

interface MatchEvidence {
  breakdown?: EvidenceBreakdown;
  sourceNormalized?: Record<string, unknown>;
  candidateNormalized?: Record<string, unknown>;
}

interface UnresolvedMatch {
  id: string;
  canonicalTrackId: string;
  providerTrackId: string;
  matchConfidence: number;
  matchMethod: string;
  reviewStatus: string;
  conflictReason?: string | null;
  conflictingTrackId?: string | null;
  evidence?: MatchEvidence | null;
  canonicalTrack: TrackInfo;
  providerTrack: ProviderTrackInfo;
}

interface SearchCandidate {
  id: string;
  provider: "SPOTIFY" | "APPLE_MUSIC";
  title: string;
  artistName: string;
  albumName?: string | null;
  durationMs: number;
  isrc?: string | null;
  explicit?: boolean;
  uri?: string | null;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function MatchReviewPage() {
  const [matches, setMatches] = useState<UnresolvedMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // Search candidate state per match card
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchProvider, setSearchProvider] = useState<"SPOTIFY" | "APPLE_MUSIC">("SPOTIFY");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchCandidate[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Expanded evidence state
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/matching/unresolved?limit=50");
      if (!res.ok) {
        throw new Error(`Failed to load unresolved matches (${res.status})`);
      }
      const data = await res.json();
      setMatches(data.matches || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load matches");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMatches();
  }, [fetchMatches]);

  const handleResolve = async (
    match: UnresolvedMatch,
    selectedCandidate?: SearchCandidate
  ) => {
    const key = match.id;
    setActionInProgress(key);
    setError(null);
    try {
      const res = await fetch("/api/matching/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackMatchId: match.id,
          canonicalTrackId: match.canonicalTrackId,
          providerTrackId: match.providerTrackId,
          selectedCandidate,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to confirm match");
      }

      // Remove from pending list
      setMatches((prev) => prev.filter((m) => m.id !== match.id));
      if (activeSearchId === match.id) {
        setActiveSearchId(null);
        setSearchResults([]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleReject = async (match: UnresolvedMatch) => {
    const key = match.id;
    setActionInProgress(key);
    setError(null);
    try {
      const res = await fetch("/api/matching/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackMatchId: match.id,
          canonicalTrackId: match.canonicalTrackId,
          providerTrackId: match.providerTrackId,
          reason: "Rejected during manual review",
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to reject match");
      }

      setMatches((prev) => prev.filter((m) => m.id !== match.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Rejection failed");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleSearchCandidates = async (match?: UnresolvedMatch) => {
    if (!searchQuery.trim()) return;
    if (match) {
      setActiveSearchId(match.id);
    }
    setIsSearching(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/matching/search-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchQuery.trim(),
          provider: searchProvider,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Search failed");
      }

      const data = await res.json();
      setSearchResults(data.candidates || []);
    } catch (err: unknown) {
      setSearchError(err instanceof Error ? err.message : "Failed to search candidates");
    } finally {
      setIsSearching(false);
    }
  };

  const toggleSearch = (match: UnresolvedMatch) => {
    if (activeSearchId === match.id) {
      setActiveSearchId(null);
      setSearchResults([]);
      setSearchError(null);
    } else {
      setActiveSearchId(match.id);
      setSearchQuery(`${match.canonicalTrack.title} ${match.canonicalTrack.artistName}`);
      setSearchProvider(match.providerTrack.provider || "SPOTIFY");
      setSearchResults([]);
      setSearchError(null);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center space-x-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider">
          <Sparkles className="w-4 h-4" />
          <span>Disambiguation & Quality Control</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-1">
          Manual Match Review
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Inspect ambiguous candidates, version conflicts, or ISRC collisions before syncing across providers.
        </p>
      </div>

      {/* Global Error Banner */}
      {error && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/40 text-red-200 text-sm flex items-start space-x-3">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-400 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* Main Content */}
      {loading ? (
        <div className="p-12 text-center rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="inline-block animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full mb-3" />
          <p className="text-sm text-gray-400">Loading unresolved match queue...</p>
        </div>
      ) : matches.length === 0 ? (
        <div className="p-12 text-center rounded-2xl bg-[#12151f] border border-[#1f2438] space-y-3">
          <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCheck className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-semibold text-white">All Matches Resolved</h2>
          <p className="text-sm text-gray-400 max-w-md mx-auto">
            Your universal library has no unresolved track ambiguities or conflicts requiring manual approval.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between text-sm text-gray-400">
            <span>
              Showing <strong className="text-white">{matches.length}</strong> track{matches.length === 1 ? "" : "s"} needing review
            </span>
            <button
              onClick={fetchMatches}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition"
            >
              Refresh Queue
            </button>
          </div>

          {matches.map((m) => {
            const isProcessing = actionInProgress === m.id;
            const isSearchOpen = activeSearchId === m.id;
            const isEvidenceOpen = expandedEvidenceId === m.id;
            const evidence = m.evidence;
            const breakdown = evidence?.breakdown;

            return (
              <div
                key={m.id}
                className="rounded-2xl bg-[#12151f] border border-[#1f2438] overflow-hidden transition-all duration-150"
              >
                {/* Reason & Status Header */}
                <div className="px-6 py-3 bg-[#171b29] border-b border-[#1f2438] flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center space-x-2">
                    <span className="px-2 py-0.5 rounded font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20 flex items-center space-x-1">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{m.reviewStatus}</span>
                    </span>
                    {m.conflictReason && (
                      <span className="text-gray-300 font-medium truncate max-w-md">
                        {m.conflictReason}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center space-x-3 text-gray-400">
                    <span>
                      Confidence:{" "}
                      <strong className="text-white">
                        {Math.round(m.matchConfidence * 100)}%
                      </strong>
                    </span>
                    <span>Method: {m.matchMethod}</span>
                  </div>
                </div>

                {/* Side-by-Side Comparison */}
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Canonical Source Track */}
                  <div className="p-4 rounded-xl bg-[#0b0d14] border border-[#1f2438] space-y-3">
                    <div className="flex items-center justify-between text-xs text-indigo-400 font-semibold uppercase tracking-wider">
                      <span className="flex items-center space-x-1.5">
                        <Music2 className="w-3.5 h-3.5" />
                        <span>Source Universal Track</span>
                      </span>
                      {m.canonicalTrack.explicit && (
                        <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 text-[10px]">
                          EXPLICIT
                        </span>
                      )}
                    </div>

                    <div>
                      <h3 className="text-base font-bold text-white">
                        {m.canonicalTrack.title}
                      </h3>
                      <p className="text-sm text-gray-300">{m.canonicalTrack.artistName}</p>
                      {m.canonicalTrack.albumName && (
                        <p className="text-xs text-gray-500 mt-0.5 flex items-center space-x-1">
                          <Disc className="w-3 h-3" />
                          <span>{m.canonicalTrack.albumName}</span>
                        </p>
                      )}
                    </div>

                    <div className="pt-2 border-t border-[#1f2438] flex items-center justify-between text-xs text-gray-400">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-3 h-3" />
                        <span>{formatDuration(m.canonicalTrack.durationMs)}</span>
                      </span>
                      <span>
                        ISRC:{" "}
                        <span className="font-mono text-gray-300">
                          {m.canonicalTrack.isrc || "None"}
                        </span>
                      </span>
                    </div>
                  </div>

                  {/* Proposed Provider Candidate Track */}
                  <div className="p-4 rounded-xl bg-[#0b0d14] border border-[#1f2438] space-y-3">
                    <div className="flex items-center justify-between text-xs text-emerald-400 font-semibold uppercase tracking-wider">
                      <span className="flex items-center space-x-1.5">
                        <Radio className="w-3.5 h-3.5" />
                        <span>Proposed Match ({m.providerTrack.provider})</span>
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40 text-[10px]">
                        ID: {m.providerTrack.externalId}
                      </span>
                    </div>

                    <div>
                      <h3 className="text-base font-bold text-white">
                        {m.providerTrack.title}
                      </h3>
                      <p className="text-sm text-gray-300">{m.providerTrack.artistName}</p>
                      {m.providerTrack.albumName && (
                        <p className="text-xs text-gray-500 mt-0.5 flex items-center space-x-1">
                          <Disc className="w-3 h-3" />
                          <span>{m.providerTrack.albumName}</span>
                        </p>
                      )}
                    </div>

                    <div className="pt-2 border-t border-[#1f2438] flex items-center justify-between text-xs text-gray-400">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-3 h-3" />
                        <span>{formatDuration(m.providerTrack.durationMs)}</span>
                      </span>
                      <span>
                        ISRC:{" "}
                        <span className="font-mono text-gray-300">
                          {m.providerTrack.isrc || "None"}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Evidence Accordion (Optional details) */}
                {breakdown && (
                  <div className="px-6 pb-2">
                    <button
                      onClick={() =>
                        setExpandedEvidenceId(isEvidenceOpen ? null : m.id)
                      }
                      className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 font-medium"
                    >
                      <Info className="w-3.5 h-3.5" />
                      <span>{isEvidenceOpen ? "Hide Evidence Details" : "View Match Evidence Breakdown"}</span>
                      {isEvidenceOpen ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                    </button>

                    {isEvidenceOpen && (
                      <div className="mt-3 p-4 rounded-xl bg-[#0b0d14] border border-[#1f2438] grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-gray-300">
                        <div>
                          <span className="text-gray-500 block">ISRC Match</span>
                          <strong className={breakdown.isrcMatch ? "text-emerald-400" : "text-gray-400"}>
                            {breakdown.isrcMatch ? "+0.60 (Exact)" : "No match"}
                          </strong>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Title Similarity</span>
                          <strong className="text-white">
                            {((breakdown.titleSimilarity ?? 0) * 100).toFixed(0)}% (+{breakdown.titleScore ?? 0})
                          </strong>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Artist Overlap</span>
                          <strong className="text-white">
                            {((breakdown.artistOverlap ?? 0) * 100).toFixed(0)}% (+{breakdown.artistScore ?? 0})
                          </strong>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Duration Diff</span>
                          <strong className="text-white">
                            {breakdown.durationDiffMs ?? 0}ms ({(breakdown.durationScore ?? 0) >= 0 ? `+${breakdown.durationScore ?? 0}` : breakdown.durationScore})
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Primary Actions Bar */}
                <div className="px-6 py-4 bg-[#141724] border-t border-[#1f2438] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center space-x-2">
                    <button
                      disabled={isProcessing}
                      onClick={() => toggleSearch(m)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#1f2438] text-gray-200 hover:bg-[#282e47] transition flex items-center space-x-1.5"
                    >
                      <Search className="w-3.5 h-3.5" />
                      <span>{isSearchOpen ? "Close Alternative Search" : "Search Alternative"}</span>
                    </button>
                  </div>

                  <div className="flex items-center space-x-3">
                    <button
                      disabled={isProcessing}
                      onClick={() => handleReject(m)}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-950/60 text-red-300 border border-red-800/40 hover:bg-red-900/60 transition flex items-center space-x-1.5 disabled:opacity-50"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Reject Match</span>
                    </button>

                    <button
                      disabled={isProcessing}
                      onClick={() => handleResolve(m)}
                      className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition flex items-center space-x-1.5 disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{isProcessing ? "Confirming..." : "Accept Proposed Match"}</span>
                    </button>
                  </div>
                </div>

                {/* Inline Catalog Search Panel */}
                {isSearchOpen && (
                  <div className="p-6 bg-[#0e101a] border-t border-[#1f2438] space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-300 flex items-center space-x-1.5">
                        <Search className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Live Catalog Search on Destination Provider</span>
                      </span>
                      <div className="flex items-center space-x-2">
                        <select
                          value={searchProvider}
                          onChange={(e) => setSearchProvider(e.target.value as "SPOTIFY" | "APPLE_MUSIC")}
                          className="bg-[#12151f] border border-[#1f2438] text-xs text-white rounded-lg px-2.5 py-1"
                        >
                          <option value="SPOTIFY">Spotify Catalog</option>
                          <option value="APPLE_MUSIC">Apple Music Catalog</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex space-x-2">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleSearchCandidates(m)}
                        placeholder="Search song title and artist..."
                        className="flex-1 bg-[#12151f] border border-[#1f2438] text-white text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        disabled={isSearching}
                        onClick={() => handleSearchCandidates(m)}
                        className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 disabled:opacity-50 transition"
                      >
                        {isSearching ? "Searching..." : "Search"}
                      </button>
                    </div>

                    {searchError && (
                      <p className="text-xs text-red-400">{searchError}</p>
                    )}

                    {searchResults.length > 0 && (
                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                        {searchResults.map((cand) => (
                          <div
                            key={cand.id}
                            className="p-3 rounded-xl bg-[#12151f] border border-[#1f2438] flex items-center justify-between hover:border-indigo-500/50 transition"
                          >
                            <div className="text-xs space-y-0.5">
                              <p className="font-semibold text-white">{cand.title}</p>
                              <p className="text-gray-400">
                                {cand.artistName} {cand.albumName ? `• ${cand.albumName}` : ""}
                              </p>
                              <p className="text-[10px] text-gray-500">
                                Duration: {formatDuration(cand.durationMs)} • ISRC: {cand.isrc || "None"}
                              </p>
                            </div>

                            <button
                              disabled={isProcessing}
                              onClick={() => handleResolve(m, cand)}
                              className="px-3 py-1 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 transition"
                            >
                              Choose This Track
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
