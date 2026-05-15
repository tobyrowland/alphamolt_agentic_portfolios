import { getSupabase } from "@/lib/supabase";

const MAX_SLUG = 40;

/** Derive a URL slug from a free-text name. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return base || "portfolio";
}

/**
 * Slugify `name` and resolve collisions against existing `portfolios.slug`
 * by appending `-2`, `-3`, … The `slug UNIQUE` constraint remains the true
 * guard against a concurrent-create race.
 */
export async function uniquePortfolioSlug(name: string): Promise<string> {
  const supabase = getSupabase();
  const root = slugify(name);
  let candidate = root;
  for (let n = 2; n < 1000; n++) {
    const { data } = await supabase
      .from("portfolios")
      .select("slug")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
    const suffix = `-${n}`;
    candidate =
      root.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, "") + suffix;
  }
  return `${root.slice(0, 28)}-${Date.now().toString(36)}`;
}
