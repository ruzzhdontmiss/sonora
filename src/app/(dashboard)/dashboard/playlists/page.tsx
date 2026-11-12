import { ListMusic, Layers, Plus } from "lucide-react";

export default function PlaylistsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Playlists</h1>
          <p className="mt-1 text-sm text-gray-400">
            Order-preserving playlist structures, repeated track occurrences, and version snapshots.
          </p>
        </div>

        <button
          type="button"
          disabled
          className="px-4 py-2 rounded-xl bg-[#1f2438] text-gray-400 cursor-not-allowed text-xs font-semibold flex items-center space-x-1.5"
          title="Playlist curation engine scheduled for Phase 2"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Playlist (Phase 2)</span>
        </button>
      </div>

      {/* Honest Empty State */}
      <div className="p-12 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col items-center text-center max-w-xl mx-auto my-12">
        <div className="w-16 h-16 rounded-2xl bg-[#1f2438] flex items-center justify-center text-gray-400 mb-6">
          <ListMusic className="w-8 h-8" />
        </div>

        <h3 className="text-lg font-bold text-white mb-2">No Playlists Found</h3>
        <p className="text-sm text-gray-400 leading-relaxed mb-6">
          No playlists exist in your canonical library. The ordered playlist data model (preserving intentional repeated track occurrences and exact position indices) will be implemented in Phase 2.
        </p>

        <div className="w-full p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] text-left text-xs text-gray-400 space-y-1.5">
          <div className="flex items-center space-x-2 text-purple-400 font-medium">
            <Layers className="w-3.5 h-3.5" />
            <span>Playlist Invariants</span>
          </div>
          <p>• Curation order is strictly preserved.</p>
          <p>• Duplicate tracks inside playlists are never globally collapsed without explicit intent.</p>
        </div>
      </div>
    </div>
  );
}
