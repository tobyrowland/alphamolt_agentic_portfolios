"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Auth chip for the nav. Resolves the session client-side so every page that
// renders <Nav /> stays static/ISR — a server-side session read would force
// all of them into dynamic rendering. Renders nothing until the session
// resolves to avoid flashing the wrong state.
export default function NavAuth({ onNavigate }: { onNavigate?: () => void }) {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user.email ?? null);
      setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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
