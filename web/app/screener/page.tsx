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

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await resolveParams(searchParams);
  const config = (sp.screen ? await savedConfig(sp.screen) : null) ?? configFromParams(sp);
  const initial = await runScreen(config);

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1280px] mx-auto w-full px-4 sm:px-6 py-8 sm:py-12">
          <header className="mb-6 max-w-[760px]">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Stock screener
            </p>
            <h1 className="mt-2 text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
              Stock Screener
            </h1>
            <p className="mt-3 text-base text-text-muted leading-relaxed">
              All US-listed equities (incl. ADRs), ranked by a composite score
              you control. Write a brief or tune the knobs — the table re-ranks
              live and the config lives in the URL.
            </p>
            <p className="mt-2 text-xs text-text-muted">
              Prices 15-minute delayed (EODHD) · ranked by your configured
              composite · a research tool, not a recommendation.
            </p>
          </header>

          <ScreenerClient
            initialConfig={config}
            initialData={{
              rows: initial.rows.map((r) => ({
                rank: r.rank,
                ticker: r.ticker,
                name: r.name,
                sector: r.sector,
                country: r.country,
                price: r.price,
                price_asof: r.price_asof,
                score: r.score,
                ps: r.ps,
                rev_growth_ttm: r.rev_growth_ttm,
                gross_margin: r.gross_margin,
                fcf_margin: r.fcf_margin,
                rule_of_40: r.rule_of_40,
                ret_52w: r.ret_52w,
                bull: r.bull,
                bear: r.bear,
              })),
              match_count: initial.match_count,
              total_universe: initial.total_universe,
              cut_index: initial.cut_index,
              data_asof: initial.data_asof,
            }}
            defaultEncoded={encodeConfig(configFromParams({ preset: DEFAULT_PRESET }))}
          />
        </div>
      </main>
    </>
  );
}
