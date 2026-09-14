// Render one or more portfolios' review packs to JSON, from a plain node process.
//
// The weekly review email (weekly_review_emails.py) hands each owner's book to
// a model for critique. The document it hands over is the SAME one the
// portfolio page's "Copy for AI review" button produces — built by
// web/lib/portfolio-export.ts from web/lib/portfolio-export-query.ts — so the
// email and the button can never describe one book two ways, and every
// honesty rule the pack enforces (closed positions included, marks stated as
// closes, defects declared) reaches the email for free.
//
// Neither module imports anything from Next, so they run under node with the
// web app's runtime dependencies installed (`npm ci --omit=dev` in web/) and
// the same alias hook the test runners use for `@/` imports.
//
// Usage (from the repo root, Node >= 22.6):
//   node --experimental-strip-types web/scripts/review-pack.mjs SLUG [SLUG ...]
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_KEY. Writes one JSON object to stdout,
// keyed by slug: {markdown, generatedAt, pricedAsOf, totalValue, returnPct,
// holdings} on success, or {error} for that slug — one book failing never
// loses the others. Diagnostics go to stderr only, so stdout stays parseable.
import "../../tests/ts_web_alias_hook.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Argument check before any import: the web modules need npm packages that
// a bare checkout does not have, and a usage error must not read as one.
const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  process.stderr.write("usage: review-pack.mjs SLUG [SLUG ...]\n");
  process.exit(2);
}

const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const { getPortfolioBySlug } = await import(join(lib, "portfolios-query.ts"));
const { getPortfolioExportData } = await import(join(lib, "portfolio-export-query.ts"));
const { buildPortfolioExport } = await import(join(lib, "portfolio-export.ts"));

const out = {};
for (const slug of slugs) {
  try {
    const portfolio = await getPortfolioBySlug(slug);
    if (!portfolio) {
      out[slug] = { error: "portfolio not found" };
      continue;
    }
    const data = await getPortfolioExportData(portfolio);
    out[slug] = {
      markdown: buildPortfolioExport(data),
      generatedAt: data.generatedAt,
      pricedAsOf: data.pricedAsOf,
      totalValue: data.totalValue,
      returnPct: data.returnPct,
      holdings: data.holdings.length,
    };
  } catch (err) {
    out[slug] = { error: err instanceof Error ? err.message : String(err) };
  }
}
process.stdout.write(JSON.stringify(out));
