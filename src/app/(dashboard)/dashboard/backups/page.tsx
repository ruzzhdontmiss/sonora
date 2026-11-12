import { HardDriveDownload, FileJson, ShieldCheck } from "lucide-react";

export default function BackupsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Library Backups & Portable Export</h1>
        <p className="mt-1 text-sm text-gray-400">
          Immutable JSON metadata snapshots, backup verification, and disaster recovery.
        </p>
      </div>

      <div className="p-8 rounded-3xl bg-[#12151f] border border-[#1f2438] max-w-3xl">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-amber-950/50 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <HardDriveDownload className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Portable Metadata Export (Scheduled for Phase 5)</h2>
            <p className="text-xs text-amber-400 font-medium">Phase 5: Portable Snapshots & Restore</p>
          </div>
        </div>

        <p className="text-sm text-gray-400 leading-relaxed mb-6">
          Complete self-contained ownership of your musical curation:
        </p>

        <div className="space-y-3 text-xs text-gray-300">
          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <FileJson className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Versioned JSON Schema</p>
              <p className="text-gray-400 mt-0.5">
                Export includes canonical tracks, playlists, ordered items, and mappings with an explicit version header.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <ShieldCheck className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Zero Credential Leakage</p>
              <p className="text-gray-400 mt-0.5">
                Exports strictly exclude OAuth tokens, refresh secrets, passwords, and private signing keys.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

