"use client";

import Link from "next/link";

// Auth chip at the end of the nav. The session lookup happens once in the
// parent <Nav /> (so the link set can depend on it) and is passed in here
// as props — keeps both nav-component renderings driven by a single
// auth-state source. Renders nothing until the session has resolved to
// avoid flashing the wrong state.
export default function NavAuth({
  email,
  ready,
  onNavigate,
}: {
  email: string | null;
  ready: boolean;
  onNavigate?: () => void;
}) {
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
    <span className="flex items-center gap-1">
      <Link
        href="/account"
        onClick={onNavigate}
        className="px-3 py-1.5 text-sm font-mono text-text-dim hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 truncate max-w-[180px]"
        title={email}
      >
        {email}
      </Link>
      <form action="/auth/signout" method="post">
        <button
          type="submit"
          className="px-3 py-1.5 text-sm text-text-dim hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40"
        >
          Sign out
        </button>
      </form>
    </span>
  );
}
