import Link from "next/link";
import { Disc3, ShieldCheck, ArrowRight, Layers, RefreshCw } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col justify-between">
      {/* Header */}
      <header className="border-b border-[#1f2438] bg-[#12151f]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
              <Disc3 className="w-5 h-5 animate-spin-slow" />
            </div>
            <span className="text-xl font-bold tracking-tight text-white">SONORA</span>
          </div>

          <div className="flex items-center space-x-4">
            <Link
              href="/login"
              className="text-sm font-medium text-gray-300 hover:text-white transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="/dashboard"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-md shadow-indigo-600/20"
            >
              Go to Dashboard
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 max-w-7xl mx-auto px-6 py-20 flex flex-col items-center text-center justify-center">
        <div className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-full border border-indigo-500/30 bg-indigo-950/40 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-8">
          <ShieldCheck className="w-4 h-4" />
          <span>Universal Music Library & Portability</span>
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white max-w-4xl leading-tight sm:leading-none">
          Own your music library across every streaming platform.
        </h1>

        <p className="mt-6 text-lg sm:text-xl text-gray-400 max-w-2xl leading-relaxed">
          SONORA decouples your music metadata, playlists, and listening history from streaming provider lock-in.
          Transfer, backup, and sync between Spotify, Apple Music, and YouTube without losing your curation.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row items-center gap-4">
          <Link
            href="/login"
            className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-base transition-all flex items-center justify-center space-x-2 shadow-xl shadow-indigo-600/30"
          >
            <span>Launch Dashboard Shell</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {/* Feature Grid */}
        <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-6 text-left w-full max-w-5xl">
          <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438]">
            <div className="w-10 h-10 rounded-lg bg-indigo-950/50 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-4">
              <Layers className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Canonical Library</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Provider-independent data architecture where external streaming IDs map cleanly to canonical tracks without primary key lock-in.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438]">
            <div className="w-10 h-10 rounded-lg bg-emerald-950/50 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-4">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Strict Secret Protection</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Authenticated at-rest encryption for OAuth tokens, safe server-only environment configurations, and zero browser credential exposure.
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438]">
            <div className="w-10 h-10 rounded-lg bg-amber-950/50 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-4">
              <RefreshCw className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Deterministic Transfer</h3>
            <p className="text-sm text-gray-400 leading-relaxed">
              Auditable playlist transfer preserving exact track ordering and duplicates, with human match confirmation for ambiguous songs.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#1f2438] py-8 text-center text-xs text-gray-500">
        SONORA does not stream or redistribute audio files. Stores music metadata and user library relationships only.
      </footer>
    </div>
  );
}
