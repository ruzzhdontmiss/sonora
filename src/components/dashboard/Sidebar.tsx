"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Music,
  ListMusic,
  Radio,
  ArrowLeftRight,
  RefreshCw,
  HardDriveDownload,
  Disc3,
} from "lucide-react";
import { clsx } from "clsx";

export const NAVIGATION_ITEMS = [
  { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { name: "Library", href: "/dashboard/library", icon: Music },
  { name: "Playlists", href: "/dashboard/playlists", icon: ListMusic },
  { name: "Connections", href: "/dashboard/connections", icon: Radio },
  { name: "Transfer", href: "/dashboard/transfer", icon: ArrowLeftRight },
  { name: "Sync Rules", href: "/dashboard/sync", icon: RefreshCw },
  { name: "Backups", href: "/dashboard/backups", icon: HardDriveDownload },
];

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={clsx(
          "fixed top-0 bottom-0 left-0 z-50 w-64 bg-[#12151f] border-r border-[#1f2438] flex flex-col transition-transform duration-200 lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
        aria-label="Main Navigation"
      >
        {/* Brand */}
        <div className="h-16 px-6 border-b border-[#1f2438] flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/30">
              <Disc3 className="w-4 h-4" />
            </div>
            <span className="font-bold tracking-tight text-white text-lg">SONORA</span>
          </Link>
          <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-950 text-indigo-400 border border-indigo-800/40">
            Phase 1
          </span>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          {NAVIGATION_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className={clsx(
                  "flex items-center space-x-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all group focus:outline-none focus:ring-2 focus:ring-indigo-500",
                  isActive
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                    : "text-gray-400 hover:text-white hover:bg-[#1f2438]/60"
                )}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon
                  className={clsx(
                    "w-4 h-4 transition-colors",
                    isActive ? "text-white" : "text-gray-400 group-hover:text-white"
                  )}
                />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom Platform Disclaimer */}
        <div className="p-4 border-t border-[#1f2438] text-[11px] text-gray-500 leading-normal">
          <p className="font-semibold text-gray-400 mb-1">Universal Music Platform</p>
          <p>Provider-neutral metadata storage. Audio files are neither stored nor proxied.</p>
        </div>
      </aside>
    </>
  );
}
