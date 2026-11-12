import Link from "next/link";
import { redirect } from "next/navigation";
import { Music, ListMusic, Radio, HardDriveDownload, Layers, Sparkles } from "lucide-react";
import { getCurrentSession } from "@/modules/auth/service";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }

  const userId = session.user.id;

  // Real database metrics for authenticated user
  const [tracksCount, playlistsCount, providersCount, snapshotsCount] = await Promise.all([
    prisma.libraryTrack.count({
      where: { library: { userId } },
    }),
    prisma.playlist.count({
      where: { library: { userId }, deletedAt: null },
    }),
    prisma.providerAccount.count({
      where: { userId, status: "CONNECTED" },
    }),
    prisma.librarySnapshot.count({
      where: { userId },
    }),
  ]);

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
        <Sparkles className="w-5 h-5 flex-shrink-0 text-indigo-400 mt-0.5" />
        <div>
          <p className="font-semibold text-white">Phase 2 Canonical Architecture Active</p>
          <p className="mt-0.5 text-xs text-indigo-300/80 leading-relaxed">
            Universal tracks, ordered playlists (preserving duplicate tracks), provider mapping decoupling, and transactional outbox infrastructure are live. Live streaming imports begin in Phase 3.
          </p>
        </div>
      </div>

      {/* Live Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Canonical Tracks</span>
            <Music className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">{tracksCount}</p>
          <p className="mt-1 text-xs text-gray-500">Universal saved catalog</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Playlists</span>
            <ListMusic className="w-4 h-4 text-purple-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">{playlistsCount}</p>
          <p className="mt-1 text-xs text-gray-500">Ordered sequence collections</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Active Providers</span>
            <Radio className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">{providersCount}</p>
          <p className="mt-1 text-xs text-gray-500">Live OAuth in Phase 3</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#12151f] border border-[#1f2438]">
          <div className="flex items-center justify-between text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Backups Created</span>
            <HardDriveDownload className="w-4 h-4 text-amber-400" />
          </div>
          <p className="mt-3 text-3xl font-bold text-white">{snapshotsCount}</p>
          <p className="mt-1 text-xs text-gray-500">Snapshots & portable exports</p>
        </div>
      </div>

      {/* Guided Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center space-x-2 text-indigo-400 text-sm font-semibold mb-2">
              <Layers className="w-4 h-4" />
              <span>Universal Library</span>
            </div>
            <h3 className="text-lg font-bold text-white">Canonical Catalog & Tracks</h3>
            <p className="mt-1 text-sm text-gray-400 leading-relaxed">
              Explore your sovereign tracks, ISRCs, artist credits, and provenance mappings decoupled from any single streaming service.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-[#1f2438] flex items-center justify-between">
            <span className="text-xs text-gray-500">Canonical persistence</span>
            <Link
              href="/dashboard/library"
              className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Browse Library &rarr;
            </Link>
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between">
          <div>
            <div className="flex items-center space-x-2 text-purple-400 text-sm font-semibold mb-2">
              <ListMusic className="w-4 h-4" />
              <span>Ordered Curation</span>
            </div>
            <h3 className="text-lg font-bold text-white">Playlists & Sequence Preservation</h3>
            <p className="mt-1 text-sm text-gray-400 leading-relaxed">
              Manage playlists with exact track positioning and duplicate occurrence preservation for reprises and DJ tracklists.
            </p>
          </div>
          <div className="mt-6 pt-4 border-t border-[#1f2438] flex items-center justify-between">
            <span className="text-xs text-gray-500">Atomic ordering</span>
            <Link
              href="/dashboard/playlists"
              className="text-xs font-semibold text-purple-400 hover:text-purple-300 transition-colors"
            >
              View Playlists &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
