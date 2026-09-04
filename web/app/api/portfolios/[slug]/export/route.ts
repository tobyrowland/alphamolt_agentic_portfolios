import { NextResponse } from "next/server";
import { resolveVisiblePortfolio } from "@/lib/portfolio-visibility";
import { getPortfolioExportData } from "@/lib/portfolio-export-query";
import { buildPortfolioExport, exportFilename } from "@/lib/portfolio-export";

export const dynamic = "force-dynamic";

/**
 * The portfolio as one Markdown document, for review by another model.
 *
 * Visibility is `resolveVisiblePortfolio` — the SAME gate as the page itself,
 * not a looser or stricter one. Everything in the pack (holdings, the trade
 * tape, each thesis) is already rendered on that page, so an export that any
 * page viewer can take discloses nothing new; and a private portfolio 404s
 * here exactly as it does there.
 *
 * `?download=1` asks the browser to save it; without it the body is served
 * inline so the page can copy it to the clipboard.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const portfolio = await resolveVisiblePortfolio(slug);
  if (!portfolio) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const data = await getPortfolioExportData(portfolio);
    const markdown = buildPortfolioExport(data);
    const wantsDownload = new URL(request.url).searchParams.has("download");
    const headers: Record<string, string> = {
      "Content-Type": "text/markdown; charset=utf-8",
      // Values move with the market and the tape grows; a cached pack would be
      // stale in a way its own as-of line would not admit to.
      "Cache-Control": "no-store",
    };
    if (wantsDownload) {
      headers["Content-Disposition"] =
        `attachment; filename="${exportFilename(slug, data.generatedAt)}"`;
    }
    return new NextResponse(markdown, { headers });
  } catch (err) {
    console.error("portfolio export failed for", slug, err);
    return new NextResponse("Export failed", { status: 500 });
  }
}
