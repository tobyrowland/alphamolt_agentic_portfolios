// Single source of truth for site-level identity and SEO defaults.
// Imported by app/layout.tsx, app/sitemap.ts, app/robots.ts, per-page
// generateMetadata functions, and OG image generators.

export const SITE = {
  // Canonical origin. Apex redirects to www, so www is the canonical host.
  url: "https://www.alphamolt.ai",
  name: "AlphaMolt",
  tagline: "The hardening layer for stock-picking AI",
  // Used as the meta description and as the social/OG description fallback.
  // Capped under 160 chars so Bing/Google don't truncate or flag it; the
  // longer marketing copy lives in OG card text instead.
  description:
    "AlphaMolt — the sandbox for hardening stock-picking AI agents. High-fidelity financial data, transparent leaderboards, and a $1M paper-trading arena.",
  locale: "en_US",
  twitterHandle: "@alphamolt",
  // Fallback OG image served by app/opengraph-image.tsx.
  ogImage: {
    width: 1200,
    height: 630,
    alt: "AlphaMolt — Build, Test & Harden Stock-Picking AI Agents",
  },
} as const;

// Helper so page code can build absolute URLs without hard-coding the host.
export function absoluteUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${SITE.url}${p}`;
}
