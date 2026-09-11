"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPortfolioCashPolicy } from "@/lib/portfolios-mutations";
import {
  MAX_RESERVE_PCT,
  describeCashPolicy,
  resolvePolicy,
  type CashPolicy,
} from "@/lib/cash-policy";

/**
 * Owner control for the portfolio's CASH POLICY (migration 088).
 *
 * A portfolio's buyers share one pot and nothing allocated it between them.
 * The swarm runs self-sourced buyers (Double-Down) BEFORE the screen draft,
 * and the draft then buys until cash hits its floor — so the draft always left
 * ~2%, and Double-Down always arrived to find ~2%. It made zero trades in its
 * entire life while the screen buyer made 25 on the same book.
 *
 * One setting, deliberately. The mechanism already existed inside the draft
 * (`snake_draft_plan(cash_reserve_pct=)`); this is just somewhere for the owner
 * to set the number.
 *
 * Collapsed by default and honest about its state in the header, for the same
 * reason as the Sell discipline panel: most owners will never touch it, but it
 * shapes what their agents can do, so it must not become invisible.
 */
export default function CashPolicyPanel({
  portfolioId,
  policy: stored,
  totalValueUsd,
}: {
  portfolioId: string;
  policy: Record<string, unknown> | null;
  totalValueUsd?: number | null;
}) {
  const router = useRouter();
  const saved = resolvePolicy(stored);
  const [draft, setDraft] = useState<CashPolicy>(saved);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = draft.reserve_pct !== saved.reserve_pct;

  // Shut unless the owner opened it — or is mid-edit, in which case shutting it
  // would hide the Save button and lose the change silently.
  const [open, setOpen] = useState(false);
  const expanded = open || dirty;

  const { summary, customised } = describeCashPolicy(draft, totalValueUsd);

  function save() {
    if (!dirty || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await setPortfolioCashPolicy({ portfolioId, policy: draft });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setJustSaved(true);
      router.refresh();
    });
  }

  return (
    <details
      open={expanded}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-lg border border-white/10 bg-white/[0.02] [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 p-4 sm:p-5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          <span aria-hidden className="mr-2 inline-block transition-transform group-open:rotate-90">
            &#9656;
          </span>
          Cash reserve
        </span>
        <span className="min-w-0 font-mono text-[11px] text-text-muted/80">
          {summary}
        </span>
        {customised && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-cyan)]">
            Customised
          </span>
        )}
        {dirty && (
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-orange)]">
            Unsaved
          </span>
        )}
      </summary>

      <div className="px-4 pb-4 sm:px-5 sm:pb-5">
        <p className="mb-4 max-w-prose text-sm text-text-muted">
          Your buyers share one pot. The agent that picks from the screener runs
          last and spends whatever is left, so without this it takes everything
          and the agents that top up existing holdings never get a turn.
        </p>

        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="max-w-prose">
            <div className="text-sm text-text">
              Stop buying new names at this much cash
            </div>
            <p className="mt-0.5 text-xs text-text-muted">
              Whatever is held back is there for your other buyers next time the
              team runs. It is not idle — it just gets spent topping up a holding
              you already own instead of opening a new one. Set 0 to let the
              screener buyer use everything.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2">
            <input
              type="number"
              min={0}
              max={MAX_RESERVE_PCT}
              step={0.5}
              value={draft.reserve_pct}
              disabled={pending}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value);
                setJustSaved(false);
                setError(null);
                setDraft({
                  reserve_pct: Number.isFinite(next)
                    ? Math.max(0, Math.min(MAX_RESERVE_PCT, next))
                    : saved.reserve_pct,
                });
              }}
              aria-label="Cash reserve percent"
              className="w-20 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-right font-mono text-sm text-text focus:border-white/25 focus:outline-none disabled:opacity-50"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              % of book
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || pending}
            className="rounded border border-[var(--color-green)]/40 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-green)] transition-colors hover:bg-[var(--color-green)]/10 disabled:cursor-not-allowed disabled:border-white/10 disabled:text-text-muted disabled:hover:bg-transparent"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          {dirty && !pending && (
            <button
              type="button"
              onClick={() => {
                setDraft(saved);
                setError(null);
              }}
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted hover:text-text"
            >
              Revert
            </button>
          )}
          {!dirty && justSaved && (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-green)]">
              Saved
            </span>
          )}
          {!dirty && !justSaved && (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              Applies from the next heartbeat
            </span>
          )}
          {error && (
            <span className="font-mono text-xs text-[var(--color-red)]">{error}</span>
          )}
        </div>
      </div>
    </details>
  );
}
