/**
 * Pure logic for the homepage "fifty analysts" hero stat strip
 * (hero_variant fifty_analysts_v1).
 *
 * No framework imports on purpose — tests/test_hero_universe.py exercises this
 * file directly under `node --experimental-strip-types` (same pattern as
 * web/lib/screen/transforms.ts). The one live number the strip shows — the
 * universe count — is fetched in web/lib/hero-universe-query.ts and formatted
 * here.
 */

// Live universe count → "5,826" (thousands separator, en-US). Fed the count
// of US-listed equities in the screener universe; never a hardcoded number.
export function formatUniverseCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// "DD Mon YYYY" — e.g. "20 Jul 2026". Fed the data-compile date (the date the
// cached loader last ran), never the request date.
export function formatSnapshotDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const mon = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `${String(d.getUTCDate()).padStart(2, "0")} ${mon} ${d.getUTCFullYear()}`;
}
