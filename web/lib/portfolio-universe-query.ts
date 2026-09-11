/**
 * Server read behind the portfolio page's public Universe summary.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never applies the portfolio's `screener_rejections` set. That list is
 *    service-role-only because it can belong to a private book, and a public
 *    count derived from it would report the buyer's private pass history as a
 *    universe size. The number here is the pond — what the screen selects
 *    before any per-portfolio hiding.
 *  - It never surfaces the filters or weights. The label, the size and the
 *    draft depth describe the pond; the recipe stays owner-only (the review
 *    pack is owner-gated for exactly this reason).
 *
 * Cost: `runScreen` scores the whole Tier 1 set in memory over the facts
 * cache that the screener already keeps (5-minute TTL, ~3.1k rows), and the
 * page itself is ISR-cached at 300s — the same load the Universe tab makes.
 */

import { runScreen } from "@/lib/screen/query";
import { PRESETS, screenConfigSchema } from "@/lib/screen/config";
import {
  SELF_SOURCED_BUYERS,
  strategyKind,
} from "@/lib/agents/strategy-kind";
import type { UniverseBuyer, UniverseSummary } from "@/lib/portfolio-universe";
import type { TeamAgent } from "@/lib/agents/types";

/**
 * Build the summary for a book, or null when there is nothing true to say.
 *
 * The config is parsed through `screenConfigSchema` rather than read raw, so
 * the summary reports what the AGENTS run — notably `topN`, which a stored
 * config can omit while the ranker still caps at the schema default.
 */
export async function getUniverseSummary(
  screenConfig: Record<string, unknown> | null,
  team: TeamAgent[],
): Promise<UniverseSummary | null> {
  if (!screenConfig) return null;

  const parsed = screenConfigSchema.safeParse(screenConfig);
  if (!parsed.success) {
    console.error("universe summary: unparseable screen_config", parsed.error);
    return null;
  }
  const config = parsed.data;

  const screenBuyers: UniverseBuyer[] = [];
  const selfSourced: UniverseBuyer[] = [];
  for (const a of team) {
    // A stopped agent is still on the roster but the heartbeat skips it, so
    // it does not describe what the book does today.
    if (!a.enabled) continue;
    const kind = strategyKind(a.strategy);
    if (kind === "screen-buyer") {
      screenBuyers.push({ name: a.displayName });
    } else if (kind === "self-sourced-buyer") {
      selfSourced.push({
        name: a.displayName,
        sourcedFrom: a.strategy ? SELF_SOURCED_BUYERS[a.strategy] : undefined,
      });
    }
  }
  // Nothing drafts from the screen — the card would describe a pond this
  // book never fishes. `showsUniverse` enforces the same rule at render.
  if (screenBuyers.length === 0) return null;

  const preset = config.preset ? PRESETS[config.preset] : undefined;
  const base = {
    presetLabel: preset?.label ?? (config.preset ? config.preset : "Custom screen"),
    isCustom: !preset,
    topN: config.topN,
    screenBuyers,
    selfSourced,
  };

  try {
    const { match_count, total_universe, data_asof } = await runScreen(config);
    return {
      ...base,
      matchCount: match_count,
      universeCount: total_universe,
      asOf: data_asof,
    };
  } catch (err) {
    // Fail soft to the label — a missing count is a smaller loss than the
    // whole page failing over a summary card.
    console.error("universe summary: runScreen failed", err);
    return { ...base, matchCount: null, universeCount: null, asOf: null };
  }
}
