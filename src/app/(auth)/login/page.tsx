"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Disc3, ShieldCheck, UserCheck, AlertCircle, Lock } from "lucide-react";
import Link from "next/link";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDemoLogin() {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ demoUser: true }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      router.push(callbackUrl);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#090a0f]">
      <div className="w-full max-w-md bg-[#12151f] border border-[#1f2438] rounded-3xl p-8 shadow-2xl shadow-black/80">
        <div className="flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center text-white mb-4 shadow-lg shadow-indigo-600/30">
            <Disc3 className="w-6 h-6 animate-spin-slow" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">SONORA Sign In</h1>
          <p className="mt-2 text-sm text-gray-400">
            Phase 1 Foundation Shell
          </p>
        </div>

        {error && (
          <div className="mt-6 p-4 rounded-xl bg-red-950/40 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Development Demo Notice */}
        <div className="mt-6 p-4 rounded-xl bg-[#090a0f] border border-[#1f2438] text-xs text-gray-400 space-y-2">
          <div className="flex items-center space-x-2 text-amber-400 font-semibold">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>Phase 1 Authentication Boundary</span>
          </div>
          <p className="leading-relaxed">
            Passwordless email login has been removed to prevent unauthorized account access. Production authentication (OAuth / secure provider integration) will be established in later tickets.
          </p>
          <p className="text-gray-500">
            Only the explicitly enabled local development demo user is available in this environment (<code className="text-gray-400">DEMO_AUTH_ENABLED=true</code>).
          </p>
        </div>

        {/* Demo Login Action */}
        <div className="mt-6">
          <button
            type="button"
            onClick={handleDemoLogin}
            disabled={isLoading}
            className="w-full py-3.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium flex items-center justify-center space-x-2 transition-all shadow-lg shadow-indigo-600/25"
          >
            <UserCheck className="w-4 h-4" />
            <span>{isLoading ? "Signing in..." : "Sign In as Local Demo User"}</span>
          </button>
        </div>

        <div className="mt-6 p-3 rounded-xl bg-[#12151f] border border-[#1f2438] text-center text-xs text-gray-500 flex items-center justify-center space-x-2">
          <Lock className="w-3.5 h-3.5 text-gray-500" />
          <span>Production and remote deployments fail closed.</span>
        </div>

        <div className="mt-8 pt-6 border-t border-[#1f2438] flex items-center justify-between text-xs text-gray-500">
          <span className="flex items-center space-x-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>HTTP-only SameSite=Lax Session</span>
          </span>
          <Link href="/" className="hover:text-gray-400 transition-colors">
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#090a0f] text-gray-400 text-sm">
          Loading login...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
