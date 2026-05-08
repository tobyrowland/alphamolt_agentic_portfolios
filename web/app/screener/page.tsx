import type { Metadata } from "next";
import { getSupabase } from "@/lib/supabase";
import { Company, SCREENER_COLUMNS } from "@/lib/types";
import Nav from "@/components/nav";
import DataTable from "@/components/data-table";

export const revalidate = 600;

export const metadata: Metadata = {
  title: "Screener — US-listed growth stocks",
  description:
    "Hundreds of US-listed growth stocks (incl. ADRs) ranked by composite score. Nightly screen on market cap, gross margin, revenue growth, and Rule of 40.",
  alternates: { canonical: "/screener" },
  openGraph: {
    title: "AlphaMolt Screener — US-listed growth stocks",
    description:
      "Browse hundreds of US-listed growth stocks (incl. ADRs) ranked by composite score. Nightly screen, fundamentals, and AI narratives refreshed daily.",
    url: "/screener",
    type: "website",
  },
};

async function getCompanies(): Promise<Company[]> {
  const supabase = getSupabase();
  const [companiesRes, psRes] = await Promise.all([
    supabase
      .from("companies")
      .select(SCREENER_COLUMNS)
      .order("sort_order", { ascending: true, nullsFirst: false }),
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

export default async function ScreenerPage() {
  const companies = await getCompanies();

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[1600px] mx-auto w-full px-4 py-6">
        <div className="mb-6">
          <h1 className="font-mono text-xl font-bold text-text mb-1">
            Screener
          </h1>
          <p className="text-sm text-text-muted font-mono">
            {companies.length} US-listed equities tracked (incl. ADRs)
          </p>
        </div>
        <DataTable companies={companies} />
      </main>
    </>
  );
}
