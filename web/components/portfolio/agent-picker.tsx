"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addAgentToPortfolio,
  removeAgentFromPortfolio,
  type ActionResult,
} from "@/lib/portfolios-mutations";
import { roleFor, type AgentPhase } from "@/lib/agent-roles";

export interface PickerAgent {
  handle: string;
  display_name: string;
  is_house_agent: boolean;
  strategy: string | null;
  /** 30-day return %, or null when still warming up / unavailable. */
  return30d: number | null;
}

function fmtReturn(v: number | null): { text: string; cls: string } {
  if (v == null) return { text: "—", cls: "text-text-muted" };
  const sign = v > 0 ? "+" : "";
  const cls = v > 0 ? "text-green" : v < 0 ? "text-red" : "text-text-dim";
  return { text: `${sign}${v.toFixed(1)}%`, cls };
}

function RolePill({ phase, role }: { phase: AgentPhase; role: string }) {
  const cls =
    phase === "curate"
      ? "border-cyan/30 bg-cyan/[0.08] text-cyan"
      : phase === "trade"
        ? "border-green/30 bg-green/[0.08] text-green"
        : "border-white/10 bg-bg text-text-muted";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-widest border ${cls}`}
    >
      {role}
    </span>
  );
}

function RoleStatus({
  label,
  hint,
  satisfied,
}: {
  label: string;
  hint: string;
  satisfied: boolean;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
        satisfied
          ? "border-green/30 bg-green/[0.05]"
          : "border-white/10 bg-white/[0.02]"
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          satisfied
            ? "bg-green/20 text-green"
            : "border border-text-muted/40 text-text-muted"
        }`}
      >
        {satisfied ? "✓" : ""}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-mono font-bold text-text">
          {label}{" "}
          <span
            className={`font-normal ${satisfied ? "text-green" : "text-orange"}`}
          >
            {satisfied ? "added" : "still needed"}
          </span>
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

export default function AgentPicker({
  members,
  allAgents,
}: {
  members: PickerAgent[];
  allAgents: PickerAgent[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const memberHandles = useMemo(
    () => new Set(members.map((m) => m.handle)),
    [members],
  );

  const memberPhases = useMemo(
    () => members.map((m) => roleFor(m.strategy).phase),
    [members],
  );
  const hasCurator = memberPhases.includes("curate");
  const hasBuyer = memberPhases.includes("trade");

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allAgents
      .filter((a) => !memberHandles.has(a.handle))
      .filter(
        (a) =>
          !q ||
          a.handle.toLowerCase().includes(q) ||
          a.display_name.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [allAgents, memberHandles, query]);

  function runAction(handle: string, fn: () => Promise<ActionResult>) {
    setError(null);
    setPendingHandle(handle);
    startTransition(async () => {
      const result = await fn();
      setPendingHandle(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {/* Required-roles status */}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <RoleStatus
          label="Shortlist Builder"
          hint="Curates the watchlist of equities to consider."
          satisfied={hasCurator}
        />
        <RoleStatus
          label="Buying Agent"
          hint="Trades the $1M book from the watchlist."
          satisfied={hasBuyer}
        />
      </div>

      {/* Current members */}
      <div>
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-2">
          On this portfolio ({members.length})
        </p>
        {members.length > 0 ? (
          <ul className="space-y-2">
            {members.map((m) => {
              const { role, phase } = roleFor(m.strategy);
              const ret = fmtReturn(m.return30d);
              return (
                <li
                  key={m.handle}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-text truncate">
                        {m.display_name}
                      </span>
                      <RolePill phase={phase} role={role} />
                      {m.is_house_agent && (
                        <span className="text-[9px] font-mono uppercase tracking-widest text-orange">
                          House
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-text-muted">
                      @{m.handle} ·{" "}
                      <span className={ret.cls}>{ret.text} 30d</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      runAction(m.handle, () =>
                        removeAgentFromPortfolio({ handle: m.handle }),
                      )
                    }
                    disabled={pendingHandle === m.handle}
                    aria-label={`Remove ${m.handle}`}
                    className="shrink-0 px-2 py-1 font-mono text-xs text-text-muted hover:text-red disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red/40 rounded transition-colors"
                  >
                    {pendingHandle === m.handle ? "…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-text-muted italic">
            No agents added yet.
          </p>
        )}
      </div>

      {/* Add an agent */}
      <div>
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-2">
          Add an agent
        </p>
        <input
          type="text"
          placeholder="Search agents…"
          aria-label="Search agents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted mb-2"
        />
        <ul className="divide-y divide-white/[0.06] max-h-72 overflow-y-auto">
          {candidates.map((a) => {
            const { role, phase } = roleFor(a.strategy);
            const ret = fmtReturn(a.return30d);
            return (
              <li
                key={a.handle}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-text truncate">
                      {a.display_name}
                    </span>
                    <RolePill phase={phase} role={role} />
                    {a.is_house_agent && (
                      <span className="text-[9px] font-mono uppercase tracking-widest text-orange">
                        House
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-text-muted">
                    @{a.handle} · <span className={ret.cls}>{ret.text} 30d</span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    runAction(a.handle, () =>
                      addAgentToPortfolio({ handle: a.handle }),
                    )
                  }
                  disabled={pendingHandle === a.handle}
                  className="shrink-0 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest rounded border border-green/40 text-green hover:bg-green/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40 transition-colors"
                >
                  {pendingHandle === a.handle ? "…" : "Add"}
                </button>
              </li>
            );
          })}
          {candidates.length === 0 && (
            <li className="py-2 text-sm text-text-muted italic">
              No matching agents.
            </li>
          )}
        </ul>
      </div>

      {error && (
        <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          {error}
        </div>
      )}
    </div>
  );
}
