"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Logo from "@/components/logo";
import NavAuth from "@/components/nav-auth";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Links available to every visitor.
const PUBLIC_LINKS: { href: string; label: string }[] = [
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/docs", label: "Docs" },
];

// Links injected only when the visitor is signed in. Slotted in front of
// the public set so the user's own surfaces ("Dashboard" / "Watchlist" /
// "Portfolio") sit at the start of the nav row. "Portfolio" is a
// server-side redirect to /portfolios/<owner's slug> via
// /account/portfolio.
const AUTHED_LINKS: { href: string; label: string }[] = [
  { href: "/account", label: "Dashboard" },
  { href: "/account/watchlist", label: "Watchlist" },
  { href: "/account/portfolio", label: "Portfolio" },
];

export default function Nav() {
  // Border shows only once the user has scrolled past the hero on the
  // homepage. On inner pages scrollY starts ~0 anyway but quickly crosses
  // the threshold, so the border reappears naturally.
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Session state is resolved client-side so every page that renders
  // <Nav /> stays static/ISR-eligible — a server-side session read would
  // force all of them into dynamic rendering. We hold it here (rather
  // than inside NavAuth alone) because the link set depends on it too.
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 160);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile menu on Esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setEmail(session?.user.email ?? null);
        setReady(true);
      },
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  // Until session resolves we render the public set only — same SSR HTML
  // as before, so there's no hydration mismatch. The authed links pop in
  // a tick later for signed-in visitors.
  const links = useMemo(
    () => (ready && email ? [...AUTHED_LINKS, ...PUBLIC_LINKS] : PUBLIC_LINKS),
    [ready, email],
  );

  return (
    <header
      className={`sticky top-0 z-50 bg-bg/90 backdrop-blur-md transition-[border-color] duration-200 ${
        scrolled ? "border-b border-white/10" : "border-b border-transparent"
      }`}
    >
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded"
          onClick={() => setMenuOpen(false)}
        >
          <Logo size={24} title="AlphaMolt" />
          <span className="text-base font-medium tracking-tight text-text">
            alphamolt
          </span>
        </Link>

        <nav className="hidden sm:flex items-center gap-1">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="px-3 py-1.5 text-sm text-text-dim hover:text-text transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40"
            >
              {link.label}
            </Link>
          ))}
          <NavAuth email={email} ready={ready} />
        </nav>

        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((v) => !v)}
          className="sm:hidden text-sm text-text-dim hover:text-text px-3 py-1.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40"
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>

      {menuOpen && (
        <div
          id="mobile-menu"
          className="sm:hidden border-t border-white/10 bg-bg/95 backdrop-blur-md"
        >
          <nav className="px-4 py-3 flex flex-col">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="py-2 text-sm text-text-dim hover:text-text transition-colors"
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {/* Inline auth on mobile — don't nest sign-out behind a
                dropdown the way NavAuth does on desktop. The
                absolutely-positioned dropdown is fiddly inside the menu
                drawer's stacking context, so on mobile we show the email
                as a plain label and a top-level Sign-out form. */}
            <div className="pt-2 mt-2 border-t border-white/10">
              {ready && email ? (
                <>
                  <p className="py-1 text-[11px] font-mono text-text-muted truncate">
                    Signed in as {email}
                  </p>
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      onClick={() => setMenuOpen(false)}
                      className="w-full text-left py-2 text-sm text-text-dim hover:text-text transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 rounded"
                    >
                      Sign out
                    </button>
                  </form>
                </>
              ) : ready && !email ? (
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className="block py-2 text-sm text-text-dim hover:text-text transition-colors"
                >
                  Sign in
                </Link>
              ) : null}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
