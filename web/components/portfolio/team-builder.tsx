"use client";

/**
 * Team builder (portfolio & agents brief v2; "Your Team" unit brief).
 *
 * The portfolio owner's home base: drag agents from a library into one team
 * hopper; saving an agent *deploys* it (no batch deploy). The team itself is a
 * single unit — coverage in the header, agents in the body, the gap verdict in
 * the footer. Agents are *scheduled runners*, not always-on processes: each
 * card shows when it next runs and offers a manual "Run now". Edits after save
 * are live. Holdings & trades render below this component on the page.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  type AgentAction,
  type Coverage,
  type LibraryAgent,
  type ParamSpec,
  type TeamAgent,
  defaultParams,
  effectiveMandate,
  fillSentence,
  hasCustomMandate,
  teamCoverage,
  TRIGGER_LABELS,
} from "@/lib/agents/types";
import {
  saveTeamAgent,
  updateTeamAgentParams,
  removeAgentFromPortfolio,
} from "@/lib/portfolios-mutations";
import { runAgent } from "@/lib/run-agent-mutations";
import { scheduleText } from "@/lib/agents/schedule";

// ----- Action vocabulary ---------------------------------------------------

const ACTION_META: Record<
  AgentAction,
  { label: string; color: string; bg: string; border: string }
> = {
  buy: {
    label: "BUY",
    color: "var(--color-green)",
    bg: "rgba(0,255,65,0.08)",
    border: "rgba(0,255,65,0.35)",
  },
  sell: {
    label: "SELL",
    color: "var(--color-red)",
    bg: "rgba(255,51,51,0.08)",
    border: "rgba(255,51,51,0.35)",
  },
  manage: {
    label: "MANAGE",
    color: "var(--color-orange)",
    bg: "rgba(255,153,0,0.08)",
    border: "rgba(255,153,0,0.35)",
  },
};

const TABS: { key: "all" | AgentAction; label: string }[] = [
  { key: "all", label: "All" },
  { key: "buy", label: "Buy" },
  { key: "sell", label: "Sell" },
  { key: "manage", label: "Manage" },
];

const DRAG_MIME = "application/x-alphamolt-agent";

// Mirrors the run-now server cooldown (run-agent-mutations.ts) — the button
// stays locked while the dispatched workflow is likely still running.
const RUN_COOLDOWN_MS = 300_000;

interface PendingItem {
  key: string;
  agent: LibraryAgent;
  params: Record<string, number | string>;
  /** The editable brief, pre-filled from the agent's default mandate. */
  mandate: string;
}

/** Action-aware label for an agent's brief field (brief = its mandate). */
function briefLabel(action: AgentAction): string {
  if (action === "buy") return "What to buy";
  if (action === "sell") return "When to sell";
  return "Brief";
}

/**
 * The value to persist for a brief: null when it's empty or unchanged from the
 * agent's default (so an untouched brief keeps tracking the evolving default),
 * otherwise the trimmed text.
 */
function mandateOverride(
  agent: Pick<LibraryAgent, "defaultMandate">,
  text: string,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed === (agent.defaultMandate ?? "").trim()) return null;
  return trimmed;
}

// ----- Root ----------------------------------------------------------------

export default function TeamBuilder({
  portfolioId,
  team,
  library,
}: {
  portfolioId: string;
  team: TeamAgent[];
  library: LibraryAgent[];
}) {
  const router = useRouter();
  const [isBusy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [addOpen, setAddOpen] = useState(team.length === 0);
  const seq = useRef(0);

  const coverage = useMemo(() => teamCoverage(team), [team]);
  const onTeam = useMemo(() => new Set(team.map((a) => a.handle)), [team]);
  const pendingHandles = useMemo(
    () => new Set(pending.map((p) => p.agent.handle)),
    [pending],
  );

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else router.refresh();
    });
  }

  // Drag/click a library agent in → an unsaved card, config open. Unsaved does
  // nothing (not on the team, not counted by coverage) until saved.
  function addAgent(agent: LibraryAgent) {
    if (onTeam.has(agent.handle) || pendingHandles.has(agent.handle)) return;
    setError(null);
    seq.current += 1;
    setPending((p) => [
      ...p,
      {
        key: `${agent.handle}-${seq.current}`,
        agent,
        params: defaultParams(agent.paramSchema),
        mandate: agent.defaultMandate ?? "",
      },
    ]);
  }

  function setPendingParams(
    key: string,
    params: Record<string, number | string>,
  ) {
    setPending((p) => p.map((x) => (x.key === key ? { ...x, params } : x)));
  }

  function setPendingMandate(key: string, mandate: string) {
    setPending((p) => p.map((x) => (x.key === key ? { ...x, mandate } : x)));
  }

  function discard(key: string) {
    setPending((p) => p.filter((x) => x.key !== key));
  }

  // Save = deploy. On success the row exists server-side; drop the pending card
  // and refresh so it returns as a settled, live team card.
  function savePending(item: PendingItem) {
    setError(null);
    startTransition(async () => {
      const res = await saveTeamAgent({
        portfolioId,
        handle: item.agent.handle,
        params: item.params,
        // null when untouched from the default, so it keeps tracking it.
        mandate: mandateOverride(item.agent, item.mandate),
      });
      if (!res.ok) {
        setError(res.error ?? "Could not save the agent.");
        return;
      }
      setPending((p) => p.filter((x) => x.key !== item.key));
      router.refresh();
    });
  }

  const isEmpty = team.length === 0 && pending.length === 0;

  return (
    <div className="space-y-8">
      {/* Empty / first-run welcome (brief §7). Honest: no team, no numbers. */}
      {isEmpty && (
        <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.04] p-5">
          <p className="text-sm font-bold text-[var(--color-green)] mb-1.5">
            Welcome to your portfolio
          </p>
          <p className="text-sm text-text-dim leading-relaxed max-w-prose">
            This is your home base. Build a team of AI agents below, deploy them
            to trade your portfolio on paper, and they&apos;ll compete on the
            public leaderboard by alpha vs SPY. Once they&apos;re live,
            you&apos;ll watch their trades and standing right here.
          </p>
        </div>
      )}

      {/* YOUR TEAM — one unit: coverage in the header, agents in the body, the
          gap verdict in the footer. Also the single drop target. */}
      <YourTeamUnit
        team={team}
        pending={pending}
        isEmpty={isEmpty}
        busy={isBusy}
        coverage={coverage}
        libraryOpen={team.length === 0 || addOpen}
        onDropAgent={(handle) => {
          const agent = library.find((a) => a.handle === handle);
          if (agent) addAgent(agent);
        }}
        onPendingParams={setPendingParams}
        onPendingMandate={setPendingMandate}
        onSavePending={savePending}
        onDiscard={discard}
        onRemove={(handle) =>
          run(() => removeAgentFromPortfolio({ portfolioId, handle }))
        }
        onSaveEdit={(handle, params, mandate) =>
          run(() =>
            updateTeamAgentParams({ portfolioId, handle, params, mandate }),
          )
        }
      />

      {error && (
        <p className="text-sm text-[var(--color-red)] font-mono" role="alert">
          {error}
        </p>
      )}

      {/* ADD AGENTS — collapsed bar that expands to the library. With an empty
          team the library is always shown (there's no roster to collapse, and
          it's the only way to add a first agent); with a team it's behind the
          "Add or change agents" bar. Deriving `showLibrary` from the live team
          length — rather than the mount-time `addOpen` seed — is what keeps the
          add affordance from vanishing after the last agent is removed. */}
      <div>
        {team.length > 0 && (
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            className="w-full flex items-center justify-between rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-3 text-left hover:bg-white/[0.04] transition-colors"
          >
            <span className="font-mono text-sm text-text-dim">
              <span className="text-[var(--color-green)]">+</span> Add or change
              agents
            </span>
            <span className="font-mono text-xs text-text-muted">
              {addOpen ? "Close" : "Open"}
            </span>
          </button>
        )}
        {(team.length === 0 || addOpen) && (
          <div className={team.length > 0 ? "mt-5" : ""}>
            <Library
              library={library}
              onTeam={onTeam}
              pendingHandles={pendingHandles}
              onAdd={addAgent}
              firstRun={team.length === 0}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ----- The "Your Team" unit (coverage header + body + verdict footer) ------

function YourTeamUnit({
  team,
  pending,
  isEmpty,
  busy,
  coverage,
  libraryOpen,
  onDropAgent,
  onPendingParams,
  onPendingMandate,
  onSavePending,
  onDiscard,
  onRemove,
  onSaveEdit,
}: {
  team: TeamAgent[];
  pending: PendingItem[];
  isEmpty: boolean;
  busy: boolean;
  coverage: Coverage;
  /** Whether the agent library is currently visible (agents draggable). */
  libraryOpen: boolean;
  onDropAgent: (handle: string) => void;
  onPendingParams: (key: string, params: Record<string, number | string>) => void;
  onPendingMandate: (key: string, mandate: string) => void;
  onSavePending: (item: PendingItem) => void;
  onDiscard: (key: string) => void;
  onRemove: (handle: string) => void;
  onSaveEdit: (
    handle: string,
    params: Record<string, number | string>,
    mandate: string | null,
  ) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <section>
      <h2 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green)] mb-3">
        Your agent team
      </h2>

      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const handle = e.dataTransfer.getData(DRAG_MIME);
          if (handle) onDropAgent(handle);
        }}
        className={`rounded-2xl border overflow-hidden transition-colors ${
          dragOver
            ? "border-[var(--color-green)]/60"
            : "border-white/10"
        }`}
      >
        {/* HEADER — coverage chips, pinned to the top. */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white/[0.025] border-b border-white/[0.06]">
          <span className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-muted">
            Coverage
          </span>
          <CoverageHeader coverage={coverage} />
        </div>

        {/* BODY */}
        <div
          className={dragOver ? "bg-[var(--color-green)]/[0.05]" : ""}
        >
          {isEmpty ? (
            <div className="m-4 rounded-xl border border-dashed border-white/15 bg-white/[0.015] px-6 py-12 text-center">
              <p className="text-2xl mb-2" aria-hidden>
                ⌑
              </p>
              <p className="text-base font-bold text-text">
                Drag your first agent here
              </p>
              <p className="text-sm text-text-muted mt-1">
                Buyers, sellers and managers all drop into this one place.
              </p>
              <p className="text-sm text-[var(--color-green)] mt-3 font-mono">
                New here? Start with a buyer to open positions.
              </p>
            </div>
          ) : (
            <>
              {/* Tile grid — mirrors the hireable library below. A card being
                  edited (or an unsaved drag-in) spans both columns so its
                  params/brief editor has room. */}
              <ul className="grid gap-3 sm:grid-cols-2 p-3">
                {team.map((a) => (
                  <TeamCard
                    key={a.handle}
                    agent={a}
                    busy={busy}
                    onRemove={onRemove}
                    onSaveEdit={onSaveEdit}
                  />
                ))}
                {pending.map((item) => (
                  <PendingCard
                    key={item.key}
                    item={item}
                    busy={busy}
                    onParams={(params) => onPendingParams(item.key, params)}
                    onMandate={(mandate) => onPendingMandate(item.key, mandate)}
                    onSave={() => onSavePending(item)}
                    onDiscard={() => onDiscard(item.key)}
                  />
                ))}
              </ul>
              {/* Shaded "drag more" slot — only when the library is open below,
                  i.e. there are actually agents visible to drag in. When the
                  library is collapsed, additions go through the "Add or change
                  agents" button, so the hint would point at nothing. */}
              {libraryOpen && (
                <div className="m-4 rounded-xl border border-dashed border-white/15 bg-white/[0.015] px-4 py-4 text-center text-sm font-mono text-text-muted">
                  <span aria-hidden>⌑ </span>Drag more agents here
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ----- Coverage header chips -----------------------------------------------

function CoverageHeader({ coverage }: { coverage: Coverage }) {
  return (
    <div className="flex items-center gap-3 sm:gap-4">
      <CoverageChip label="Buy" covered={coverage.buy} action="buy" />
      <CoverageChip label="Sell" covered={coverage.sell} action="sell" />
      <CoverageChip label="Manage" covered={coverage.manage} action="manage" />
    </div>
  );
}

function CoverageChip({
  label,
  covered,
  action,
}: {
  label: string;
  covered: boolean;
  action: AgentAction;
}) {
  const meta = ACTION_META[action];
  return (
    <span className="inline-flex items-center gap-1.5" title={covered ? `${label} covered` : `No ${label.toLowerCase()} agent yet`}>
      <span
        aria-hidden
        className="grid place-items-center h-3.5 w-3.5 rounded-[3px] text-[9px] font-bold"
        style={{
          background: covered ? meta.color : "transparent",
          border: `1px solid ${covered ? meta.color : "var(--color-text-muted)"}`,
          color: "var(--color-bg)",
        }}
      >
        {covered ? "✓" : ""}
      </span>
      <span
        className="text-sm font-mono"
        style={{ color: covered ? "var(--color-text)" : "var(--color-text-muted)" }}
      >
        {label}
      </span>
    </span>
  );
}

// ----- Verdict footer ------------------------------------------------------

// ----- Schedule formatting -------------------------------------------------
// Cron-aware next-run helpers live in the shared, client-safe schedule module
// (single source of the weekly-heartbeat constant).

// ----- Saved (live) team card ----------------------------------------------

function TeamCard({
  agent,
  busy,
  onRemove,
  onSaveEdit,
}: {
  agent: TeamAgent;
  busy: boolean;
  onRemove: (handle: string) => void;
  onSaveEdit: (
    handle: string,
    params: Record<string, number | string>,
    mandate: string | null,
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.params);
  const [draftMandate, setDraftMandate] = useState(effectiveMandate(agent));
  const [now, setNow] = useState(() => Date.now());
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isDispatching, startRun] = useTransition();
  const meta = ACTION_META[agent.action];
  const hasBrief = agent.defaultMandate !== null;
  const configurable = agent.paramSchema.length > 0 || hasBrief;

  // One ticking clock per card drives the live relative times + cooldown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cooling = cooldownEndsAt ? Math.max(0, cooldownEndsAt - now) : 0;
  // A run is "live" while the dispatch is in flight or within the cooldown
  // window (the dispatched workflow is likely still executing).
  const running = isDispatching || cooling > 0;

  function runNow() {
    setRunError(null);
    startRun(async () => {
      const res = await runAgent({ agentHandle: agent.handle });
      if (!res.ok) {
        setRunError(res.error ?? "Couldn't start the run.");
        return;
      }
      setCooldownEndsAt(Date.now() + RUN_COOLDOWN_MS);
    });
  }

  return (
    <li
      className={`rounded-xl border border-white/10 bg-white/[0.02] p-3 ${
        editing ? "sm:col-span-2" : ""
      }`}
    >
      {/* Header: identity on the left, controls top-right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-baseline gap-2 flex-wrap min-w-0">
          {/* Action dot — static identity colour; pulses only during a run. */}
          <span
            aria-hidden
            className={`self-center h-2 w-2 rounded-full shrink-0 ${running ? "animate-pulse" : ""}`}
            style={{ background: meta.color }}
          />
          <span className="font-bold text-text">{agent.displayName}</span>
          <ActionPill action={agent.action} />
          {hasCustomMandate(agent) && (
            <span
              className="text-[10px] font-mono text-[var(--color-cyan)]"
              title="Running a custom brief you set"
            >
              ✎ custom brief
            </span>
          )}
        </div>

        {/* Controls: Run now · gear · remove. No Run/Stop — agents are
            scheduled runners, not always-on processes. */}
        {!editing && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={running}
              onClick={runNow}
              title="Run this agent immediately"
              className="rounded-lg border border-[var(--color-cyan)]/40 px-2.5 py-1 text-xs font-mono text-[var(--color-cyan)] hover:bg-[var(--color-cyan)]/10 transition-colors disabled:opacity-50"
            >
              ⟳ {running ? "Running…" : "Run now"}
            </button>
            {configurable && (
              <button
                type="button"
                onClick={() => {
                  setDraft(agent.params);
                  setDraftMandate(effectiveMandate(agent));
                  setEditing(true);
                }}
                title="Configure"
                aria-label="Configure"
                className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-mono text-text-dim hover:text-text hover:bg-white/[0.04] transition-colors"
              >
                ⚙
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(agent.handle)}
              title="Remove from team"
              aria-label="Remove from team"
              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-mono text-text-muted hover:text-[var(--color-red)] hover:border-[var(--color-red)]/40 transition-colors disabled:opacity-50"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* One compact meta line: powered-by · next-run. */}
      {!editing && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px] font-mono text-text-muted">
          {running && (
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full animate-pulse"
              style={{ background: meta.color }}
            />
          )}
          {agent.poweredBy && <span>{agent.poweredBy}</span>}
          {agent.poweredBy && <span aria-hidden>·</span>}
          <span>
            {running
              ? "Running now…"
              : scheduleText(
                  agent.lastRunAt,
                  agent.heartbeatIntervalHours,
                  now,
                )}
          </span>
        </div>
      )}

      {!editing && (
        <p
          className="text-xs text-text-dim mt-1.5 leading-snug line-clamp-2"
          title={fillSentence(agent, agent.params)}
        >
          {fillSentence(agent, agent.params)}
        </p>
      )}

      {!editing && agent.action === "sell" && agent.triggers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {agent.triggers.map((t) => (
            <TriggerChip key={t} trigger={t} />
          ))}
        </div>
      )}

      {editing && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
          <ParamControls
            schema={agent.paramSchema}
            values={draft}
            onChange={setDraft}
          />
          <p className="text-sm text-text-dim mt-3 italic">
            {fillSentence(agent, draft)}
          </p>
          {hasBrief && (
            <BriefField
              action={agent.action}
              value={draftMandate}
              onChange={setDraftMandate}
            />
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onSaveEdit(
                  agent.handle,
                  draft,
                  mandateOverride(agent, draftMandate),
                );
                setEditing(false);
              }}
              className="rounded-lg bg-[var(--color-green)]/15 border border-[var(--color-green)]/40 px-3 py-1.5 text-xs font-mono text-[var(--color-green)] hover:bg-[var(--color-green)]/25 transition-colors disabled:opacity-50"
            >
              Save changes
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(agent.params);
                setDraftMandate(effectiveMandate(agent));
                setEditing(false);
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-mono text-text-muted hover:text-text transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {runError && (
        <p className="mt-2 text-[11px] font-mono text-[var(--color-red)]">
          {runError}
        </p>
      )}
    </li>
  );
}

// ----- Unsaved drag-in card ------------------------------------------------

function PendingCard({
  item,
  busy,
  onParams,
  onMandate,
  onSave,
  onDiscard,
}: {
  item: PendingItem;
  busy: boolean;
  onParams: (params: Record<string, number | string>) => void;
  onMandate: (mandate: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { agent, params } = item;
  return (
    <li
      className="sm:col-span-2 rounded-xl border border-white/10 border-l-2 p-4"
      style={{ borderLeftColor: "var(--color-orange)", background: "rgba(255,153,0,0.03)" }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-bold text-text">{agent.displayName}</span>
        <ActionPill action={agent.action} />
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-orange)] border border-[var(--color-orange)]/40 rounded px-1.5 py-0.5">
          Unsaved
        </span>
      </div>
      {agent.poweredBy && (
        <p className="text-[11px] font-mono text-text-muted mt-0.5">
          powered by {agent.poweredBy}
        </p>
      )}

      <div className="mt-3">
        <ParamControls
          schema={agent.paramSchema}
          values={params}
          onChange={onParams}
        />
      </div>

      {/* Live plain-language sentence — rewrites as the user tunes. */}
      <p className="text-sm text-text-dim mt-3 italic leading-relaxed">
        {fillSentence(agent, params)}
      </p>

      {/* Per-agent brief, pre-filled with the agent's default (migration 046).
          Only thinking agents (default mandate set) get one. */}
      {agent.defaultMandate !== null && (
        <BriefField
          action={agent.action}
          value={item.mandate}
          onChange={onMandate}
        />
      )}
      {agent.action === "sell" && agent.triggers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {agent.triggers.map((t) => (
            <TriggerChip key={t} trigger={t} />
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onSave}
          className="rounded-lg bg-[var(--color-green)]/15 border border-[var(--color-green)]/45 px-4 py-1.5 text-xs font-mono font-bold text-[var(--color-green)] hover:bg-[var(--color-green)]/25 transition-colors disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save → live"}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-mono text-text-muted hover:text-text transition-colors"
        >
          Discard
        </button>
      </div>
    </li>
  );
}

// ----- Param controls ------------------------------------------------------

function ParamControls({
  schema,
  values,
  onChange,
}: {
  schema: ParamSpec[];
  values: Record<string, number | string>;
  onChange: (params: Record<string, number | string>) => void;
}) {
  if (schema.length === 0) {
    return (
      <p className="text-xs text-text-muted font-mono">
        No settings — works out of the box.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {schema.map((spec) => (
        <div key={spec.key} className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-mono text-text-muted w-40 shrink-0">
            {spec.label}
          </label>
          {spec.type === "select" ? (
            <select
              value={String(values[spec.key] ?? spec.default)}
              onChange={(e) => {
                const opt = spec.options?.find(
                  (o) => String(o.value) === e.target.value,
                );
                onChange({
                  ...values,
                  [spec.key]: opt ? opt.value : e.target.value,
                });
              }}
              className="rounded-lg border border-white/15 bg-black/30 px-2.5 py-1 text-sm font-mono text-text focus:border-[var(--color-cyan)] outline-none"
            >
              {(spec.options ?? []).map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={spec.step ?? 1}
                value={Number(values[spec.key] ?? spec.default)}
                onChange={(e) =>
                  onChange({ ...values, [spec.key]: Number(e.target.value) })
                }
                className="flex-1 accent-[var(--color-green)]"
              />
              <span className="font-mono text-sm text-text tabular-nums w-16 text-right">
                {values[spec.key] ?? spec.default}
                {spec.unit ?? ""}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ----- Brief (per-agent mandate) -------------------------------------------

function BriefField({
  action,
  value,
  onChange,
}: {
  action: AgentAction;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mt-3">
      <label className="text-xs font-mono text-text-muted block mb-1">
        {briefLabel(action)}{" "}
        <span className="text-text-muted/70">— this agent&apos;s brief</span>
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-text-dim leading-relaxed focus:border-[var(--color-cyan)] outline-none resize-y"
      />
      <p className="text-[11px] font-mono text-text-muted mt-1">
        Pre-filled with the agent&apos;s default. Tune it, or leave it to track
        the default.
      </p>
    </div>
  );
}

// ----- Library shelf -------------------------------------------------------

function Library({
  library,
  onTeam,
  pendingHandles,
  onAdd,
  firstRun,
}: {
  library: LibraryAgent[];
  onTeam: Set<string>;
  pendingHandles: Set<string>;
  onAdd: (agent: LibraryAgent) => void;
  firstRun: boolean;
}) {
  const [tab, setTab] = useState<"all" | AgentAction>(firstRun ? "buy" : "all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c = { all: library.length, buy: 0, sell: 0, manage: 0 };
    for (const a of library) c[a.action] += 1;
    return c;
  }, [library]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return library.filter((a) => {
      if (tab !== "all" && a.action !== tab) return false;
      if (!q) return true;
      return (
        a.displayName.toLowerCase().includes(q) ||
        (a.poweredBy ?? "").toLowerCase().includes(q) ||
        (a.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [library, tab, query]);

  return (
    <div>
      {firstRun && (
        <h2 className="text-2xl font-bold tracking-[-0.02em] text-text mb-1">
          Build your team
        </h2>
      )}
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-green)]">
          Agent library · {library.length}
        </p>
      </div>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search agents…"
        className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-sm font-mono text-text placeholder:text-text-muted focus:border-[var(--color-cyan)] outline-none mb-3"
      />

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-full border px-3 py-1 text-xs font-mono transition-colors ${
              tab === t.key
                ? "border-[var(--color-green)]/50 bg-[var(--color-green)]/10 text-[var(--color-green)]"
                : "border-white/15 text-text-muted hover:text-text"
            }`}
          >
            {t.label}{" "}
            <span className="text-text-muted">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-text-muted font-mono py-6 text-center">
          No matching agents.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((a) => (
            <LibraryCard
              key={a.handle}
              agent={a}
              added={onTeam.has(a.handle) || pendingHandles.has(a.handle)}
              onAdd={() => onAdd(a)}
            />
          ))}
          {/* Build-your-own promo — pinned, every tab (brief §9). */}
          <PromoCard />
        </div>
      )}
    </div>
  );
}

function LibraryCard({
  agent,
  added,
  onAdd,
}: {
  agent: LibraryAgent;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      draggable={!added}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, agent.handle);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => !added && onAdd()}
      role="button"
      tabIndex={added ? -1 : 0}
      onKeyDown={(e) => {
        if (!added && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onAdd();
        }
      }}
      className={`rounded-2xl border p-4 transition-colors ${
        added
          ? "border-white/[0.06] bg-white/[0.01] opacity-60 cursor-default"
          : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04] cursor-grab active:cursor-grabbing"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <ActionPill action={agent.action} />
        <span className="text-text-muted text-xs font-mono" aria-hidden>
          {added ? "✓ on team" : "⠿"}
        </span>
      </div>
      <p className="font-bold text-text mt-2">{agent.displayName}</p>
      {agent.poweredBy && (
        <p className="text-[11px] font-mono text-text-muted mt-0.5">
          powered by {agent.poweredBy}
        </p>
      )}
      {agent.description && (
        <p className="text-xs text-text-muted mt-2 leading-relaxed line-clamp-2">
          {agent.description}
        </p>
      )}
    </div>
  );
}

function PromoCard() {
  return (
    <a
      href="/docs#build-an-agent"
      className="rounded-2xl border border-[var(--color-cyan)]/30 bg-[var(--color-cyan)]/[0.04] p-4 hover:bg-[var(--color-cyan)]/[0.08] transition-colors block"
    >
      <span className="inline-block text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-cyan)] border border-[var(--color-cyan)]/40 rounded px-1.5 py-0.5">
        Custom
      </span>
      <p className="font-bold text-text mt-2">Build your own agent</p>
      <p className="text-xs text-text-muted mt-2 leading-relaxed">
        Write a strategy on any frontier model and add it to your team. See the
        build-an-agent guide →
      </p>
    </a>
  );
}

// ----- Small shared bits ---------------------------------------------------

function ActionPill({ action }: { action: AgentAction }) {
  const meta = ACTION_META[action];
  return (
    <span
      className="text-[10px] font-mono font-bold tracking-[0.08em] rounded px-1.5 py-0.5"
      style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
    >
      {meta.label}
    </span>
  );
}

function TriggerChip({ trigger }: { trigger: string }) {
  return (
    <span className="text-[10px] font-mono rounded-full border border-[var(--color-red)]/30 bg-[var(--color-red)]/[0.06] px-2 py-0.5 text-[var(--color-red)]/90">
      {TRIGGER_LABELS[trigger] ?? trigger}
    </span>
  );
}
