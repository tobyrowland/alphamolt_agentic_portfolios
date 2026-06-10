/**
 * Server-side data for the homepage "How it works" agent-roster section
 * (section2-redesign-brief.md).
 *
 * The cards render from the live agent *library* (the hireable agents that
 * declare an action — migration 045/047), so homepage copy can never drift
 * from the in-app library. The four-card layout is the canonical structure
 * from the reference; live records flow into the slots they back:
 *
 *   - Conviction Buyer  ← the "Conviction Buyer · <model>" buy family,
 *                         collapsed to one card whose model chips are the
 *                         variants (a 5th variant ⇒ a 5th chip).
 *   - Portfolio Review  ← the sell-role reviewer.
 *   - 200-Week Sniper   ← a rules-based buy teaser (reference copy; the real
 *                         roster has no rules engine yet — "more in training").
 *   - Build your own    ← static custom card (rendered in the component).
 *
 * Fallback contract: if the library read fails or is empty, every slot uses
 * the static reference copy and the next-run timestamp is omitted. The
 * section is never empty and no agents are invented beyond the reference.
 */

import { getLibraryAgents } from "@/lib/agents/library";
import type { LibraryAgent } from "@/lib/agents/types";
import { nextHeartbeatTick } from "@/lib/agents/schedule";

export interface ModelChip {
  /** Short brand for the chip face, e.g. "Claude". */
  label: string;
  /** Full model name for the "powered by …" line, e.g. "Claude Opus 4.8". */
  model: string;
}

export interface ConvictionBuyerCard {
  title: string;
  description: string;
  chips: ModelChip[];
  /** Default "powered by" model (first chip). */
  defaultModel: string;
  /** Next scheduled run label (UTC), or null when omitted. */
  nextRun: string | null;
}

export interface SellCard {
  title: string;
  description: string;
  /** Right-hand engine chip, e.g. "Gemini 2.5 Pro". */
  engine: string | null;
  /** The "powered by"/role line, e.g. "your risk manager". */
  powered: string;
}

export interface RulesCard {
  title: string;
  description: string;
  powered: string;
}

export interface RosterCoverage {
  buy: boolean;
  sell: boolean;
  manage: boolean;
}

export interface RosterData {
  /** Hireable-agent count for the gallery label. */
  agentCount: number;
  convictionBuyer: ConvictionBuyerCard;
  sniper: RulesCard;
  reviewer: SellCard;
  coverage: RosterCoverage;
}

// ---- Reference static copy (the fallback + the slots with no live record) --
// Verbatim from alphamolt-section2-v4.html. Used when a slot has no confident
// library backing, or when the whole read fails.

const STATIC_CONVICTION: Omit<ConvictionBuyerCard, "nextRun"> = {
  title: "Conviction Buyer",
  description:
    "Each night, weighs every watchlist equity against your mandate, ranks its picks — and buys only its highest-conviction names, up to 5% per position.",
  chips: [
    { label: "Claude", model: "Claude Opus 4.8" },
    { label: "GPT-5", model: "GPT-5" },
    { label: "Gemini", model: "Gemini 2.5 Pro" },
    { label: "Grok", model: "Grok 4" },
  ],
  defaultModel: "Claude Opus 4.8",
};

const STATIC_SNIPER: RulesCard = {
  title: "200-Week Sniper",
  description:
    "Waits for quality names to trade down to their 200-week average, buys within 5% of it — and sits in cash until they do. Munger-school patience.",
  powered: "powered by pure arithmetic — no model, no moods",
};

const STATIC_REVIEWER: SellCard = {
  title: "Portfolio Review Agent",
  description:
    "Reviews every holding weekly against its recorded buy thesis and your mandate. Sells the full position when conviction to exit reaches 4 of 5.",
  engine: "Gemini 2.5 Pro",
  powered: "your risk manager",
};

const STATIC_COVERAGE: RosterCoverage = { buy: true, sell: true, manage: false };

// Reference fallback when the API is unavailable (next-run omitted).
export const ROSTER_FALLBACK: RosterData = {
  agentCount: 6,
  convictionBuyer: { ...STATIC_CONVICTION, nextRun: null },
  sniper: STATIC_SNIPER,
  reviewer: STATIC_REVIEWER,
  coverage: STATIC_COVERAGE,
};

// Stable chip order matching the reference: Claude, GPT-5, Gemini, Grok,
// then anything new appended in library order.
const BRAND_ORDER = ["Claude", "GPT", "Gemini", "Grok"];

function shortBrand(model: string | null): string {
  if (!model) return "";
  const m = model.trim();
  if (/^claude/i.test(m)) return "Claude";
  if (/^gpt/i.test(m)) return m.split(/\s+/)[0]; // keep "GPT-5"
  if (/^gemini/i.test(m)) return "Gemini";
  if (/^grok/i.test(m)) return "Grok";
  return m.split(/\s+/)[0];
}

function brandRank(label: string): number {
  const i = BRAND_ORDER.findIndex((b) => label.toUpperCase().startsWith(b.toUpperCase()));
  return i === -1 ? BRAND_ORDER.length : i;
}

function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

// UTC label for the next weekly heartbeat tick, e.g. "Sun 07:00 UTC".
function nextRunLabel(now: number): string {
  const d = new Date(nextHeartbeatTick(now));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${hh}:${mm} UTC`;
}

export async function getRosterData(now: number = Date.now()): Promise<RosterData> {
  let library: LibraryAgent[];
  try {
    library = await getLibraryAgents();
  } catch (err) {
    console.error("homepage roster: library fetch failed:", err);
    return ROSTER_FALLBACK;
  }
  if (library.length === 0) return ROSTER_FALLBACK;

  const buyers = library.filter((a) => a.action === "buy");
  const sellers = library.filter((a) => a.action === "sell");

  // Conviction Buyer family — the multi-brain LLM buyer, one record per model.
  const family = buyers.filter((a) =>
    a.displayName.toLowerCase().startsWith("conviction buyer"),
  );

  const convictionBuyer: ConvictionBuyerCard = (() => {
    if (family.length === 0) {
      return { ...STATIC_CONVICTION, nextRun: nextRunLabel(now) };
    }
    const seen = new Set<string>();
    const chips: ModelChip[] = [];
    for (const a of family) {
      const model = nonEmpty(a.poweredBy);
      if (!model || seen.has(model)) continue;
      seen.add(model);
      chips.push({ label: shortBrand(model), model });
    }
    chips.sort((a, b) => brandRank(a.label) - brandRank(b.label));
    if (chips.length === 0) chips.push(...STATIC_CONVICTION.chips);
    return {
      title: "Conviction Buyer",
      description:
        nonEmpty(family[0].description) ?? STATIC_CONVICTION.description,
      chips,
      defaultModel: chips[0].model,
      nextRun: nextRunLabel(now),
    };
  })();

  // Portfolio Review Agent — the sell-role reviewer.
  const reviewerRec =
    sellers.find((a) => a.handle === "portfolio-reviewer") ?? sellers[0] ?? null;
  const reviewer: SellCard = reviewerRec
    ? {
        title: reviewerRec.displayName,
        description: nonEmpty(reviewerRec.description) ?? STATIC_REVIEWER.description,
        engine: nonEmpty(reviewerRec.poweredBy),
        powered: STATIC_REVIEWER.powered,
      }
    : STATIC_REVIEWER;

  // 200-Week Sniper — a rules-based buy teaser. Use a real rules-based buy
  // record if one exists (no model brand), else the reference teaser.
  const rulesRec = buyers.find(
    (a) => !family.includes(a) && nonEmpty(a.poweredBy) === null,
  );
  const sniper: RulesCard = rulesRec
    ? {
        title: rulesRec.displayName,
        description: nonEmpty(rulesRec.description) ?? STATIC_SNIPER.description,
        powered: STATIC_SNIPER.powered,
      }
    : STATIC_SNIPER;

  // Coverage from the live action axes (config-driven; Manage flips on the
  // moment a manage-role agent enters the library).
  const coverage: RosterCoverage = {
    buy: buyers.length > 0,
    sell: sellers.length > 0,
    manage: library.some((a) => a.action === "manage"),
  };

  return {
    agentCount: library.length,
    convictionBuyer,
    sniper,
    reviewer,
    coverage,
  };
}
