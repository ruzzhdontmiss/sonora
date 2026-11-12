import { Radio, AlertTriangle, ShieldCheck, Lock } from "lucide-react";

interface ProviderCardProps {
  name: string;
  phase: string;
  authMethod: string;
  notes: string;
  capabilities: string[];
}

const PROVIDERS: ProviderCardProps[] = [
  {
    name: "Spotify",
    phase: "Phase 3 (P3-T01 to P3-T03)",
    authMethod: "Authorization Code with PKCE",
    notes:
      "Subject to Spotify Development Mode restrictions (max 5 registered users, Premium required for app owner). Tokens encrypted at rest.",
    capabilities: ["Read User Playlists", "Read Liked Tracks", "Batch Playlist Writes (Phase 4)"],
  },
  {
    name: "Apple Music",
    phase: "Phase 3 (P3-T04 to P3-T05)",
    authMethod: "MusicKit JS + Server Developer Token",
    notes:
      "Requires Apple Developer Team ID, Key ID, and private .p8 key stored securely on server only.",
    capabilities: ["Read Library Songs", "Read Playlists", "Storefront Catalog Search"],
  },
  {
    name: "YouTube Data API v3",
    phase: "Phase 5 (P5-T01 to P5-T02)",
    authMethod: "Google OAuth 2.0",
    notes:
      "YouTube Data API v3 only. Not a full YouTube Music personal library API. Strict quota cost accounting (50 units per playlist item insert).",
    capabilities: ["Read User Playlists", "Read Liked Videos", "Playlist Insertion with Quota Guardrails"],
  },
];

export default function ConnectionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Streaming Provider Connections</h1>
        <p className="mt-1 text-sm text-gray-400">
          Manage authorized streaming service connections and view live provider capability flags.
        </p>
      </div>

      <div className="p-4 rounded-2xl bg-amber-950/20 border border-amber-500/20 flex items-start space-x-3 text-xs text-amber-300">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" />
        <p className="leading-relaxed">
          <strong className="text-amber-200">Strict Compliance Rule:</strong> SONORA never displays fabricated connection status or mock provider badges. All integrations remain inactive until their respective phases are implemented and reviewed.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PROVIDERS.map((provider) => (
          <div
            key={provider.name}
            className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-8 h-8 rounded-lg bg-[#1f2438] flex items-center justify-center text-gray-300">
                    <Radio className="w-4 h-4" />
                  </div>
                  <h3 className="font-bold text-white text-base">{provider.name}</h3>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                  Not Connected
                </span>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <span className="text-gray-500 font-medium">Scheduled Implementation:</span>
                  <p className="text-indigo-400 font-semibold">{provider.phase}</p>
                </div>

                <div>
                  <span className="text-gray-500 font-medium">Auth Mechanism:</span>
                  <p className="text-gray-300">{provider.authMethod}</p>
                </div>

                <div>
                  <span className="text-gray-500 font-medium">Target Capabilities:</span>
                  <ul className="mt-1 space-y-1 text-gray-400">
                    {provider.capabilities.map((cap) => (
                      <li key={cap} className="flex items-center space-x-1.5">
                        <span className="w-1 h-1 rounded-full bg-gray-500" />
                        <span>{cap}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="pt-2 border-t border-[#1f2438]">
                  <p className="text-[11px] text-gray-400 leading-relaxed italic">{provider.notes}</p>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-[#1f2438]">
              <button
                type="button"
                disabled
                className="w-full py-2.5 px-3 rounded-xl bg-[#1f2438]/50 text-gray-500 text-xs font-semibold flex items-center justify-center space-x-1.5 cursor-not-allowed"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Connect (Pending {provider.phase.split(" ")[0]})</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="p-6 rounded-2xl bg-[#12151f] border border-[#1f2438] flex items-center space-x-4">
        <div className="w-10 h-10 rounded-xl bg-emerald-950/40 border border-emerald-500/20 flex items-center justify-center text-emerald-400 flex-shrink-0">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div className="text-xs text-gray-400 leading-relaxed">
          <p className="font-semibold text-white mb-0.5">Disconnection Safety</p>
          Disconnecting any provider in SONORA will never delete your canonical library records or metadata backups.
        </div>
      </div>
    </div>
  );
}
