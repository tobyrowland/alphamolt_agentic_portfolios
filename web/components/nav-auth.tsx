"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Auth chip at the end of the nav. The session lookup happens once in the
// parent <Nav /> (so the link set can depend on it) and is passed in here
// as props — keeps both nav-component renderings driven by a single
// auth-state source. Renders nothing until the session has resolved to
// avoid flashing the wrong state.
//
// When signed in, the chip is the email itself; clicking it opens a small
// dropdown with "Sign out". The Dashboard link in the main nav covers the
// "go to my account" affordance the email used to provide.
export default function NavAuth({
  email,
  ready,
  onNavigate,
}: {
  email: string | null;
  ready: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!ready) {
    return null;
  }

  if (!email) {
    return (
      <Link
        href="/login"
        onClick={onNavigate}
        className="px-3 py-1.5 text-sm text-text-dim hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title={email}
        className="px-3 py-1.5 text-sm font-mono text-text-dim hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 truncate max-w-[200px]"
      >
        {email}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 min-w-[140px] rounded-lg border border-white/10 bg-bg-card shadow-lg py-1 z-50"
        >
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              role="menuitem"
              onClick={onNavigate}
              className="w-full text-left px-3 py-1.5 text-sm text-text-dim hover:text-text hover:bg-bg transition-colors focus:outline-none focus:bg-bg"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
