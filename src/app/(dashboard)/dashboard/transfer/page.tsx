import { ArrowLeftRight, CheckCircle2, ShieldAlert } from "lucide-react";

export default function TransferPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Playlist & Library Transfer</h1>
        <p className="mt-1 text-sm text-gray-400">
          Deterministic cross-platform playlist transfer and metadata migration engine.
        </p>
      </div>

      <div className="p-8 rounded-3xl bg-[#12151f] border border-[#1f2438] max-w-3xl">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-950/50 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
            <ArrowLeftRight className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Transfer Engine (Scheduled for Phase 4)</h2>
            <p className="text-xs text-indigo-400 font-medium">Phase 4: Track Matching, Playlists & Migration</p>
          </div>
        </div>

        <p className="text-sm text-gray-400 leading-relaxed mb-6">
          The transfer engine enables moving playlists between connected providers with explicit safeguards:
        </p>

        <div className="space-y-3 text-xs text-gray-300">
          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Order & Duplicate Preservation</p>
              <p className="text-gray-400 mt-0.5">
                Exact track sequence and intentional repeated occurrences are retained on target platforms.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Deterministic Matching (No Silent LLM Guesses)</p>
              <p className="text-gray-400 mt-0.5">
                Matches are determined via ISRC and strict normalized acoustic metadata. Ambiguous tracks require user review.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Pre-flight Write Confirmation</p>
              <p className="text-gray-400 mt-0.5">
                A full preview of planned external creations and inserts is shown before any external side effects.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#1f2438] flex items-center space-x-2 text-xs text-gray-500">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          <span>Write operations are strictly disabled until Phase 4 review and sign-off.</span>
        </div>
      </div>
    </div>
  );
}
