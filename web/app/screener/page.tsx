import type { Metadata } from "next";
import Nav from "@/components/nav";
import {
  PRESETS,
  configFromParams,
  isHousePreset,
} from "@/lib/screen/config";
import { runScreen } from "@/lib/screen/query";
import { listActiveExclusions } from "@/lib/screen/exclusions-query";
import { projectDisplayRows } from "@/lib/screen/display-rows";
import { getSupabase } from "@/lib/supabase";
import { screenConfigSchema, type ScreenConfig } from "@/lib/screen/config";
import ScreenerClient from "@/app/screener/screener-client";
import ActivityDrawer from "@/components/activity-drawer";

// Re-rank is live client-side; the SSR paint is cached for crawlers + first
// load. 300s matches the intraday price cadence.
export const revalidate = 300;

type SP = { config?: string; preset?: string; sector?: string; screen?: string };

async function resolveParams(searchParams: Promise<SP>): Promise<SP> {
  const sp = await searchParams;
  return {
    config: typeof sp.config === "string" ? sp.config : undefined,
    preset: typeof sp.preset === "string" ? sp.preset : undefined,
    sector: typeof sp.sector === "string" ? sp.sector : undefined,
    screen: typeof sp.screen === "string" ? sp.screen : undefined,
  };
}

/** A saved screen (?screen=<slug>) resolves to its stored config. Public-read
 *  so a shared saved link works logged-out. */
async function savedConfig(slug: string): Promise<ScreenConfig | null> {
  const { data } = await getSupabase()
    .from("saved_screens")
    .select("config")
    .eq("slug", slug)
    .maybeSingle();
  if (!data?.config) return null;
  const parsed = screenConfigSchema.safeParse(data.config);
  return parsed.success ? parsed.data : null;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SP>;
}): Promise<Metadata> {
  const sp = await resolveParams(searchParams);
  const config = configFromParams(sp);

  // Index curated house presets + sector screens; noindex arbitrary custom
  // permutations (brief §7) so we don't mint near-infinite low-value URLs.
  const house =
    isHousePreset(config) &&
    !config.filters.some((f) => "field" in f && f.field === "sector");
  const sector = sp.sector;
  const presetMeta = config.preset ? PRESETS[config.preset] : undefined;

  // SEO limits (Bing flags violations): the layout's title template appends
  // " | AlphaMolt", so keep the page part ≤ ~45 chars for a rendered title
  // under 60; descriptions stay within 25–160 chars.
  let title: string;
  let description: string;
  let canonical: string;
  if (sector) {
    title = `${sector} Stock Screener`;
    description = `All US-listed ${sector} stocks ranked by a composite you control — growth, margins, FCF, Rule of 40. Research only.`;
    canonical = `/screener?sector=${encodeURIComponent(sector)}`;
  } else if (house && presetMeta) {
    title = `${presetMeta.label} Stock Screener`;
    description = `${presetMeta.description} Configurable, shareable — research only.`;
    canonical = `/screener?preset=${presetMeta.id}`;
  } else {
    title = "Stock Screener — US Stocks, Ranked Your Way";
    description =
      "Every US-listed stock (incl. ADRs) ranked by a composite you control: revenue growth, margins, FCF and Rule of 40, weighted to taste. Research only.";
    canonical = "/screener";
  }

  return {
    title,
    description,
    alternates: { canonical },
    robots: house || sector ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url: canonical, type: "website" },
    twitter: { card: "summary_large_image" },
  };
}

/**
 * Format the screener's freshness stamp (the latest `price_asof` across the
 * Tier 1 universe, i.e. when the daily matview last picked up prices). Parses a
 * date-only `YYYY-MM-DD` in UTC to avoid an off-by-one from the server's
 * timezone; falls back to a full timestamp parse otherwise.
 */
function formatAsOf(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const d = m
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await resolveParams(searchParams);
  const config = (sp.screen ? await savedConfig(sp.screen) : null) ?? configFromParams(sp);
  // NOTE: the SSR paint is anonymous (no auth cookies) so this page stays
  // ISR-cached / indexable. Per-portfolio rejection hiding (migration 051) is
  // resolved client-side via /api/screen (which reads the session) once the
  // viewer is known signed-in — see screener-client's sign-in refetch.
  const [initial, exclusions] = await Promise.all([
    runScreen(config),
    listActiveExclusions(),
  ]);

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1040px] mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
          <header className="mb-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Stock screener
            </p>
            <h1 className="mt-1 text-[23px] font-bold tracking-[-0.02em] leading-[1.1] text-text">
              Stock Screener
            </h1>
            <p className="mt-1.5 font-mono text-[11px] text-text-muted">
              All US-listed equities (incl. ADRs), ranked by a composite you
              control · a research tool, not a recommendation.
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              {initial.data_asof && (
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  Last refreshed {formatAsOf(initial.data_asof)}
                </p>
              )}
              {/* Activity log (clickthrough drawer) — the background data
                  refreshes that shape these rankings, so the screen's freshness
                  is legible, not just asserted. */}
              <ActivityDrawer
                label="Activity log"
                title="Screener activity"
                subtitle="Background data refreshes that shape these rankings."
                endpoint="/api/screen/activity"
                storageKey="alphamolt:activity:screener"
              />
            </div>
          </header>

          <ScreenerClient
            initialConfig={config}
            initialData={projectDisplayRows(initial)}
            sectors={initial.sectors}
            industries={initial.industries}
            exclusions={exclusions.map((e) => e.ticker)}
          />
        </div>
      </main>
    </>
  );
}
