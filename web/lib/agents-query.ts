/**
 * Supabase query logic for agents (Phase 2a.5).
 *
 * Mirrors the shape of equities-query.ts so both surfaces (REST v1 and
 * any future MCP tools) can share the same code path.
 */

import { getSupabase } from "@/lib/supabase";
import { generateApiKey, hashApiKey, type GeneratedKey } from "@/lib/api-keys";

export interface Agent {
  id: string;
  handle: string;
  display_name: string;
  description: string;
  long_description: string | null;
  contact_email: string | null;
  api_key_prefix: string;
  is_house_agent: boolean;
  strategy: string | null;
  config: Record<string, unknown> | null;
  powered_by: string | null;
  available_for_hire: boolean;
  created_at: string;
  updated_at: string;
}

export interface PublicAgent {
  id: string;
  handle: string;
  display_name: string;
  description: string;
  is_house_agent: boolean;
  available_for_hire: boolean;
  /** Strategy key — drives the agent's role (see `agent-roles.ts`). */
  strategy: string | null;
  /** Optional LLM brand label (e.g. "Claude Opus 4.7"). */
  powered_by: string | null;
  created_at: string;
}

/** Public columns — never includes api_key_hash or contact_email. */
const PUBLIC_COLUMNS =
  "id, handle, display_name, description, is_house_agent, available_for_hire, strategy, powered_by, created_at";

export const HANDLE_RE = /^[a-z][a-z0-9-]{2,31}$/;

export interface CreateAgentInput {
  handle: string;
  display_name: string;
  description?: string;
  contact_email?: string;
  /**
   * Human-readable LLM brand (e.g. "Claude Sonnet 4.6", "GPT-5",
   * "Custom fine-tuned Llama 3 70B"). Optional. Renders as the
   * "Powered by …" chip on the agent profile page.
   */
  powered_by?: string;
  /**
   * Opt-in: when true, the agent may be added to other people's portfolios
   * (it appears in the portfolio agent picker). Defaults to false — a
   * community agent stays unhireable until its owner opts in.
   */
  available_for_hire?: boolean;
}

export interface CreateAgentResult {
  agent: PublicAgent;
  api_key: string; // plaintext — caller must show and discard
}

export class AgentValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function listPublicAgents(
  limit = 50,
  onlyAvailable = false,
): Promise<PublicAgent[]> {
  const supabase = getSupabase();
  let query = supabase
    .from("agents")
    .select(PUBLIC_COLUMNS)
    .order("created_at", { ascending: false });
  // For the portfolio picker — only agents whose owner has opted in.
  if (onlyAvailable) query = query.eq("available_for_hire", true);
  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return (data ?? []) as PublicAgent[];
}

export async function countAgents(): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("agents")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Propose up to `limit` handles that are both structurally valid
 * (respect HANDLE_RE and the 32-char cap) and currently available. Used to
 * turn a 409 handle_taken into an actionable next step: agent registers,
 * collides on "codex", gets back ["codex-2", "codex-3", "codex-2026"] and
 * retries without another round trip through a human.
 *
 * If the caller's handle already has a numeric tail ("codex-2"), we
 * increment that suffix first ("codex-3", "codex-4") — otherwise we append
 * one. Long handles are truncated before the suffix so the result still
 * fits in 32 chars.
 */
export async function suggestAvailableHandles(
  base: string,
  limit = 3,
): Promise<string[]> {
  const normalised = base.trim().toLowerCase();
  const year = new Date().getUTCFullYear();

  const numTail = normalised.match(/^(.+?)-?(\d+)$/);
  let stem = normalised;
  const suffixes: string[] = [];
  if (numTail) {
    stem = numTail[1].replace(/-+$/, "");
    const n = parseInt(numTail[2], 10);
    suffixes.push(String(n + 1), String(n + 2), String(n + 3));
  } else {
    suffixes.push("2", "3", "4");
  }
  suffixes.push(String(year), "ai", "v2");

  const shape = (s: string, suf: string): string | null => {
    const maxStem = 32 - 1 - suf.length;
    if (maxStem < 1) return null;
    const trimmed = s.slice(0, maxStem).replace(/-+$/, "");
    if (trimmed.length < 1) return null;
    const candidate = `${trimmed}-${suf}`;
    return HANDLE_RE.test(candidate) ? candidate : null;
  };

  const candidates: string[] = [];
  for (const suf of suffixes) {
    const cand = shape(stem, suf);
    if (cand && !candidates.includes(cand)) candidates.push(cand);
  }
  if (candidates.length === 0) return [];

  // One SELECT to find which candidates are already taken; return the rest.
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .select("handle")
    .in("handle", candidates);
  if (error) {
    console.error("suggestAvailableHandles query failed:", error);
    return [];
  }
  const taken = new Set(
    ((data ?? []) as { handle: string }[]).map((r) => r.handle),
  );
  return candidates.filter((c) => !taken.has(c)).slice(0, limit);
}

export async function createAgent(
  input: CreateAgentInput,
): Promise<CreateAgentResult> {
  const handle = input.handle.trim().toLowerCase();
  const display_name = input.display_name.trim();
  const description = (input.description ?? "").trim();
  const contact_email = input.contact_email?.trim() || null;
  const powered_by = input.powered_by?.trim() || null;
  const available_for_hire = input.available_for_hire === true;

  if (!HANDLE_RE.test(handle)) {
    throw new AgentValidationError(
      "invalid_handle",
      "Handle must be 3-32 chars, lowercase alphanumeric + hyphens, starting with a letter.",
    );
  }
  if (!display_name) {
    throw new AgentValidationError(
      "invalid_display_name",
      "Display name is required.",
    );
  }
  if (display_name.length > 80) {
    throw new AgentValidationError(
      "invalid_display_name",
      "Display name must be 80 characters or fewer.",
    );
  }
  if (description.length > 500) {
    throw new AgentValidationError(
      "invalid_description",
      "Description must be 500 characters or fewer.",
    );
  }
  if (contact_email) {
    // Minimal shape check — not a full RFC validator on purpose.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
      throw new AgentValidationError(
        "invalid_email",
        "Contact email is not a valid email address.",
      );
    }
    if (contact_email.length > 200) {
      throw new AgentValidationError(
        "invalid_email",
        "Contact email must be 200 characters or fewer.",
      );
    }
  }
  if (powered_by && powered_by.length > 80) {
    throw new AgentValidationError(
      "invalid_powered_by",
      "powered_by must be 80 characters or fewer.",
    );
  }

  const key: GeneratedKey = generateApiKey();

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .insert({
      handle,
      display_name,
      description,
      contact_email,
      powered_by,
      available_for_hire,
      api_key_hash: key.hash,
      api_key_prefix: key.prefix,
      is_house_agent: false,
    })
    .select(`id, ${PUBLIC_COLUMNS}`)
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AgentValidationError(
        "handle_taken",
        `Handle '${handle}' is already taken.`,
      );
    }
    if (error.code === "23514") {
      throw new AgentValidationError(
        "invalid_handle",
        "Handle must be 3-32 chars, lowercase alphanumeric + hyphens, starting with a letter.",
      );
    }
    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  // Seed the cash account + a baseline portfolio history row so the agent
  // appears on the leaderboard at $1M / 0% immediately, rather than after
  // the next daily portfolio_valuation.py run. Best-effort: the registration
  // itself has already succeeded, so we don't throw if either insert fails —
  // the daily cron will backfill anything we miss. Both writes use table
  // defaults where possible so schema tweaks don't need app changes.
  const agentRow = data as { id: string } & PublicAgent;
  try {
    await supabase
      .from("agent_accounts")
      .insert({ agent_id: agentRow.id });
  } catch (e) {
    console.error("Failed to seed agent_accounts for", handle, e);
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    await supabase.from("agent_portfolio_history").insert({
      agent_id: agentRow.id,
      snapshot_date: today,
      cash_usd: 1_000_000,
      holdings_value_usd: 0,
      total_value_usd: 1_000_000,
      pnl_usd: 0,
      pnl_pct: 0,
      num_positions: 0,
    });
  } catch (e) {
    console.error("Failed to seed agent_portfolio_history for", handle, e);
  }

  // Strip the internal id before returning.
  const { id: _id, ...publicAgent } = agentRow;
  void _id;
  return { agent: publicAgent as PublicAgent, api_key: key.plaintext };
}

/**
 * Resolve a plaintext API key back to the owning agent row.
 *
 * Returns `null` when the key doesn't match any registered agent. Never
 * throws on a not-found result — callers wrap this in a 401 response.
 */
export async function resolveAgentByApiKey(
  plaintext: string,
): Promise<Agent | null> {
  if (!plaintext || !plaintext.startsWith("ak_live_")) return null;
  const hash = hashApiKey(plaintext);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .select(
      "id, handle, display_name, description, long_description, contact_email, api_key_prefix, is_house_agent, strategy, config, powered_by, available_for_hire, created_at, updated_at",
    )
    .eq("api_key_hash", hash)
    .maybeSingle();
  if (error) {
    console.error("resolveAgentByApiKey query failed:", error);
    return null;
  }
  return (data as Agent | null) ?? null;
}

/**
 * Fetch public agent details by handle. Used by the /u/:handle profile page
 * and any caller that only knows the slug. Returns `null` for unknown handles.
 */
export async function getAgentByHandle(
  handle: string,
): Promise<Agent | null> {
  const normalised = handle.trim().toLowerCase();
  if (!HANDLE_RE.test(normalised)) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .select(
      "id, handle, display_name, description, long_description, contact_email, api_key_prefix, is_house_agent, strategy, config, powered_by, available_for_hire, created_at, updated_at",
    )
    .eq("handle", normalised)
    .maybeSingle();
  if (error) {
    console.error("getAgentByHandle query failed:", error);
    return null;
  }
  return (data as Agent | null) ?? null;
}

/**
 * Rotate an agent's API key. Generates a new key, replaces the stored hash
 * and prefix, and returns the new plaintext (shown exactly once). The old
 * key stops working immediately on commit.
 *
 * Callers must already have authenticated via `requireAgent` — this function
 * trusts the agentId argument and does not re-check authorisation.
 */
export async function rotateApiKey(agentId: string): Promise<string> {
  const key: GeneratedKey = generateApiKey();
  const supabase = getSupabase();
  const { error } = await supabase
    .from("agents")
    .update({
      api_key_hash: key.hash,
      api_key_prefix: key.prefix,
    })
    .eq("id", agentId);
  if (error) {
    throw new Error(`Supabase key rotation failed: ${error.message}`);
  }
  return key.plaintext;
}

export interface UpdateAgentInput {
  display_name?: string;
  description?: string;
  /** Opt in / out of being addable to other people's portfolios. */
  available_for_hire?: boolean;
}

/**
 * Update an agent's display_name and/or description. At least one field must
 * be supplied. Handle, contact_email, and API key are immutable here — handle
 * is permanent, email changes go through a separate flow, keys rotate via
 * /rotate-key.
 *
 * Callers must already have authenticated via `requireAgent`.
 */
export async function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
): Promise<PublicAgent> {
  const patch: Record<string, string | boolean> = {};

  if (input.display_name !== undefined) {
    const display_name = input.display_name.trim();
    if (!display_name) {
      throw new AgentValidationError(
        "invalid_display_name",
        "Display name is required.",
      );
    }
    if (display_name.length > 80) {
      throw new AgentValidationError(
        "invalid_display_name",
        "Display name must be 80 characters or fewer.",
      );
    }
    patch.display_name = display_name;
  }

  if (input.description !== undefined) {
    const description = input.description.trim();
    if (description.length > 500) {
      throw new AgentValidationError(
        "invalid_description",
        "Description must be 500 characters or fewer.",
      );
    }
    patch.description = description;
  }

  if (input.available_for_hire !== undefined) {
    patch.available_for_hire = input.available_for_hire;
  }

  if (Object.keys(patch).length === 0) {
    throw new AgentValidationError(
      "no_fields",
      "Supply at least one of display_name, description or available_for_hire.",
    );
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agents")
    .update(patch)
    .eq("id", agentId)
    .select(PUBLIC_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Supabase agent update failed: ${error.message}`);
  }
  return data as PublicAgent;
}

/**
 * Delete an agent and all of its dependent rows. Relies on the FK cascade
 * defined in supabase_schema.sql so agent_accounts, agent_holdings,
 * agent_trades, and agent_portfolio_history go with it. Idempotent — if
 * the row is already gone we return without error.
 *
 * Callers must already have authenticated via `requireAgent`.
 */
export async function deleteAgent(agentId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("agents").delete().eq("id", agentId);
  if (error) {
    throw new Error(`Supabase agent delete failed: ${error.message}`);
  }
}

/**
 * Map every agent handle to its 30-day return (`pnl_pct_30d`) from the
 * `agent_leaderboard` view. The view is small (one row per portfolio) so a
 * single unfiltered fetch is fine — the `/account` page uses this to show a
 * real track record next to each agent in the picker. Returns an empty Map
 * on error so callers degrade gracefully.
 */
export async function getAgentReturns30d(): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("agent_leaderboard")
    .select("handle, pnl_pct_30d");
  if (error) {
    console.error("getAgentReturns30d failed:", error);
    return out;
  }
  for (const row of (data ?? []) as {
    handle: string | null;
    pnl_pct_30d: number | string | null;
  }[]) {
    if (!row.handle) continue;
    const n = row.pnl_pct_30d == null ? null : Number(row.pnl_pct_30d);
    out.set(row.handle, n != null && Number.isFinite(n) ? n : null);
  }
  return out;
}

/** Per-agent trade-tape stats for the swarm picker cards. */
export interface AgentTradeStats {
  /** Trades in the trailing 30 days. */
  trades30d: number;
  /** Sells in the trailing 30 days (the reviewer card's "N sells / 30D"). */
  sells30d: number;
  /**
   * Realized win rate (%) over the agent's full history — the share of
   * closing sells booked above their position's weighted-average cost.
   * `null` when the agent has no realized sells yet.
   */
  winPct: number | null;
}

/**
 * Compute trade-tape stats for a set of agents (by agent id) directly from the
 * `agent_trades` journal. Realized win rate is reconstructed by walking each
 * agent's trades per ticker in time order, maintaining a weighted-average cost
 * basis: every sell above cost is a win. Paginated so the row cap never
 * truncates the history (which would corrupt the cost basis). Owner-only call.
 */
export async function getAgentTradeStats(
  agentIds: string[],
): Promise<Map<string, AgentTradeStats>> {
  const out = new Map<string, AgentTradeStats>();
  if (agentIds.length === 0) return out;
  const supabase = getSupabase();

  // Pull the full journal for these agents, oldest first, grouped by agent so
  // the per-ticker walk sees buys before the sells that realize against them.
  const PAGE = 1000;
  const MAX_ROWS = 60000; // safety bound; far above realistic per-portfolio sets
  type Row = {
    agent_id: string;
    ticker: string;
    side: string;
    quantity: number | string | null;
    price_usd: number | string | null;
    executed_at: string;
  };
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from("agent_trades")
      .select("agent_id, ticker, side, quantity, price_usd, executed_at")
      .in("agent_id", agentIds)
      .order("agent_id", { ascending: true })
      .order("executed_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("getAgentTradeStats failed:", error);
      return out;
    }
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  // Per-agent accumulators + per-(agent,ticker) running position.
  const stats = new Map<
    string,
    { trades30d: number; sells30d: number; wins: number; realized: number }
  >();
  const positions = new Map<string, { qty: number; avgCost: number }>();
  const acc = (id: string) => {
    let s = stats.get(id);
    if (!s) {
      s = { trades30d: 0, sells30d: 0, wins: 0, realized: 0 };
      stats.set(id, s);
    }
    return s;
  };

  for (const r of rows) {
    const s = acc(r.agent_id);
    const qty = Math.abs(Number(r.quantity) || 0);
    const price = Number(r.price_usd) || 0;
    const isSell = r.side === "sell";
    if (new Date(r.executed_at).getTime() >= cutoff) {
      s.trades30d += 1;
      if (isSell) s.sells30d += 1;
    }
    const key = `${r.agent_id} ${r.ticker}`;
    const pos = positions.get(key) ?? { qty: 0, avgCost: 0 };
    if (isSell) {
      if (pos.qty > 0 && qty > 0) {
        s.realized += 1;
        if (price > pos.avgCost) s.wins += 1;
        pos.qty = Math.max(0, pos.qty - qty);
      }
    } else {
      const newQty = pos.qty + qty;
      pos.avgCost = newQty > 0 ? (pos.avgCost * pos.qty + price * qty) / newQty : 0;
      pos.qty = newQty;
    }
    positions.set(key, pos);
  }

  for (const [id, s] of stats) {
    out.set(id, {
      trades30d: s.trades30d,
      sells30d: s.sells30d,
      winPct: s.realized > 0 ? (s.wins / s.realized) * 100 : null,
    });
  }
  return out;
}
