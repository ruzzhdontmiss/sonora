import Link from "next/link";
import { Music, ListMusic, Radio, ArrowLeftRight, HardDriveDownload, Info } from "lucide-react";

export default function DashboardOverviewPage() {
  return (
    <div className="space-y-8">
      {/* Title */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Universal Library Overview
        </h1>
        <p className="mt-1 text-sm text-gray-400">
          Canonical catalog, provider connectivity, and cross-platform synchronization status.
        </p>
      </div>

      {/* Architecture Notice Banner */}
      <div className="p-4 rounded-2xl bg-indigo-950/30 border border-indigo-500/20 flex items-start space-x-3 text-sm text-indigo-300">
        <Info className="w-5 h-5 flex-shrink-0 text-indigo-400 mt-0.5" />
        <div>
          <p className="font-semibold text-white">Phase 1 Foundation Active</p>
          <p className="mt-0.5 text-xs text-indigo-300/80 leading-relaxed">
            Database persistence, session validation, and layout shell are verified. Canonical entity models and provider adapters will be introduced in Phase 2 and Phase 3.
          </p>
        </div>
      </div>

      {/* Honest Empty Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Canonical Tracks</span>
            <Music className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">0</p>
          <p className="mt-1 text-xs text-gray-500">Imports begin in Phase 3</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Playlists</span>
            <ListMusic className="w-4 h-4 text-purple-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">0</p>
          <p className="mt-1 text-xs text-gray-500">Ordered curation model in Phase 2</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Active Providers</span>
            <Radio className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">0</p>
          <p className="mt-1 text-xs text-gray-500">Spotify & Apple Music in Phase 3</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Backups Created</span>
            <HardDriveDownload className="w-4 h-4 text-amber-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">0</p>
          <p className="mt-1 text-xs text-gray-500">Portable snapshot export in Phase 5</p>
        </div>
      </div>

      {/* Guided Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center space-x-2 text-indigo-400 text-sm font-semibold mb-2">
              <Radio className="w-4 h-4" />
              <span>Streaming Connections</span>
            </div>
            <h3 className="text-lg font-bold text-white">Connect Streaming Services</h3>
            <p className="mt-1 text-sm text-gray-400 leading-relaxed">
              Connect Spotify, Apple Music, and YouTube to read playlists and synchronize your favorites without locking your metadata to one ecosystem.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-[#1f2438] flex items-center justify-between">
            <span className="text-xs text-gray-500">Phase 3 & Phase 5</span>
            <Link
              href="/dashboard/connections"
              className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              View Connections &rarr;
            </Link>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center space-x-2 text-emerald-400 text-sm font-semibold mb-2">
              <ArrowLeftRight className="w-4 h-4" />
              <span>Deterministic Transfer</span>
            </div>
            <h3 className="text-lg font-bold text-white">Cross-Platform Transfer</h3>
            <p className="mt-1 text-sm text-gray-400 leading-relaxed">
              Transfer playlists between services with exact duplicate and sequence preservation. Ambiguous songs are held for user confirmation.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-[#1f2438] flex items-center justify-between">
            <span className="text-xs text-gray-500">Phase 4 Engine</span>
            <Link
              href="/dashboard/transfer"
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              View Transfer Pipeline &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
