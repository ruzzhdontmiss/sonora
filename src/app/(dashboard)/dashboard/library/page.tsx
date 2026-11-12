import { redirect } from "next/navigation";
import Link from "next/link";
import { Music, AlertCircle, Plus, Search, ChevronLeft, ChevronRight, Disc } from "lucide-react";
import { getCurrentSession } from "@/modules/auth/service";
import { getLibraryTracks } from "@/modules/library/library.service";

export const dynamic = "force-dynamic";

interface LibraryPageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
  }>;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default async function LibraryPage(props: LibraryPageProps) {
  const searchParams = await props.searchParams;
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }

  const currentPage = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const searchQuery = searchParams.search ?? "";

  const libraryResult = await getLibraryTracks(session.user.id, {
    page: currentPage,
    limit: 20,
    search: searchQuery,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
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
            <span>Connect Provider (Phase 3)</span>
          </Link>
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex items-center justify-between gap-4 p-3 rounded-2xl bg-[#12151f] border border-[#1f2438]">
        <form method="GET" action="/dashboard/library" className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            name="search"
            defaultValue={searchQuery}
            placeholder="Search by title, artist, or album..."
            className="w-full pl-9 pr-4 py-1.5 text-xs bg-[#090a0f] border border-[#1f2438] rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </form>

        <div className="text-xs text-gray-400 font-medium">
          {libraryResult.total} canonical {libraryResult.total === 1 ? "track" : "tracks"}
        </div>
      </div>

      {/* Populated vs Empty State */}
      {libraryResult.items.length === 0 ? (
        <div className="p-12 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col items-center text-center max-w-xl mx-auto my-8">
          <div className="w-16 h-16 rounded-2xl bg-[#1f2438] flex items-center justify-center text-gray-400 mb-6">
            <Music className="w-8 h-8" />
          </div>

          <h3 className="text-lg font-bold text-white mb-2">
            {searchQuery ? "No Matching Tracks" : "No Canonical Tracks Stored"}
          </h3>
          <p className="text-sm text-gray-400 leading-relaxed mb-6">
            {searchQuery
              ? `No tracks found matching "${searchQuery}". Try a different search query.`
              : "Your canonical library is currently empty. Run the synthetic seed script (pnpm db:seed) to load development test tracks, or connect streaming providers in Phase 3."}
          </p>

          <div className="w-full p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] text-left text-xs text-gray-400 space-y-1.5">
            <div className="flex items-center space-x-2 text-indigo-400 font-medium">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>Canonical Invariants</span>
            </div>
            <p>• External streaming provider IDs are never used as canonical primary keys.</p>
            <p>• Track metadata is stored with deterministic deduplication and provenance.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl bg-[#12151f] border border-[#1f2438] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0e111a] text-gray-400 border-b border-[#1f2438] uppercase font-semibold">
                  <tr>
                    <th scope="col" className="px-4 py-3">#</th>
                    <th scope="col" className="px-4 py-3">Title & Artist</th>
                    <th scope="col" className="px-4 py-3">Album</th>
                    <th scope="col" className="px-4 py-3">ISRC</th>
                    <th scope="col" className="px-4 py-3">Provenance</th>
                    <th scope="col" className="px-4 py-3 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f2438]/50 text-gray-300">
                  {libraryResult.items.map((item, index) => {
                    const rowNumber = (libraryResult.page - 1) * libraryResult.limit + index + 1;
                    return (
                      <tr key={item.id} className="hover:bg-[#181c2b] transition-colors">
                        <td className="px-4 py-3 text-gray-500 font-mono">{rowNumber}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-lg bg-[#1f2438] flex items-center justify-center flex-shrink-0 text-indigo-400">
                              <Disc className="w-4 h-4" />
                            </div>
                            <div>
                              <p className="font-semibold text-white">{item.track.title}</p>
                              <p className="text-gray-400">{item.track.artistName}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-400">
                          {item.track.albumName || "—"}
                        </td>
                        <td className="px-4 py-3">
                          {item.track.isrc ? (
                            <span className="px-2 py-0.5 rounded-md bg-[#1f2438] text-indigo-300 font-mono text-[10px]">
                              {item.track.isrc}
                            </span>
                          ) : (
                            <span className="text-gray-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-md bg-emerald-950/40 border border-emerald-500/20 text-emerald-400 text-[10px] font-medium">
                            {item.sourceProvenance}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-400">
                          {formatDuration(item.track.durationMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination Controls */}
          {libraryResult.totalPages > 1 && (
            <div className="flex items-center justify-between px-2 pt-2 text-xs text-gray-400">
              <div>
                Page <span className="text-white font-medium">{libraryResult.page}</span> of{" "}
                <span className="text-white font-medium">{libraryResult.totalPages}</span>
              </div>
              <div className="flex items-center space-x-2">
                {libraryResult.page > 1 ? (
                  <Link
                    href={`/dashboard/library?page=${libraryResult.page - 1}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ""}`}
                    className="px-3 py-1.5 rounded-xl bg-[#12151f] border border-[#1f2438] hover:bg-[#1f2438] text-white flex items-center space-x-1 transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Previous</span>
                  </Link>
                ) : (
                  <span className="px-3 py-1.5 rounded-xl bg-[#12151f]/50 border border-[#1f2438]/50 text-gray-600 cursor-not-allowed flex items-center space-x-1">
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Previous</span>
                  </span>
                )}

                {libraryResult.page < libraryResult.totalPages ? (
                  <Link
                    href={`/dashboard/library?page=${libraryResult.page + 1}${searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : ""}`}
                    className="px-3 py-1.5 rounded-xl bg-[#12151f] border border-[#1f2438] hover:bg-[#1f2438] text-white flex items-center space-x-1 transition-colors"
                  >
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                ) : (
                  <span className="px-3 py-1.5 rounded-xl bg-[#12151f]/50 border border-[#1f2438]/50 text-gray-600 cursor-not-allowed flex items-center space-x-1">
                    <span>Next</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
