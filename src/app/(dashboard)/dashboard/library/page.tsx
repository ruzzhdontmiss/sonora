import { Music, AlertCircle, Plus } from "lucide-react";
import Link from "next/link";

export default function LibraryPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Canonical Music Library</h1>
          <p className="mt-1 text-sm text-gray-400">
            Universal tracks, ISRCs, artist credits, and multi-provider mappings.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <Link
            href="/dashboard/connections"
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center space-x-1.5 transition-all shadow-md shadow-indigo-600/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Connect Provider to Ingest</span>
          </Link>
        </div>
      </div>

      {/* Honest Empty State */}
      <div className="p-12 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col items-center text-center max-w-xl mx-auto my-12">
        <div className="w-16 h-16 rounded-2xl bg-[#1f2438] flex items-center justify-center text-gray-400 mb-6">
          <Music className="w-8 h-8" />
        </div>

        <h3 className="text-lg font-bold text-white mb-2">No Canonical Tracks Stored</h3>
        <p className="text-sm text-gray-400 leading-relaxed mb-6">
          Your library is currently empty. In Phase 2, the canonical schema will define tracks, provider mappings, and ownership. In Phase 3, you will be able to ingest library tracks directly from Spotify and Apple Music.
        </p>

        <div className="w-full p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] text-left text-xs text-gray-400 space-y-1.5">
          <div className="flex items-center space-x-2 text-indigo-400 font-medium">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>Canonical Data Invariants</span>
          </div>
          <p>• External streaming provider IDs are never used as canonical primary keys.</p>
          <p>• Multi-provider mappings preserve original source provenance.</p>
        </div>
      </div>
    </div>
  );
}
