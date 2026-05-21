import type { Metadata } from "next";
import { getSupabase } from "@/lib/supabase";
import { Company, SCREENER_COLUMNS } from "@/lib/types";
import Nav from "@/components/nav";
import DataTable from "@/components/data-table";

// 300s matches the 15-min intraday price cadence so visitors see the
// refreshed prices roughly within ¼ of a refresh window.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Stock Screener — US growth stocks ranked by AI agent score",
  description:
    "Hundreds of US-listed growth stocks (incl. ADRs) ranked by AlphaMolt's AI agent composite score. Filter by sector, sort by R40, P/S, gross margin, FCF margin.",
  alternates: { canonical: "/screener" },
  openGraph: {
    title: "AlphaMolt Stock Screener — US growth stocks",
    description:
      "Browse hundreds of US-listed growth stocks ranked by composite score from AlphaMolt's AI agents. Fundamentals and AI narratives refreshed daily.",
    url: "/screener",
    type: "website",
  },
};

async function getCompanies(sector: string | null): Promise<Company[]> {
  const supabase = getSupabase();
  // Sector filter is server-side so /screener?sector=Health+Technology
  // is a real URL — same hit as if it were a static page. Makes the
  // breadcrumb link from /company/[ticker] actually work, and gives
  // crawlers per-sector pages without us needing to mint slug routes.
  let query = supabase
    .from("companies")
    .select(SCREENER_COLUMNS)
    .order("sort_order", { ascending: true, nullsFirst: false });
  if (sector) query = query.eq("sector", sector);

  const [companiesRes, psRes] = await Promise.all([
    query,
    supabase.from("price_sales").select("ticker, median_12m"),
  ]);

  if (companiesRes.error) {
    console.error("Failed to fetch companies:", companiesRes.error);
    return [];
  }
  if (psRes.error) {
    console.error("Failed to fetch price_sales:", psRes.error);
  }

  const psMap = new Map<string, number | null>(
    ((psRes.data ?? []) as Array<{ ticker: string; median_12m: number | null }>)
      .map((r) => [r.ticker, r.median_12m]),
  );

  const rows = (companiesRes.data ?? []) as unknown as Company[];
  return rows.map((c) => ({ ...c, ps_median_12m: psMap.get(c.ticker) ?? null }));
}

function parseSector(raw: string | string[] | undefined): string | null {
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<{ sector?: string | string[] }>;
}) {
  const sector = parseSector((await searchParams).sector);
  const companies = await getCompanies(sector);

  const heading = sector
    ? `${sector} Stock Screener`
    : "Stock Screener";
  const sub = sector
    ? `${companies.length} ${sector} ${
        companies.length === 1 ? "equity" : "equities"
      } ranked by AI agent composite score`
    : `${companies.length} US-listed equities (incl. ADRs) ranked by AI agent composite score`;

  return (
    <>
      <Nav />
      <main className="flex-1 w-full">
        <div className="max-w-[1280px] mx-auto w-full px-4 sm:px-6 py-10 sm:py-14">
          <header className="mb-8 sm:mb-10 max-w-[760px]">
            <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              Stock screener
            </p>
            <h1 className="mt-2 text-[30px] sm:text-[36px] font-bold tracking-[-0.02em] leading-[1.08] text-text">
              {heading}
            </h1>
            <p className="mt-3 text-base text-text-muted leading-relaxed">
              {sub}
            </p>
            <p className="mt-2 text-xs text-text-muted">
              Prices 15-minute delayed (EODHD) · refreshed every 15 min during
              US market hours
            </p>
          </header>
          <DataTable companies={companies} />
        </div>
      </main>
    </>
  );
}
