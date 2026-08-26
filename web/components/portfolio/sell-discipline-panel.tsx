"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPortfolioThesisPolicy } from "@/lib/portfolios-mutations";
import {
  DEFAULTS,
  MAX_GRACE_DAYS,
  describeSellDiscipline,
  resolvePolicy,
  type ThesisPolicy,
} from "@/lib/thesis-policy";

/**
 * Owner control for the portfolio's SELL DISCIPLINE (migration 086).
 *
 * When a buyer opens a position it also writes the tripwires ("break signals")
 * that will later justify selling it — the optimist authoring its own
 * falsification test, which a different agent then enforces. Nothing
 * constrained what could be written, so in production a portfolio whose screen
 * filters on "down >20% vs the market" had its buyer write "sell if down >20%
 * vs the market": every position arrived pre-broken. These three settings are
 * the owner taking that authority back.
 *
 * Deliberately three switches and not a rule editor. Hand-authored tripwires
 * are a bigger build and should wait until we can see whether these already
 * fix the churn.
 *
 * COLLAPSED BY DEFAULT: most owners never touch these rules, and three settings
 * with a paragraph of explanation each is a lot of page for something they will
 * leave alone. Collapsing must not make the rules invisible, though — they
 * govern every sell the team makes — so the header states what is in force
 * whether it is open or shut, and flags a policy that has been moved off the
 * defaults. It also refuses to collapse over an unsaved edit, since the Save
 * button lives inside: otherwise a toggle flipped, the panel shut and the page
 * left would lose the change with no warning.
 */
export default function SellDisciplinePanel({
  portfolioId,
  policy: stored,
}: {
  portfolioId: string;
  policy: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const saved = resolvePolicy(stored);
  const [draft, setDraft] = useState<ThesisPolicy>(saved);
  const [error, setError] = useState<string | null>(null);
  const [saved_, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty =
    draft.grace_period_days !== saved.grace_period_days ||
    draft.require_fired_break_signal !== saved.require_fired_break_signal ||
    draft.relative_fields_change_only !== saved.relative_fields_change_only;

  // Shut unless the owner opened it — or is mid-edit, in which case shutting it
  // would hide the Save button and lose the change silently.
  const [open, setOpen] = useState(false);
  const expanded = open || dirty;

  function update(patch: Partial<ThesisPolicy>) {
    setSaved(false);
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  }

  function save() {
    if (!dirty || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await setPortfolioThesisPolicy({ portfolioId, policy: draft });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  const { summary, customised } = describeSellDiscipline(draft);

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
          Sell discipline
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
        Rules your whole team works under — the buyer when it writes a
        position&rsquo;s sell triggers, and the reviewer when it acts on them.
      </p>

      <div className="flex flex-col gap-4">
        <NumberRow
          label="Grace period"
          hint="Don't judge a position for this long after buying it. A turnaround can't be proved or disproved in a week. Set 0 to review from day one."
          value={draft.grace_period_days}
          onChange={(v) => update({ grace_period_days: v })}
          disabled={pending}
        />

        <ToggleRow
          label="Only sell on a tripwire that actually fired"
          hint="A sell needs one of the position's recorded break signals to be firing — not just a hoped-for confirmation that hasn't happened yet. Positions with no recorded tripwires are unaffected, so nothing ever becomes unsellable."
          checked={draft.require_fired_break_signal}
          onChange={(v) => update({ require_fired_break_signal: v })}
          disabled={pending}
        />

        <ToggleRow
          label="Loss tripwires must measure change since you bought"
          hint="“Down 20% vs the market” describes where a stock already is — on a mandate that buys fallen names it's true of everything. “Lost a further 15 points since we bought” is a real warning. Applies to P/S, performance-vs-market, % of 52-week high and the composite score. Take-profit tripwires (“sell if P/S climbs past 15”) are unaffected, and so are plain price stops."
          checked={draft.relative_fields_change_only}
          onChange={(v) => update({ relative_fields_change_only: v })}
          disabled={pending}
        />
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
        {!dirty && saved_ && (
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-green)]">
            Saved
          </span>
        )}
        {!dirty && !saved_ && (
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

function NumberRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="max-w-prose">
        <div className="text-sm text-text">{label}</div>
        <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
      </div>
      <label className="flex shrink-0 items-center gap-2">
        <input
          type="number"
          min={0}
          max={MAX_GRACE_DAYS}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            onChange(
              Number.isFinite(next)
                ? Math.max(0, Math.min(MAX_GRACE_DAYS, next))
                : DEFAULTS.grace_period_days,
            );
          }}
          aria-label={label}
          className="w-20 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-right font-mono text-sm text-text focus:border-white/25 focus:outline-none disabled:opacity-50"
        />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          days
        </span>
      </label>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="max-w-prose">
        <div className="text-sm text-text">{label}</div>
        <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-text/40 ${
          checked
            ? "border-[var(--color-green)]/50 bg-[var(--color-green)]/25"
            : "border-white/15 bg-white/[0.04]"
        }`}
      >
        <span
          className={`ml-0.5 h-3.5 w-3.5 rounded-full transition-transform ${
            checked
              ? "translate-x-4 bg-[var(--color-green)]"
              : "translate-x-0 bg-text-muted"
          }`}
        />
      </button>
    </div>
  );
}
