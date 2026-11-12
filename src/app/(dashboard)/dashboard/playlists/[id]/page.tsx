import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ListMusic, Lock, Globe, Clock, Repeat, Disc, AlertCircle } from "lucide-react";
import { getCurrentSession } from "@/modules/auth/service";
import { getPlaylistById } from "@/modules/playlists/playlists.service";

export const dynamic = "force-dynamic";

interface PlaylistDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type PlaylistDetail = Awaited<ReturnType<typeof getPlaylistById>>;

export default async function PlaylistDetailPage(props: PlaylistDetailPageProps) {
  const params = await props.params;
  const session = await getCurrentSession();
  if (!session) {
    redirect("/login");
  }

  let playlist: PlaylistDetail | null = null;
  let errorMessage: string | null = null;

  try {
    playlist = await getPlaylistById(session.user.id, params.id);
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : "Failed to load playlist.";
  }

  if (errorMessage || !playlist) {
    return (
      <div className="space-y-6">
        <Link
          href="/dashboard/playlists"
          className="inline-flex items-center space-x-1.5 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Playlists</span>
        </Link>

        <div className="p-8 rounded-2xl bg-[#12151f] border border-rose-500/20 text-center max-w-md mx-auto my-12">
          <AlertCircle className="w-8 h-8 text-rose-400 mx-auto mb-3" />
          <h2 className="text-lg font-bold text-white mb-1">Playlist Unavailable</h2>
          <p className="text-xs text-gray-400 mb-6">{errorMessage}</p>
          <Link
            href="/dashboard/playlists"
            className="px-4 py-2 rounded-xl bg-[#1f2438] hover:bg-[#282f49] text-white text-xs font-semibold"
          >
            Return to Playlists
          </Link>
        </div>
      </div>
    );
  }

  // Calculate total playlist duration
  const totalDurationMs = playlist.items.reduce(
    (acc: number, item) => acc + (item.track.durationMs || 0),
    0
  );

  // Identify duplicate track occurrences to demonstrate order preservation
  const trackOccurrenceCounts = new Map<string, number>();
  for (const item of playlist.items) {
    trackOccurrenceCounts.set(
      item.trackId,
      (trackOccurrenceCounts.get(item.trackId) || 0) + 1
    );
  }

  return (
    <div className="space-y-6">
      {/* Back Link */}
      <div>
        <Link
          href="/dashboard/playlists"
          className="inline-flex items-center space-x-1.5 text-xs font-medium text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Playlists</span>
        </Link>
      </div>

      {/* Playlist Header Card */}
      <div className="p-6 sm:p-8 rounded-3xl bg-[#12151f] border border-[#1f2438] flex flex-col md:flex-row items-start md:items-center gap-6">
        <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center flex-shrink-0 text-white shadow-xl shadow-purple-900/30">
          <ListMusic className="w-12 h-12" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 text-xs text-purple-400 font-semibold mb-1 uppercase tracking-wider">
            <span>Canonical Playlist</span>
            <span>•</span>
            <span className="flex items-center space-x-1 text-gray-400">
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

          <h1 className="text-2xl sm:text-3xl font-extrabold text-white truncate">
            {playlist.title}
          </h1>

          <p className="mt-1 text-xs sm:text-sm text-gray-400 line-clamp-2">
            {playlist.description || "No description provided."}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-gray-400">
            <span className="font-semibold text-white">
              {playlist.items.length} {playlist.items.length === 1 ? "track" : "tracks"}
            </span>
            <span>•</span>
            <span className="flex items-center space-x-1">
              <Clock className="w-3.5 h-3.5 text-gray-500" />
              <span>{formatDuration(totalDurationMs)}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Playlist Tracklist */}
      {playlist.items.length === 0 ? (
        <div className="p-8 rounded-2xl bg-[#12151f] border border-[#1f2438] text-center text-xs text-gray-400">
          This playlist does not have any items yet.
        </div>
      ) : (
        <div className="rounded-2xl bg-[#12151f] border border-[#1f2438] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0e111a] text-gray-400 border-b border-[#1f2438] uppercase font-semibold">
                <tr>
                  <th scope="col" className="px-4 py-3 w-12 text-center">#</th>
                  <th scope="col" className="px-4 py-3">Title & Artist</th>
                  <th scope="col" className="px-4 py-3">Album</th>
                  <th scope="col" className="px-4 py-3">Notes / Status</th>
                  <th scope="col" className="px-4 py-3 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f2438]/50 text-gray-300">
                {playlist.items.map((item) => {
                  const isRepeated = (trackOccurrenceCounts.get(item.trackId) || 0) > 1;
                  return (
                    <tr key={item.id} className="hover:bg-[#181c2b] transition-colors">
                      <td className="px-4 py-3 text-center text-gray-400 font-mono font-medium">
                        {item.position + 1}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center space-x-3">
                          <div className="w-8 h-8 rounded-lg bg-[#1f2438] flex items-center justify-center flex-shrink-0 text-purple-400">
                            <Disc className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center space-x-2">
                              <span className="font-semibold text-white">{item.track.title}</span>
                              {isRepeated && (
                                <span className="inline-flex items-center space-x-0.5 px-1.5 py-0.5 rounded bg-indigo-950/60 border border-indigo-500/30 text-indigo-300 text-[10px]" title="This track appears multiple times in this playlist with order preserved">
                                  <Repeat className="w-2.5 h-2.5" />
                                  <span>Repeat</span>
                                </span>
                              )}
                            </div>
                            <p className="text-gray-400">{item.track.artistName}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {item.track.albumName || "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {item.notes ? (
                          <span className="italic text-gray-400">{item.notes}</span>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
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
      )}
    </div>
  );
}
