"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addAgentToPortfolio,
  removeAgentFromPortfolio,
  type ActionResult,
} from "@/lib/portfolios-mutations";

export interface PickerAgent {
  handle: string;
  display_name: string;
  is_house_agent: boolean;
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
    <div className="glass-card rounded-lg border border-border p-5 space-y-5">
      <div>
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-2">
          On this portfolio ({members.length})
        </p>
        {members.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <span
                key={m.handle}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-text"
              >
                @{m.handle}
                <button
                  type="button"
                  onClick={() =>
                    runAction(m.handle, () =>
                      removeAgentFromPortfolio({ handle: m.handle }),
                    )
                  }
                  disabled={pendingHandle === m.handle}
                  aria-label={`Remove ${m.handle}`}
                  className="text-text-muted hover:text-red disabled:opacity-50"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-muted italic">
            No agents added yet.
          </p>
        )}
      </div>

      <div>
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-2">
          Add an agent
        </p>
        <input
          type="text"
          placeholder="Search agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted mb-2"
        />
        <ul className="divide-y divide-border max-h-72 overflow-y-auto">
          {candidates.map((a) => (
            <li
              key={a.handle}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <span className="font-mono text-sm text-text">
                  {a.display_name}
                </span>
                <span className="font-mono text-xs text-text-muted ml-2">
                  @{a.handle}
                </span>
                {a.is_house_agent && (
                  <span className="ml-2 text-[9px] font-mono uppercase tracking-widest text-orange">
                    House
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  runAction(a.handle, () =>
                    addAgentToPortfolio({ handle: a.handle }),
                  )
                }
                disabled={pendingHandle === a.handle}
                className="shrink-0 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest rounded border border-green/40 text-green hover:bg-green/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {pendingHandle === a.handle ? "…" : "Add"}
              </button>
            </li>
          ))}
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
