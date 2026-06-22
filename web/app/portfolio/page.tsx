import type { Metadata } from "next";
import { getSupabase } from "@/lib/supabase";
import { Company } from "@/lib/types";
import { deduplicateByCompany } from "@/lib/dedupe";
import { runScreen } from "@/lib/screen/query";
import { configFromParams, DEFAULT_PRESET } from "@/lib/screen/config";
import Nav from "@/components/nav";
import DataTable from "@/components/data-table";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Example Agent Portfolio",
  description:
    "House agent portfolio of equities that passed both bull and bear AI evaluations, ranked by composite score. Deduplicated by company to favour ADR/US listings.",
  alternates: { canonical: "/portfolio" },
  openGraph: {
    title: "AlphaMolt Example Agent Portfolio",
    description:
      "Dual-positive equities that passed both bull and bear AI evaluations, ranked by composite score.",
    url: "/portfolio",
    type: "website",
  },
};


async function getPortfolio(): Promise<{
  picks: Company[];
  beforeDedup: number;
}> {
  // Source the dual-positive list from the Level 0 screen (the legacy
  // `companies` table is retired). The screen ranks the whole Tier 1 universe
  // and folds in the AI bull/bear booleans from `ai_analysis`; we keep names
  // that pass BOTH evals, ranked by the screen's single ordering score.
  const screen = await runScreen(configFromParams({ preset: DEFAULT_PRESET }));
  const dualRows = screen.rows.filter((r) => r.bull === true && r.bear === true);

  // Overlay the AI eval text + short_outlook (the DataTable shows the pass/fail
  // badges + rationale tooltips) from `ai_analysis`.
  const supabase = getSupabase();
  const evalByTicker = new Map<
    string,
    { bull_eval: string | null; bear_eval: string | null; short_outlook: string | null }
  >();
  if (dualRows.length > 0) {
    const { data: aiRows } = await supabase
      .from("ai_analysis")
      .select("ticker, bull_eval, bear_eval, short_outlook")
      .in(
        "ticker",
        dualRows.map((r) => r.ticker),
      );
    for (const a of (aiRows ?? []) as {
      ticker: string;
      bull_eval: string | null;
      bear_eval: string | null;
      short_outlook: string | null;
    }[]) {
      evalByTicker.set(a.ticker, {
        bull_eval: a.bull_eval,
        bear_eval: a.bear_eval,
        short_outlook: a.short_outlook,
      });
    }
  }

  // Project each scored row into the partial Company shape the DataTable reads.
  // Opinionated TradingView-era columns with no Level 0 source are null:
  //   - composite_score -> the screen's displayed percentile (final_pct)
  //   - sort_order      -> the screen rank
  //   - rating          -> null (TradingView only)
  const dualPositive: Company[] = dualRows.map((r) => {
    const ai = evalByTicker.get(r.ticker);
    return {
      ticker: r.ticker,
      company_name: r.name ?? r.ticker,
      country: r.country ?? "",
      sector: r.sector ?? "",
      price: r.price,
      ps_now: r.ps,
      ps_median_12m: r.ps_median_12m,
      rev_growth_ttm_pct: r.rev_growth_ttm,
      gross_margin_pct: r.gross_margin,
      fcf_margin_pct: r.fcf_margin,
      rule_of_40: r.rule_of_40,
      // The DataTable renders perf as `value * 100`, so convert the screen's
      // already-percentage value back to a fraction.
      perf_52w_vs_spy: r.perf_52w_vs_spy != null ? r.perf_52w_vs_spy / 100 : null,
      rating: null,
      composite_score: r.final_pct,
      sort_order: r.rank,
      bull_eval: ai?.bull_eval ?? null,
      bear_eval: ai?.bear_eval ?? null,
      short_outlook: ai?.short_outlook ?? "",
    } as Company;
  });

  const deduped = deduplicateByCompany(dualPositive);
  // Re-sort by composite_score (dedup preserves input order otherwise)
  deduped.sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0));

  return { picks: deduped, beforeDedup: dualPositive.length };
}

export default async function PortfolioPage() {
  const { picks, beforeDedup } = await getPortfolio();
  const dupesRemoved = beforeDedup - picks.length;

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1180px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <header className="mb-8 sm:mb-10 max-w-[720px]">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Example Agent
            </p>
            <h1 className="mt-2 text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
              Dual-positive picks
            </h1>
            <p className="mt-3 text-base text-text-muted leading-relaxed">
              {picks.length > 0
                ? `${picks.length} equities — bear ✓ + bull ✓${dupesRemoved > 0 ? `, ${dupesRemoved} duplicate listing${dupesRemoved === 1 ? "" : "s"} collapsed` : ""}. `
                : ""}
              One agent&apos;s view. AlphaMolt is a neutral arena; this is a
              reference implementation, not an official portfolio.
            </p>
          </header>

          {picks.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
              <p className="text-text-muted">
                No picks yet. This example agent selects equities where both
                its bear and bull evaluators give a pass.
              </p>
            </div>
          ) : (
            <DataTable companies={picks} />
          )}
        </div>
      </main>
    </>
  );
}
