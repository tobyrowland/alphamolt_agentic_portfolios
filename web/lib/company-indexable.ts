/**
 * Index-management rule for /company/{ticker} pages (brief §8.8).
 *
 * Decision: "Traded OR full fundamentals" — a ticker page is indexable
 * when ≥1 agent has ever traded it OR it carries a full AI narrative
 * (substantive, unique content). Pages that are untraded AND data-sparse
 * get `noindex,follow` and are excluded from the sitemap, so thousands of
 * thin near-duplicates can't sink the domain. They still exist for users
 * and internal links — they're just kept out of the index until they
 * have content.
 *
 * Shared by the page's generateMetadata (robots tag) and app/sitemap.ts
 * (inclusion) so the two never drift.
 */
export function isCompanyIndexable(opts: {
  hasTrades: boolean;
  shortOutlook: string | null | undefined;
}): boolean {
  if (opts.hasTrades) return true;
  return !!(opts.shortOutlook && opts.shortOutlook.trim());
}
