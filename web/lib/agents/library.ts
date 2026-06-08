/**
 * Agent library + team reads (portfolio & agents brief v2, migration 045).
 *
 * The library is the set of hireable agents that declare an `action`
 * (buy / sell / manage). A team agent is a saved, configured copy of a library
 * agent on a portfolio. Pure types & helpers live in `./types` (client-safe);
 * this module is the server-only DB layer.
 */

import { getSupabase } from "@/lib/supabase";
import {
  type AgentAction,
  type LibraryAgent,
  type ParamSpec,
  type TeamAgent,
  withDefaults,
} from "@/lib/agents/types";

export * from "@/lib/agents/types";

const LIBRARY_COLUMNS =
  "handle, display_name, description, powered_by, action, triggers, param_schema, sentence_template, default_mandate";

function coerceParamSchema(raw: unknown): ParamSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ParamSpec =>
      !!p && typeof p === "object" && typeof (p as ParamSpec).key === "string",
  );
}

type LibraryRow = {
  handle: string;
  display_name: string;
  description: string | null;
  powered_by: string | null;
  action: AgentAction;
  triggers: string[] | null;
  param_schema: unknown;
  sentence_template: string | null;
  default_mandate: string | null;
};

function rowToLibraryAgent(r: LibraryRow): LibraryAgent {
  return {
    handle: r.handle,
    displayName: r.display_name,
    description: r.description,
    poweredBy: r.powered_by,
    action: r.action,
    triggers: r.triggers ?? [],
    paramSchema: coerceParamSchema(r.param_schema),
    sentenceTemplate: r.sentence_template,
    defaultMandate: r.default_mandate ?? null,
  };
}

/**
 * The full agent library — every hireable agent that declares an action.
 * Ordered buy → sell → manage, then by name, so the shelf reads the way the
 * brief describes.
 */
export async function getLibraryAgents(): Promise<LibraryAgent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .select(LIBRARY_COLUMNS)
    .not("action", "is", null)
    .eq("available_for_hire", true)
    .order("action", { ascending: true })
    .order("display_name", { ascending: true });
  if (error) {
    console.error("getLibraryAgents failed:", error);
    return [];
  }
  return ((data as unknown as LibraryRow[] | null) ?? []).map(rowToLibraryAgent);
}

/**
 * The saved team for a portfolio — every member that maps to a library agent,
 * with its tuned params + Run/Stop state. Non-library members (legacy
 * pipeline/manual agents) are filtered out: the new page only speaks the
 * buy/sell/manage vocabulary.
 */
export async function getTeamForPortfolio(
  portfolioId: string,
): Promise<TeamAgent[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("portfolio_agents")
    .select(
      "config, enabled, mandate, last_heartbeat_at, joined_at, agents!inner(" +
        LIBRARY_COLUMNS +
        ", heartbeat_interval_hours)",
    )
    .eq("portfolio_id", portfolioId)
    .not("agents.action", "is", null)
    .order("joined_at", { ascending: true });
  if (error) {
    console.error("getTeamForPortfolio failed:", error);
    return [];
  }
  type TeamRow = LibraryRow & { heartbeat_interval_hours: number | null };
  type Row = {
    config: Record<string, number | string> | null;
    enabled: boolean | null;
    mandate: string | null;
    last_heartbeat_at: string | null;
    agents: TeamRow | TeamRow[] | null;
  };
  const rows = (data as unknown as Row[] | null) ?? [];
  return rows
    .map((r): TeamAgent | null => {
      const a = Array.isArray(r.agents) ? r.agents[0] : r.agents;
      // Defensive: only library agents (action set) speak the team vocabulary.
      // Guards against the embedded filter not narrowing on some PostgREST
      // versions, so a legacy member can never reach ACTION_META[null].
      if (!a || !a.action) return null;
      const lib = rowToLibraryAgent(a);
      return {
        ...lib,
        params: withDefaults(lib.paramSchema, r.config ?? {}),
        enabled: r.enabled ?? true,
        mandate: r.mandate ?? null,
        lastRunAt: r.last_heartbeat_at ?? null,
        heartbeatIntervalHours: a.heartbeat_interval_hours ?? null,
      };
    })
    .filter((t): t is TeamAgent => t !== null);
}
