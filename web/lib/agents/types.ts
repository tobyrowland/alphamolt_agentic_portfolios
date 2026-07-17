/**
 * Agent library + team model — pure types & helpers (migration 045).
 *
 * Client-safe: no server imports, so the team builder can pull `fillSentence`,
 * `readiness`, etc. without dragging the Supabase client into the browser
 * bundle. The DB reads live in `library.ts`.
 */

/** The only grouping (brief §3, axis 1). Mechanically true, never inferred. */
export type AgentAction = "buy" | "sell" | "manage";

/** Declared intent tags on sells (brief §3, axis 2) — a small fixed set. */
export type TriggerTag = "caps-losses" | "banks-gains";

export const TRIGGER_LABELS: Record<string, string> = {
  "caps-losses": "caps losses",
  "banks-gains": "banks gains",
};

/** A single typed, bounded control in an agent's quick config. */
export interface ParamSpec {
  key: string;
  label: string;
  type: "number" | "select";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  default: number | string;
  options?: { value: number | string; label: string }[];
  /**
   * Optional visibility rule: render this control only when another param's
   * current value is (equals) / is not (not) one of the listed values —
   * e.g. the P/S threshold slider only shows once a P/S limit mode is picked.
   * Declared in the stored param_schema (migration 078), honoured by
   * visibleParams(); a hidden param keeps its stored value.
   */
  showWhen?: {
    key: string;
    equals?: (number | string)[];
    not?: (number | string)[];
  };
}

/** The subset of a schema whose controls should render for these values —
 *  showWhen rules resolved against the current params (defaults filled). */
export function visibleParams(
  schema: ParamSpec[],
  values: Record<string, number | string>,
): ParamSpec[] {
  const merged = withDefaults(schema, values);
  return schema.filter((spec) => {
    const rule = spec.showWhen;
    if (!rule) return true;
    const v = String(merged[rule.key]);
    if (rule.equals && !rule.equals.some((x) => String(x) === v)) return false;
    if (rule.not && rule.not.some((x) => String(x) === v)) return false;
    return true;
  });
}

/** A library template — the unconfigured agent in the shelf. */
export interface LibraryAgent {
  handle: string;
  displayName: string;
  description: string | null;
  poweredBy: string | null;
  action: AgentAction;
  triggers: string[];
  paramSchema: ParamSpec[];
  sentenceTemplate: string | null;
  /**
   * The agent's baked-in brief (migration 046). Non-null only for "thinking"
   * agents (LLM buyer / reviewer) — the team builder shows a brief field iff
   * this is set; mechanical/manage agents leave it null.
   */
  defaultMandate: string | null;
}

/** A configured copy of a library agent saved onto a portfolio. */
export interface TeamAgent extends LibraryAgent {
  params: Record<string, number | string>;
  enabled: boolean;
  /** Per-instance brief override; null = track the agent default. */
  mandate: string | null;
  /** Per-membership last rebalance (ISO), or null if it has never run. */
  lastRunAt: string | null;
  /** The agent's cadence in hours (defaults to weekly when unset). */
  heartbeatIntervalHours: number | null;
}

/** Whether the owner has pinned a custom brief on this saved agent. */
export function hasCustomMandate(agent: TeamAgent): boolean {
  return (agent.mandate ?? "").trim().length > 0;
}

/** The brief actually in force for an agent: instance override ?? default. */
export function effectiveMandate(
  agent: Pick<LibraryAgent, "defaultMandate"> & { mandate?: string | null },
): string {
  return (agent.mandate ?? null)?.trim() || agent.defaultMandate || "";
}

/** Merge stored params over schema defaults, dropping unknown keys. */
export function withDefaults(
  schema: ParamSpec[],
  params: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const spec of schema) {
    const v = params[spec.key];
    out[spec.key] = v === undefined || v === null ? spec.default : v;
  }
  return out;
}

/** The default param set for a fresh drag-in (every control at its default). */
export function defaultParams(
  schema: ParamSpec[],
): Record<string, number | string> {
  return withDefaults(schema, {});
}

/**
 * Interpolate an agent's plain-language sentence from its params. Missing
 * placeholders fall back to the schema default so the line is always complete.
 */
export function fillSentence(
  agent: Pick<LibraryAgent, "sentenceTemplate" | "paramSchema">,
  params: Record<string, number | string>,
): string {
  const tmpl = agent.sentenceTemplate;
  if (!tmpl) return "";
  const merged = withDefaults(agent.paramSchema, params);
  return tmpl.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = merged[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

export interface Coverage {
  /** Action-axis coverage (the header chips) — counted from saved agents. */
  buy: boolean;
  sell: boolean;
  manage: boolean;
  /** All three actions covered. */
  complete: boolean;
  /** What's missing, in plain language (the footer verdict's list). */
  gaps: string[];
  /** Consequence tail, e.g. "your team can't exit or rebalance yet". */
  consequence: string;
}

/**
 * Coverage readout for the "Your Team" unit (component brief §04). The header
 * chips are the action axis only (buy / sell / manage), counted from *saved*
 * agents. Trigger nuance (loss protection / profit-taking) lives in the gap
 * list, not the header — and only once a sell exists but a trigger is absent.
 */
export function teamCoverage(team: TeamAgent[]): Coverage {
  const buy = team.some((a) => a.action === "buy");
  const sell = team.some((a) => a.action === "sell");
  const manage = team.some((a) => a.action === "manage");
  const complete = buy && sell && manage;

  const sellTriggers = new Set(
    team.filter((a) => a.action === "sell").flatMap((a) => a.triggers),
  );

  const gaps: string[] = [];
  if (!buy) gaps.push("a buyer");
  if (!sell) {
    gaps.push("a way to sell");
  } else {
    // Sell exists — name any missing intent (advice, not a header chip).
    if (!sellTriggers.has("caps-losses")) gaps.push("loss protection");
    if (!sellTriggers.has("banks-gains")) gaps.push("profit-taking");
  }
  if (!manage) gaps.push("rebalancing");

  // Consequence is about *capabilities* the team lacks, not trigger nuance.
  const cant: string[] = [];
  if (!buy) cant.push("open positions");
  if (!sell) cant.push("exit");
  if (!manage) cant.push("rebalance");
  const consequence = cant.length
    ? `your team can't ${cant.join(" or ")} yet`
    : "";

  return { buy, sell, manage, complete, gaps, consequence };
}

/** Heartbeat role a library action maps to (migration 041 + 045). */
export const ROLE_FOR_ACTION: Record<AgentAction, string> = {
  buy: "buyer",
  sell: "reviewer",
  manage: "manager",
};
