import { NextResponse } from "next/server";
import {
  isViewerOwner,
  resolveVisiblePortfolio,
} from "@/lib/portfolio-visibility";
import { getPortfolioExportData } from "@/lib/portfolio-export-query";
import { buildPortfolioExport, exportFilename } from "@/lib/portfolio-export";

export const dynamic = "force-dynamic";

/**
 * The portfolio as one Markdown document, for review by another model.
 *
 * OWNER ONLY, which is stricter than the page. Most of the pack is already
 * rendered to anyone who can open a public portfolio, so this is not about
 * secrecy — it is that an export is a different act from reading. The pack
 * bundles a competitor's entire strategy, every thesis and the whole trade
 * tape into one file built to be fed to a model, and a public leaderboard
 * entry is not consent to that. Owners export their own books.
 *
 * Two gates, both required: `resolveVisiblePortfolio` (so a private book is
 * invisible as ever) then `isViewerOwner`. A non-owner gets 404 rather than
 * 403 — the route's existence is not worth confirming to someone who cannot
 * use it.
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
  if (!portfolio || !(await isViewerOwner(portfolio))) {
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
