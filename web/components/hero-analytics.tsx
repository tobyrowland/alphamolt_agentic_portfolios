"use client";

import { useEffect } from "react";
import Link from "next/link";
import { track } from "@vercel/analytics";

/**
 * Analytics for the "fifty analysts" hero (hero_variant fifty_analysts_v1).
 *
 * Three events, all carrying `hero_variant` so this hero can be A/B'd
 * against a successor later:
 *   hero_view                — once, when ≥50% of the hero is visible
 *   hero_cta_primary_click   — "Run your twelve — free"
 *   hero_cta_secondary_click — "See the leaderboard"
 *
 * These are client components only for the event wiring — Next still
 * server-renders their HTML, so the CTA copy stays in view-source
 * (SEO requirement in the hero brief).
 *
 * `HERO_VARIANT` is the single experiment knob: it defaults to the shipped
 * arm at 100%, so adding a B arm later is a one-line change here rather than a
 * redeploy of the hero markup.
 */

export const HERO_VARIANT = "fifty_analysts_v1";

// Renders nothing; observes the hero section and fires hero_view once at
// 50% visibility.
export function HeroViewTracker({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el || typeof IntersectionObserver === "undefined") return;
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !fired) {
            fired = true;
            track("hero_view", { hero_variant: HERO_VARIANT });
            observer.disconnect();
          }
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [targetId]);
  return null;
}

export function HeroCta({
  href,
  event,
  variant,
  children,
}: {
  href: string;
  event: "hero_cta_primary_click" | "hero_cta_secondary_click";
  variant: "primary" | "secondary";
  children: React.ReactNode;
}) {
  const base =
    "inline-flex items-center justify-center w-full md:w-auto px-5 py-2.5 " +
    "rounded-lg text-sm font-semibold tracking-tight transition-colors " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
    "focus-visible:ring-offset-bg";
  const styles =
    variant === "primary"
      ? // Phosphor green fill, dark text — the existing brand green token,
        // no glow (hero visual spec).
        "bg-[var(--color-green)] text-bg hover:bg-[var(--color-green-dim)] " +
        "focus-visible:ring-[var(--color-green)]/60"
      : "border border-white/20 text-text hover:bg-white/[0.06] " +
        "focus-visible:ring-text/40";
  return (
    <Link
      href={href}
      onClick={() => track(event, { hero_variant: HERO_VARIANT })}
      className={`${base} ${styles}`}
    >
      {children}
    </Link>
  );
}
