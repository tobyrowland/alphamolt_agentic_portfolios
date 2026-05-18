"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Tab bar for the signed-in account area. Each tab is a real route — the
// portfolio setup page and the (potentially long) watchlist live on
// separate pages so neither bloats the other. The active tab is derived
// from the current pathname.
const TABS = [
  { href: "/account", label: "Portfolio" },
  { href: "/account/watchlist", label: "Watchlist" },
];

export default function AccountTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Account sections"
      className="flex items-center gap-1 border-b border-white/10 mb-6 sm:mb-8"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`relative px-3.5 py-2.5 text-sm font-semibold tracking-tight transition-colors rounded-t focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 ${
              active ? "text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {tab.label}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--color-cyan)]"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
