"use client";

import { useState, useEffect } from "react";
import {
  Plus,
  Play,
  Trash2,
  CheckCircle2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  ArrowRight,
} from "lucide-react";

interface SyncRuleItem {
  id: string;
  name: string;
  sourceProvider: string;
  targetProvider: string;
  direction: string;
  conflictPolicy: string;
  isActive: boolean;
  createdAt: string;
}

export default function SyncRulesPage() {
  const [rules, setRules] = useState<SyncRuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [sourceProvider, setSourceProvider] = useState("SPOTIFY");
  const [targetProvider, setTargetProvider] = useState("YOUTUBE_MUSIC");
  const [conflictPolicy, setConflictPolicy] = useState("ADDITIVE_MERGE");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchRules = async () => {
    try {
      const res = await fetch("/api/sync/rules");
      if (res.ok) {
        const data = await res.json();
        setRules(data.rules || []);
      }
    } catch {
      // Ignore initial load error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/sync/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || `${sourceProvider} → ${targetProvider} Sync`,
          sourceProvider,
          targetProvider,
          conflictPolicy,
        }),
      });

      if (res.ok) {
        setShowCreateModal(false);
        setName("");
        setSuccessMessage("Sync rule created successfully.");
        await fetchRules();
      } else {
        const err = await res.json();
        setErrorMessage(err.error || "Failed to create sync rule");
      }
    } catch {
      setErrorMessage("Network error creating sync rule");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleRule = async (rule: SyncRuleItem) => {
    try {
      const res = await fetch(`/api/sync/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (res.ok) {
        await fetchRules();
      }
    } catch {
      // Ignore toggle error
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm("Are you sure you want to delete this sync rule?")) return;
    try {
      const res = await fetch(`/api/sync/rules/${id}`, { method: "DELETE" });
      if (res.ok) {
        await fetchRules();
      }
    } catch {
      // Ignore delete error
    }
  };

  const handleReconcile = async (id: string) => {
    setSuccessMessage(null);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/sync/rules/${id}/reconcile`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSuccessMessage(`Reconciliation job queued (Job ID: ${data.result.syncJobId}).`);
      } else {
        const err = await res.json();
        setErrorMessage(err.error || "Failed to start reconciliation");
      }
    } catch {
      setErrorMessage("Failed to start reconciliation");
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Synchronization Rules
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Continuous reconciliation rules between canonical library and streaming accounts.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs transition"
        >
          <Plus className="w-4 h-4" />
          <span>New Sync Rule</span>
        </button>
      </div>

      {successMessage && (
        <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-xs text-emerald-300 flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Rules List */}
      <div className="p-6 rounded-3xl bg-[#12151f] border border-[#1f2438] space-y-4">
        <div className="flex items-center justify-between border-b border-gray-800 pb-3">
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            Configured Sync Rules ({rules.length})
          </span>
          <span className="text-[11px] text-gray-500">Additive-First by Default</span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-gray-500">Loading sync rules...</div>
        ) : rules.length === 0 ? (
          <div className="py-8 text-center text-xs text-gray-500 space-y-3">
            <p>No synchronization rules configured yet.</p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="text-purple-400 hover:text-purple-300 underline font-medium"
            >
              Create your first sync rule (e.g. Spotify → YouTube Music)
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="p-4 rounded-2xl bg-[#090a0f] border border-[#1f2438] flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-sm text-white">{rule.name}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        rule.isActive
                          ? "bg-emerald-950 text-emerald-400 border border-emerald-500/20"
                          : "bg-gray-800 text-gray-400"
                      }`}
                    >
                      {rule.isActive ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>

                  <div className="flex items-center space-x-2 text-xs text-gray-400">
                    <span className="font-semibold text-gray-300">{rule.sourceProvider}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-purple-400" />
                    <span className="font-semibold text-gray-300">{rule.targetProvider}</span>
                    <span>•</span>
                    <span className="text-purple-300 bg-purple-950/40 px-2 py-0.5 rounded text-[10px]">
                      {rule.conflictPolicy}
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleReconcile(rule.id)}
                    title="Run reconciliation now"
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-[#1f2438] hover:bg-[#282e47] text-white text-xs font-medium transition"
                  >
                    <Play className="w-3 h-3 text-purple-400" />
                    <span>Run Sync</span>
                  </button>

                  <button
                    onClick={() => handleToggleRule(rule)}
                    className="p-1.5 text-gray-400 hover:text-white transition"
                    title={rule.isActive ? "Pause sync rule" : "Activate sync rule"}
                  >
                    {rule.isActive ? (
                      <ToggleRight className="w-6 h-6 text-emerald-400" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-gray-500" />
                    )}
                  </button>

                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    className="p-1.5 text-gray-400 hover:text-rose-400 transition"
                    title="Delete rule"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal for Creating New Rule */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-[#12151f] border border-[#1f2438] p-6 rounded-3xl max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-white">Create Continuous Sync Rule</h2>
            <form onSubmit={handleCreateRule} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-gray-300 font-medium">Rule Name</label>
                <input
                  type="text"
                  placeholder="e.g. Spotify to YouTube Daily Sync"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090a0f] border border-[#1f2438] text-white text-xs focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-gray-300 font-medium">Source Provider</label>
                  <select
                    value={sourceProvider}
                    onChange={(e) => setSourceProvider(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#090a0f] border border-[#1f2438] text-white text-xs focus:outline-none focus:border-purple-500"
                  >
                    <option value="SPOTIFY">Spotify</option>
                    <option value="APPLE_MUSIC">Apple Music</option>
                    <option value="YOUTUBE_MUSIC">YouTube Music</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-gray-300 font-medium">Target Provider</label>
                  <select
                    value={targetProvider}
                    onChange={(e) => setTargetProvider(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#090a0f] border border-[#1f2438] text-white text-xs focus:outline-none focus:border-purple-500"
                  >
                    <option value="YOUTUBE_MUSIC">YouTube Music</option>
                    <option value="SPOTIFY">Spotify</option>
                    <option value="APPLE_MUSIC">Apple Music</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-gray-300 font-medium">Conflict Policy</label>
                <select
                  value={conflictPolicy}
                  onChange={(e) => setConflictPolicy(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#090a0f] border border-[#1f2438] text-white text-xs focus:outline-none focus:border-purple-500"
                >
                  <option value="ADDITIVE_MERGE">Additive Merge (Non-destructive, default)</option>
                  <option value="SOURCE_WINS">Source Wins (Overwrite on conflict)</option>
                  <option value="DESTINATION_WINS">Destination Wins (Retain target state)</option>
                  <option value="MANUAL_REVIEW">Manual Review (Flag for approval)</option>
                </select>
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium text-xs transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium text-xs transition"
                >
                  {saving ? "Creating..." : "Save Sync Rule"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
