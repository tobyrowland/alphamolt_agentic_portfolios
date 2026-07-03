"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAgent, runAllAgents } from "@/lib/run-agent-mutations";

// Matches the server-side throttle in run-agent-mutations.ts. Sized to
// span a typical heartbeat run (~5 mins for an LLM curator) so the button
// stays disabled while the previous workflow is likely still running.
const COOLDOWN_SECONDS = 300;

interface RunNowProps {
  agentHandle: string;
  agentId: string;
  portfolioId: string;
}

/**
 * Per-agent "Run now" button rendered inside the agent-picker member row.
 *
 * Click → calls the `runAgent` server action, which validates ownership +
 * membership and POSTs `workflow_dispatch` to GitHub. The server action
 * returns quickly (just the dispatch), but the workflow itself runs on
 * GitHub Actions and typically takes ~5 mins for an LLM curator. While
 * the cooldown window is active the button locks and reads "Running…
 * (5 mins typical)" so the wait is honest rather than implying the
 * action already completed. The same window matches the server-side
 * throttle in `run-agent-mutations.ts`.
 */
export default function RunNowButton({
  agentHandle,
  agentId,
  portfolioId,
}: RunNowProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownEndsAt == null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= cooldownEndsAt) {
        setCooldownEndsAt(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownEndsAt]);

  const cooling =
    cooldownEndsAt != null && now < cooldownEndsAt
      ? Math.ceil((cooldownEndsAt - now) / 1000)
      : 0;

  const disabled = isPending || cooling > 0;
  const title =
    cooling > 0
      ? "The workflow runs on GitHub Actions and typically takes ~5 minutes. The button re-enables when the cooldown window expires."
      : isPending
        ? "Dispatching…"
        : "Trigger a one-off rebalance for this agent.";

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await runAgent({ portfolioId, agentHandle, agentId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCooldownEndsAt(Date.now() + COOLDOWN_SECONDS * 1000);
      router.refresh();
    });
  }

  // The cooldown window matches a typical workflow runtime, so labelling
  // it "Running…" is more honest than the previous "Cooling…" countdown —
  // the previous label suggested the action was already done.
  let label: string;
  if (isPending) label = "Dispatching…";
  else if (cooling > 0) label = "Running… (5 mins typical)";
  else label = "Run now";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={title}
        className="shrink-0 px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest rounded border border-cyan/40 text-cyan hover:bg-cyan/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors"
      >
        {label}
      </button>
      {error && (
        <span className="text-[10px] font-mono text-red whitespace-nowrap">
          {error}
        </span>
      )}
    </div>
  );
}

interface RunAllProps {
  portfolioId: string;
}

/**
 * "Run all agents" — same shape as `RunNowButton` but dispatches without
 * a `handle` filter so every member rebalances in joined_at order.
 */
export function RunAllAgentsButton({ portfolioId }: RunAllProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownEndsAt == null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= cooldownEndsAt) {
        setCooldownEndsAt(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownEndsAt]);

  const cooling =
    cooldownEndsAt != null && now < cooldownEndsAt
      ? Math.ceil((cooldownEndsAt - now) / 1000)
      : 0;

  const disabled = isPending || cooling > 0;
  const title =
    cooling > 0
      ? "The workflow runs on GitHub Actions and typically takes ~5 minutes. The button re-enables when the cooldown window expires."
      : isPending
        ? "Dispatching…"
        : "Trigger a one-off rebalance for every agent on this portfolio.";

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await runAllAgents({ portfolioId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCooldownEndsAt(Date.now() + COOLDOWN_SECONDS * 1000);
      router.refresh();
    });
  }

  let label: string;
  if (isPending) label = "Dispatching…";
  else if (cooling > 0) label = "Running… (5 mins typical)";
  else label = "Run all agents";

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={title}
        className="shrink-0 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-cyan/40 text-cyan hover:bg-cyan/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors"
      >
        {label}
      </button>
      {error && (
        <span className="text-[11px] font-mono text-red">{error}</span>
      )}
    </div>
  );
}
