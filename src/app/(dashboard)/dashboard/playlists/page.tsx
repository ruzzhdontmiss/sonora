import { redirect } from "next/navigation";
import Link from "next/link";
import { ListMusic, Layers, Plus, ChevronLeft, ChevronRight, Lock, Globe } from "lucide-react";
import { getCurrentSession } from "@/modules/auth/service";
import { getUserPlaylists } from "@/modules/playlists/playlists.service";

export const dynamic = "force-dynamic";

interface PlaylistsPageProps {
  searchParams: Promise<{
    page?: string;
    search?: string;
  }>;
}

export default async function PlaylistsPage(props: PlaylistsPageProps) {
  const searchParams = await props.searchParams;
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }

  const currentPage = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const searchQuery = searchParams.search ?? "";

  const playlistsResult = await getUserPlaylists(session.user.id, {
    page: currentPage,
    limit: 20,
    search: searchQuery,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Playlists</h1>
          <p className="mt-1 text-sm text-gray-400">
            Order-preserving playlist structures, repeated track occurrences, and version snapshots.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <Link
            href="/dashboard/playlists"
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center space-x-1.5 transition-all shadow-md shadow-indigo-600/20"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Canonical Playlists</span>
          </Link>
        </div>
      </div>

      {/* Populated vs Empty State */}
      {playlistsResult.items.length === 0 ? (
        <div className="p-12 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col items-center text-center max-w-xl mx-auto my-8">
          <div className="w-16 h-16 rounded-2xl bg-[#1f2438] flex items-center justify-center text-gray-400 mb-6">
            <ListMusic className="w-8 h-8" />
          </div>

          <h3 className="text-lg font-bold text-white mb-2">No Playlists Found</h3>
          <p className="text-sm text-gray-400 leading-relaxed mb-6">
            No playlists exist in your canonical library. Run the synthetic seed script (pnpm db:seed) to load sample playlists demonstrating sequence ordering and duplicate track occurrence preservation.
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
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {playlistsResult.items.map((playlist) => (
              <Link
                key={playlist.id}
                href={`/dashboard/playlists/${playlist.id}`}
                className="group p-5 rounded-2xl bg-[#12151f] border border-[#1f2438] hover:border-indigo-500/40 hover:bg-[#161a29] transition-all flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-950/40 border border-purple-500/20 flex items-center justify-center text-purple-400 group-hover:scale-105 transition-transform">
                      <ListMusic className="w-5 h-5" />
                    </div>
                    <span className="flex items-center space-x-1 text-[11px] text-gray-400 px-2 py-0.5 rounded-md bg-[#1f2438]">
                      {playlist.isPublic ? (
                        <>
                          <Globe className="w-3 h-3 text-emerald-400" />
                          <span>Public</span>
                        </>
                      ) : (
                        <>
                          <Lock className="w-3 h-3 text-amber-400" />
                          <span>Private</span>
                        </>
                      )}
                    </span>
                  </div>

                  <h3 className="font-bold text-white text-base group-hover:text-indigo-400 transition-colors">
                    {playlist.title}
                  </h3>
                  <p className="mt-1 text-xs text-gray-400 line-clamp-2">
                    {playlist.description || "No description provided."}
                  </p>
                </div>

                <div className="mt-6 pt-3 border-t border-[#1f2438] flex items-center justify-between text-xs text-gray-500">
                  <span>{playlist._count.items} {playlist._count.items === 1 ? "track" : "tracks"}</span>
                  <span className="text-indigo-400 font-semibold group-hover:translate-x-0.5 transition-transform">
                    View Details &rarr;
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination Controls */}
          {playlistsResult.totalPages > 1 && (
            <div className="flex items-center justify-between px-2 pt-2 text-xs text-gray-400">
              <div>
                Page <span className="text-white font-medium">{playlistsResult.page}</span> of{" "}
                <span className="text-white font-medium">{playlistsResult.totalPages}</span>
              </div>
              <div className="flex items-center space-x-2">
                {playlistsResult.page > 1 ? (
                  <Link
                    href={`/dashboard/playlists?page=${playlistsResult.page - 1}`}
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

                {playlistsResult.page < playlistsResult.totalPages ? (
                  <Link
                    href={`/dashboard/playlists?page=${playlistsResult.page + 1}`}
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
