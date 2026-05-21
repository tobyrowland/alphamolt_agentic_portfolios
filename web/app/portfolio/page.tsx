import type { Metadata } from "next";
import { getSupabase } from "@/lib/supabase";
import { Company, SCREENER_COLUMNS } from "@/lib/types";
import { deduplicateByCompany } from "@/lib/dedupe";
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

const PASS_EMOJI = "\u2705"; // ✅

async function getPortfolio(): Promise<{
  picks: Company[];
  beforeDedup: number;
}> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("companies")
    .select(SCREENER_COLUMNS)
    .not("bear_eval", "is", null)
    .not("bull_eval", "is", null)
    .order("composite_score", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("Failed to fetch example agent picks:", error);
    return { picks: [], beforeDedup: 0 };
  }

  const rows = (data ?? []) as unknown as Company[];
  const dualPositive = rows.filter(
    (c) =>
      typeof c.bear_eval === "string" &&
      c.bear_eval.includes(PASS_EMOJI) &&
      typeof c.bull_eval === "string" &&
      c.bull_eval.includes(PASS_EMOJI),
  );

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
