"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runAgent, runAllAgents } from "@/lib/run-agent-mutations";

const COOLDOWN_SECONDS = 60;

interface BaseProps {
  /** Null → portfolio is a draft; render the button disabled with a hint. */
  launchedAt: string | null;
}

interface RunNowProps extends BaseProps {
  agentHandle: string;
  agentId: string;
  portfolioId: string;
}

/**
 * Per-agent "Run now" button rendered inside the agent-picker member row.
 *
 * Click → calls the `runAgent` server action, which validates ownership +
 * membership and POSTs `workflow_dispatch` to GitHub. While pending the
 * button shows "Running…"; on success the button locks for 60 seconds
 * (same window the server-side throttle enforces) and counts down so
 * the user gets feedback that the dispatch landed.
 */
export default function RunNowButton({
  agentHandle,
  agentId,
  launchedAt,
}: RunNowProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while we're inside the cooldown window so the
  // "Cooling… 45s" countdown stays fresh. Cleaned up the moment the
  // cooldown expires.
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

  const disabled = launchedAt == null || isPending || cooling > 0;
  const title =
    launchedAt == null
      ? "Launch the portfolio first."
      : cooling > 0
        ? `Cooling… ${cooling}s`
        : isPending
          ? "Dispatching…"
          : "Trigger a one-off rebalance for this agent.";

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await runAgent({ agentHandle, agentId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCooldownEndsAt(Date.now() + COOLDOWN_SECONDS * 1000);
      router.refresh();
    });
  }

  let label: string;
  if (isPending) label = "Running…";
  else if (cooling > 0) label = `Cooling… ${cooling}s`;
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

interface RunAllProps extends BaseProps {
  portfolioId: string;
}

/**
 * "Run all agents" — same shape as `RunNowButton` but dispatches without
 * a `handle` filter so every member rebalances in joined_at order.
 */
export function RunAllAgentsButton({ launchedAt }: RunAllProps) {
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

  const disabled = launchedAt == null || isPending || cooling > 0;
  const title =
    launchedAt == null
      ? "Launch the portfolio first."
      : cooling > 0
        ? `Cooling… ${cooling}s`
        : isPending
          ? "Dispatching…"
          : "Trigger a one-off rebalance for every agent on this portfolio.";

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await runAllAgents();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCooldownEndsAt(Date.now() + COOLDOWN_SECONDS * 1000);
      router.refresh();
    });
  }

  let label: string;
  if (isPending) label = "Running…";
  else if (cooling > 0) label = `Cooling… ${cooling}s`;
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
