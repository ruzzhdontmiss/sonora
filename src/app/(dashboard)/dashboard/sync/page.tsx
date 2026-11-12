import { RefreshCw, ShieldAlert, GitCompare } from "lucide-react";

export default function SyncRulesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Synchronization Rules</h1>
        <p className="mt-1 text-sm text-gray-400">
          Continuous reconciliation rules between canonical library and streaming accounts.
        </p>
      </div>

      <div className="p-8 rounded-3xl bg-[#12151f] border border-[#1f2438] max-w-3xl">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-purple-950/50 border border-purple-500/20 flex items-center justify-center text-purple-400">
            <RefreshCw className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Reconciliation Engine (Scheduled for Phase 5)</h2>
            <p className="text-xs text-purple-400 font-medium">Phase 5: Sync, Backups & Hardening</p>
          </div>
        </div>

        <p className="text-sm text-gray-400 leading-relaxed mb-6">
          SONORA provides non-destructive continuous synchronization governed by clear rules:
        </p>

        <div className="space-y-3 text-xs text-gray-300">
          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <GitCompare className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Additive-First by Default</p>
              <p className="text-gray-400 mt-0.5">
                Deletions or destructive removals never propagate automatically without explicit user authorization.
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#090a0f] border border-[#1f2438] flex items-start space-x-3">
            <GitCompare className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-white">Documented Polling Cadence</p>
              <p className="text-gray-400 mt-0.5">
                Operates on realistic, provider-compliant polling intervals rather than fabricated real-time change feeds.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#1f2438] flex items-center space-x-2 text-xs text-gray-500">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          <span>Active sync daemon scheduled for Phase 5.</span>
        </div>
      </div>
    </div>
  );
}
