"use client";

import { useRouter } from "next/navigation";
import { LogOut, Menu, User, ShieldCheck } from "lucide-react";
import { useState } from "react";

interface HeaderProps {
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  onToggleSidebar?: () => void;
}

export function Header({ user, onToggleSidebar }: HeaderProps) {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      router.push("/login");
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <header className="h-16 border-b border-[#1f2438] bg-[#12151f]/80 backdrop-blur-md sticky top-0 z-30 px-6 flex items-center justify-between">
      <div className="flex items-center space-x-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
          className="lg:hidden p-2 rounded-lg bg-[#1f2438] text-gray-300 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="hidden sm:flex items-center space-x-2 text-xs text-gray-400">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Local PostgreSQL & Session Active</span>
        </div>
      </div>

      <div className="flex items-center space-x-4">
        {/* User Badge */}
        <div className="flex items-center space-x-3 px-3 py-1.5 rounded-xl bg-[#090a0f] border border-[#1f2438]">
          <div className="w-6 h-6 rounded-full bg-indigo-600/30 text-indigo-400 flex items-center justify-center">
            <User className="w-3.5 h-3.5" />
          </div>
          <div className="text-left hidden sm:block">
            <p className="text-xs font-semibold text-white leading-none">
              {user.displayName || "User"}
            </p>
            <p className="text-[10px] text-gray-400 leading-none mt-1 truncate max-w-[140px]">
              {user.email}
            </p>
          </div>
        </div>

        {/* Sign Out Button */}
        <button
          type="button"
          onClick={handleLogout}
          disabled={isLoggingOut}
          aria-label="Sign out of SONORA"
          className="p-2 rounded-xl text-gray-400 hover:text-red-400 hover:bg-red-950/20 border border-transparent hover:border-red-900/40 transition-all focus:outline-none focus:ring-2 focus:ring-red-500 text-xs flex items-center space-x-1.5"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden md:inline font-medium">Sign Out</span>
        </button>
      </div>
    </header>
  );
}
