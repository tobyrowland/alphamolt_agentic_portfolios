import type { Metadata } from "next";
import Nav from "@/components/nav";
import {
  DEFAULT_PRESET,
  PRESETS,
  configFromParams,
  encodeConfig,
  isHousePreset,
} from "@/lib/screen/config";
import { runScreen } from "@/lib/screen/query";
import { listActiveExclusions } from "@/lib/screen/exclusions-query";
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
  const house = isHousePreset(config) && !config.filters.some((f) => f.field === "sector");
  const sector = sp.sector;
  const presetMeta = config.preset ? PRESETS[config.preset] : undefined;

  let title: string;
  let description: string;
  let canonical: string;
  if (sector) {
    title = `${sector} Stock Screener — AI-ranked US equities | alphamolt`;
    description = `All US-listed ${sector} equities ranked by a composite score you control: growth, margins, FCF and Rule of 40, weighted to taste. Research only.`;
    canonical = `/screener?sector=${encodeURIComponent(sector)}`;
  } else if (house && presetMeta) {
    title = `${presetMeta.label} Stock Screener — AI-Ranked US Equities | alphamolt`;
    description = `${presetMeta.description} Configure filters and score weighting; share the exact screen via its URL. Research only — not financial advice.`;
    canonical = `/screener?preset=${presetMeta.id}`;
  } else {
    title = "Stock Screener — All US Equities, Ranked by a Score You Control | alphamolt";
    description =
      "All US-listed equities (incl. ADRs) ranked by a quality-growth composite you control: revenue growth, margins, FCF and Rule of 40, weighted to taste.";
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

/**
 * Tickers that have a /company/<ticker> page. The page now renders any active
 * Tier 1 security straight from the Level 0 fact store, so EVERY name the
 * screener ranks is linkable — gate on `securities.is_tier1` (active), which
 * is the same universe the screen ranks over.
 */
async function getCompanyTickers(): Promise<string[]> {
  const tickers: string[] = [];
  const supabase = getSupabase();
  const PAGE = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from("securities")
      .select("ticker")
      .eq("is_tier1", true)
      .eq("status", "active")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) {
      console.error("getCompanyTickers failed:", error);
      break;
    }
    const batch = (data ?? []) as { ticker: string }[];
    tickers.push(...batch.map((r) => r.ticker));
    if (batch.length < PAGE) break;
  }
  return tickers;
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
  const [initial, companyTickers, exclusions] = await Promise.all([
    runScreen(config),
    getCompanyTickers(),
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
            initialData={{
              rows: initial.rows.map((r) => ({
                rank: r.rank,
                ticker: r.ticker,
                name: r.name,
                sector: r.sector,
                industry: r.industry,
                country: r.country,
                price: r.price,
                price_asof: r.price_asof,
                score: r.score,
                ps: r.ps,
                ps_median_12m: r.ps_median_12m,
                ps_trend_pct: r.ps_trend_pct,
                rev_growth_ttm: r.rev_growth_ttm,
                gross_margin: r.gross_margin,
                fcf_margin: r.fcf_margin,
                net_margin: r.net_margin,
                operating_margin: r.operating_margin,
                rule_of_40: r.rule_of_40,
                ret_52w: r.ret_52w,
                perf_52w_vs_spy: r.perf_52w_vs_spy,
                bull: r.bull,
                bear: r.bear,
                bull_score: r.bull_score,
                bear_score: r.bear_score,
                // Single-score + research-card fields (migration 057).
                base_z: r.base_z,
                adj_z: r.adj_z,
                moat_z: r.moat_z,
                earn_z: r.earn_z,
                break_z: r.break_z,
                base_pct: r.base_pct,
                final_pct: r.final_pct,
                capped: r.capped,
                floored: r.floored,
                quality_score: r.quality_score,
                moat_score: r.moat_score,
                earnings_score: r.earnings_score,
                growth_score: r.growth_score,
                break_count: r.break_count,
                firing_breaks: r.firing_breaks,
                has_card: r.has_card,
                research_card: r.research_card,
                industry_ps_median: r.industry_ps_median,
                sector_ps_median: r.sector_ps_median,
                peer_ps_median: r.peer_ps_median,
                peer_basis: r.peer_basis,
              })),
              match_count: initial.match_count,
              total_universe: initial.total_universe,
              cut_index: initial.cut_index,
              data_asof: initial.data_asof,
            }}
            sectors={initial.sectors}
            industries={initial.industries}
            companyTickers={companyTickers}
            exclusions={exclusions.map((e) => e.ticker)}
            defaultEncoded={encodeConfig(configFromParams({ preset: DEFAULT_PRESET }))}
          />
        </div>
      </main>
    </>
  );
}
