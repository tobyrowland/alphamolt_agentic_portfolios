/**
 * Server-side data load for the screener (brief v2 §6 contract).
 *
 * Pulls the Level 0 facts (screen_facts()) for the whole Tier 1 universe,
 * merges the optional AI bull/bear overlay (screen_ai_overlay()), then hands
 * the rows to the pure scoring function. No scoring lives here — this module
 * only fetches; scoreScreen() ranks.
 */

import { getSupabase } from "@/lib/supabase";
import { scoreScreen, type ScreenFacts, type ScreenResult } from "@/lib/screen/score";
import type { ScreenConfig } from "@/lib/screen/config";

const PAGE = 1000;

/** Fetch every Tier 1 fact row (paginated past PostgREST's 1000-row cap). */
export async function loadFacts(): Promise<ScreenFacts[]> {
  const supabase = getSupabase();

  const [factsRaw, overlay] = await Promise.all([
    fetchAll(supabase, "screen_facts"),
    fetchAll(supabase, "screen_ai_overlay"),
  ]);

  const ai = new Map<string, { bull: boolean | null; bear: boolean | null }>();
  for (const r of overlay) {
    ai.set(r.ticker as string, {
      bull: (r.bull as boolean | null) ?? null,
      bear: (r.bear as boolean | null) ?? null,
    });
  }

  return factsRaw.map((r) => {
    const verdict = ai.get(r.ticker as string);
    return {
      ticker: r.ticker as string,
      name: (r.name as string) ?? null,
      sector: (r.sector as string) ?? null,
      industry: (r.industry as string) ?? null,
      country: (r.country as string) ?? null,
      price: num(r.price),
      price_asof: (r.price_asof as string) ?? null,
      rev_growth_ttm: num(r.rev_growth_ttm),
      gross_margin: num(r.gross_margin),
      fcf_margin: num(r.fcf_margin),
      net_margin: num(r.net_margin),
      operating_margin: num(r.operating_margin),
      rule_of_40: num(r.rule_of_40),
      ps: num(r.ps),
      ps_median_12m: num(r.ps_median_12m),
      ret_52w: num(r.ret_52w),
      bull: verdict?.bull ?? null,
      bear: verdict?.bear ?? null,
    } satisfies ScreenFacts;
  });
}

async function fetchAll(
  supabase: ReturnType<typeof getSupabase>,
  fn: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .rpc(fn)
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) {
      console.error(`${fn} failed:`, error.message);
      break;
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

export interface ScreenResponse extends ScreenResult {
  data_asof: string | null;
}

/** Full contract response for a config: scored rows + counts + as-of. */
export async function runScreen(config: ScreenConfig): Promise<ScreenResponse> {
  const facts = await loadFacts();
  const result = scoreScreen(facts, config, facts.length);
  const data_asof = facts.reduce<string | null>((acc, f) => {
    if (f.price_asof && (!acc || f.price_asof > acc)) return f.price_asof;
    return acc;
  }, null);
  return { ...result, data_asof };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
