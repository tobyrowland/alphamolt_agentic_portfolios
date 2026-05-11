import type { Metadata } from "next";
import { getSupabase } from "@/lib/supabase";
import { Company, SCREENER_COLUMNS } from "@/lib/types";
import Nav from "@/components/nav";
import DataTable from "@/components/data-table";

export const revalidate = 600;

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
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 py-6">
        <div className="mb-6">
          <h1 className="font-mono text-xl font-bold text-text mb-1">
            {heading}
          </h1>
          <p className="text-sm text-text-muted font-mono">{sub}</p>
        </div>
        <DataTable companies={companies} />
      </main>
    </>
  );
}
