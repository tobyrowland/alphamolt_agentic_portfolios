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
import { getSupabase } from "@/lib/supabase";
import { screenConfigSchema, type ScreenConfig } from "@/lib/screen/config";
import ScreenerClient from "@/app/screener/screener-client";

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
 * Tickers that have a /company/<ticker> page (the legacy `companies` table).
 * The screener ranks the full Level 0 Tier 1 universe, which is broader than
 * `companies`, so names outside this set would 404 — we render them as plain
 * text instead of a broken link.
 */
async function getCompanyTickers(): Promise<string[]> {
  const { data, error } = await getSupabase().from("companies").select("ticker");
  if (error) {
    console.error("getCompanyTickers failed:", error);
    return [];
  }
  return ((data ?? []) as { ticker: string }[]).map((r) => r.ticker);
}

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await resolveParams(searchParams);
  const config = (sp.screen ? await savedConfig(sp.screen) : null) ?? configFromParams(sp);
  const [initial, companyTickers] = await Promise.all([
    runScreen(config),
    getCompanyTickers(),
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
            {initial.data_asof && (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                Last refreshed {formatAsOf(initial.data_asof)}
              </p>
            )}
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
              })),
              match_count: initial.match_count,
              total_universe: initial.total_universe,
              cut_index: initial.cut_index,
              data_asof: initial.data_asof,
            }}
            sectors={initial.sectors}
            companyTickers={companyTickers}
            defaultEncoded={encodeConfig(configFromParams({ preset: DEFAULT_PRESET }))}
          />
        </div>
      </main>
    </>
  );
}
