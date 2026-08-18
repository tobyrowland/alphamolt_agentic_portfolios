"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LiveCashSummary, SleeveCash } from "@/lib/live-cash-query";
import {
  applyLiveSplit,
  createFollowerShell,
  creditAllowance,
  debitAllowance,
} from "@/lib/live-cash-mutations";
import { planSplitMoves } from "@/lib/sleeve-funding";
import FollowTargetPicker from "@/components/portfolio/follow-target-picker";
import SyncLiveButton from "@/components/portfolio/sync-live-button";

/**
 * The owner's control hub for live (real-money) portfolios, built around ONE
 * question: how much money should each strategy run? Each strategy row shows
 * its current worth and takes a target; a single "Apply split" works out the
 * direction and the cash-vs-shares mechanics (in-kind moves — migration 084)
 * and executes after one plain-words confirmation. "+ Add strategy" brings a
 * new paper book live as a $0 row, funded the same way.
 *
 * Nothing in the split editor places an order — moves re-attribute records of
 * the one shared broker account. Sync and the mirrors picker (per-row
 * "Manage" fold-out) DO drive real orders and keep their own confirms.
 */
export default function LiveAccountHub({
  accounts,
  paperOptions,
}: {
  accounts: LiveCashSummary[];
  paperOptions: { id: string; name: string }[];
}) {
  if (accounts.length === 0) return null;
  // Paper books that already have a live follower (across every account)
  // leave the "+ Add strategy" picker — one follower per paper book.
  const followedPaperIds = new Set(
    accounts.flatMap((a) =>
      a.sleeves
        .map((s) => s.followsPortfolioId)
        .filter((id): id is string => id != null),
    ),
  );
  const unfollowedPaper = paperOptions.filter(
    (p) => !followedPaperIds.has(p.id),
  );
  return (
    <div className="space-y-6">
      {accounts.map((a) => (
        <AccountPanel
          key={a.accountKey}
          account={a}
          paperOptions={paperOptions}
          unfollowedPaper={unfollowedPaper}
          showKey={accounts.length > 1}
        />
      ))}
    </div>
  );
}

function AccountPanel({
  account,
  paperOptions,
  unfollowedPaper,
  showKey,
}: {
  account: LiveCashSummary;
  paperOptions: { id: string; name: string }[];
  unfollowedPaper: { id: string; name: string }[];
  showKey: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totalWorth = account.sleeves.reduce(
    (s, x) => s + x.allowance + x.holdingsValue,
    0,
  );
  const overCommitted =
    account.unallocated != null && account.unallocated < -0.01;

  function run(
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    done: string,
  ) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(done);
      router.refresh();
    });
  }

  // Remount the editor whenever the underlying numbers change, so targets
  // re-seed from fresh currents after every apply / refresh.
  const editorKey = account.sleeves
    .map((s) => `${s.portfolioId}:${s.allowance}:${s.holdingsValue}`)
    .join("|");

  return (
    <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.04] px-4 py-4">
      {/* Headline: the pot */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-text">
          {showKey && (
            <span className="mr-2 text-[11px] font-mono uppercase tracking-wide text-text-muted">
              {account.accountKey}
            </span>
          )}
          Your strategies run{" "}
          <span className="font-mono font-semibold">${fmt(totalWorth)}</span>
        </p>
        <p className="text-[12px] text-text-dim">
          Broker cash{" "}
          <span className="font-mono">
            {account.brokerCash == null ? "—" : `$${fmt(account.brokerCash)}`}
          </span>
          <span className="mx-2 text-text-muted">·</span>
          Unallocated{" "}
          <span
            className={`font-mono ${overCommitted ? "text-[var(--color-red)]" : ""}`}
          >
            {account.unallocated == null ? "—" : `$${fmt(account.unallocated)}`}
          </span>
        </p>
      </div>
      {overCommitted && (
        <p className="mt-2 text-xs text-[var(--color-red)] leading-relaxed">
          Your strategies are promised more than the broker account holds —
          lower a target before an order bounces.
        </p>
      )}

      {/* The split editor */}
      <SplitEditor
        key={editorKey}
        sleeves={account.sleeves}
        paperOptions={paperOptions}
        disabled={pending}
        onApply={(targets, done) => run(() => applyLiveSplit({ targets }), done)}
      />

      {/* Add a strategy: new follower at $0, funded via the split above */}
      {unfollowedPaper.length > 0 && account.sleeves.length > 0 && (
        <AddStrategy
          disabled={pending}
          options={unfollowedPaper}
          onAdd={(paperId, name) =>
            run(
              () =>
                createFollowerShell({
                  paperPortfolioId: paperId,
                  accountPortfolioId: account.sleeves[0].portfolioId,
                }),
              `${name} (Live) added at $0 — set its target above and Apply split to fund it.`,
            )
          }
        />
      )}

      {error && (
        <p className="mt-3 text-xs text-[var(--color-red)] font-mono leading-relaxed">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mt-3 text-xs text-[var(--color-green)] leading-relaxed">
          {notice}
        </p>
      )}

      {/* Rarely-needed plumbing, out of the way */}
      <details className="mt-4 pt-3 border-t border-white/[0.08]">
        <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wide text-text-muted hover:text-text">
          Advanced — broker cash &amp; history
        </summary>
        <div className="mt-3 space-y-4">
          {account.brokerCash == null && (
            <p className="text-[11px] text-text-muted leading-relaxed">
              Broker cash isn&apos;t readable from the website (no Alpaca keys
              in the web environment), so unallocated is unknown and crediting
              is disabled here. For credits use{" "}
              <code className="font-mono">live_cash.py --credit</code>.
            </p>
          )}
          {account.sleeves.map((s) => (
            <div key={s.portfolioId}>
              <p className="text-[12px] text-text-dim mb-1.5">
                {s.displayName} — cash ${fmt(s.allowance)}
              </p>
              <div className="flex flex-col gap-2">
                <AmountAction
                  label="Credit"
                  hint="unallocated → this portfolio"
                  disabled={pending || account.unallocated == null}
                  onSubmit={(amount) =>
                    run(
                      () =>
                        creditAllowance({ portfolioId: s.portfolioId, amount }),
                      `Credited $${fmt(amount)} to ${s.displayName}.`,
                    )
                  }
                />
                <AmountAction
                  label="Debit"
                  hint="this portfolio → unallocated"
                  disabled={pending}
                  onSubmit={(amount) =>
                    run(
                      () =>
                        debitAllowance({ portfolioId: s.portfolioId, amount }),
                      `Debited $${fmt(amount)} from ${s.displayName}.`,
                    )
                  }
                />
              </div>
            </div>
          ))}
          {account.ledger.length > 0 && (
            <div>
              <p className="text-[11px] font-mono uppercase tracking-wide text-text-muted mb-1.5">
                History
              </p>
              <ul className="flex flex-col gap-1">
                {account.ledger.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-baseline justify-between text-[12px] text-text-dim"
                  >
                    <span>
                      <span
                        className={
                          l.deltaUsd >= 0
                            ? "text-[var(--color-green)] font-mono"
                            : "text-text font-mono"
                        }
                      >
                        {l.deltaUsd >= 0 ? "+" : "−"}${fmt(Math.abs(l.deltaUsd))}
                      </span>{" "}
                      {l.reason} · {l.portfolioSlug}
                    </span>
                    <span className="text-text-muted font-mono text-[11px]">
                      {new Date(l.createdAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>

      <p className="mt-3 text-[11px] text-text-muted leading-relaxed">
        Changing the split re-attributes the shared broker account&apos;s
        records — it never places an order by itself. When a strategy&apos;s
        share can&apos;t be covered by cash, positions move with it and are
        traded into its own picks on its next sync. Sync and the mirror target
        (under Manage) DO place real orders and ask you to confirm.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The split editor
// ---------------------------------------------------------------------------

function SplitEditor({
  sleeves,
  paperOptions,
  disabled,
  onApply,
}: {
  sleeves: SleeveCash[];
  paperOptions: { id: string; name: string }[];
  disabled: boolean;
  onApply: (
    targets: { portfolioId: string; target: number }[],
    doneMessage: string,
  ) => void;
}) {
  const currents = useMemo(
    () =>
      sleeves.map((s) => ({
        ...s,
        current: Math.round((s.allowance + s.holdingsValue) * 100) / 100,
      })),
    [sleeves],
  );
  const total =
    Math.round(currents.reduce((s, c) => s + c.current, 0) * 100) / 100;

  const [targets, setTargets] = useState<string[]>(
    currents.map((c) => c.current.toFixed(2)),
  );
  const [confirming, setConfirming] = useState(false);

  function setTarget(i: number, raw: string) {
    setConfirming(false);
    const next = [...targets];
    next[i] = raw;
    // With exactly two strategies the other side is implied — fill it in so
    // the split always balances without mental arithmetic.
    if (currents.length === 2) {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0 && v <= total) {
        next[i === 0 ? 1 : 0] = (total - v).toFixed(2);
      }
    }
    setTargets(next);
  }

  const parsed = targets.map((t) => {
    const v = Number(t);
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  });
  const allValid = parsed.every((v) => v != null);
  const targetSum = allValid
    ? Math.round((parsed as number[]).reduce((s, v) => s + v, 0) * 100) / 100
    : null;
  const unassigned =
    targetSum == null ? null : Math.round((total - targetSum) * 100) / 100;
  const balanced =
    unassigned != null && Math.abs(unassigned) <= Math.max(1, total * 0.001);

  const moves = useMemo(() => {
    if (!allValid || !balanced) return [];
    return planSplitMoves(
      currents.map((c, i) => ({
        portfolioId: c.portfolioId,
        current: c.current,
        target: (parsed as number[])[i],
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allValid, balanced, currents, targets.join("|")]);

  // Plain-words preview per move: how much travels as cash vs as positions,
  // tracked against each source's remaining spare cash.
  const preview = useMemo(() => {
    const spare = new Map(currents.map((c) => [c.portfolioId, c.allowance]));
    const name = new Map(currents.map((c) => [c.portfolioId, c.displayName]));
    return moves.map((m) => {
      const cashAvail = spare.get(m.fromPortfolioId) ?? 0;
      const cashPart = Math.min(cashAvail, m.amount);
      spare.set(
        m.fromPortfolioId,
        Math.round((cashAvail - cashPart) * 100) / 100,
      );
      const sharePart = Math.round((m.amount - cashPart) * 100) / 100;
      return {
        ...m,
        fromName: name.get(m.fromPortfolioId) ?? "?",
        toName: name.get(m.toPortfolioId) ?? "?",
        cashPart: Math.round(cashPart * 100) / 100,
        sharePart,
      };
    });
  }, [moves, currents]);

  const dirty = moves.length > 0;

  return (
    <div className="mt-4">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
            <th className="text-left font-medium pb-1.5">Strategy</th>
            <th className="text-right font-medium pb-1.5">Now</th>
            <th className="text-right font-medium pb-1.5 pr-1">Target</th>
          </tr>
        </thead>
        <tbody>
          {currents.map((c, i) => (
            <SleeveRow
              key={c.portfolioId}
              sleeve={c}
              current={c.current}
              target={targets[i]}
              invalid={parsed[i] == null}
              disabled={disabled}
              paperOptions={paperOptions}
              onTarget={(raw) => setTarget(i, raw)}
            />
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled || !dirty || !balanced || confirming}
          className="inline-flex items-center rounded-lg bg-[var(--color-green)] px-4 py-2 text-sm font-bold text-black hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-[filter]"
        >
          Apply split
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setTargets(currents.map((c) => c.current.toFixed(2)));
              setConfirming(false);
            }}
            disabled={disabled}
            className="text-[12px] text-text-muted hover:text-text transition-colors"
          >
            Reset
          </button>
        )}
        {unassigned != null && !balanced && (
          <span className="text-xs text-[var(--color-red)]">
            {unassigned > 0
              ? `$${fmt(unassigned)} unassigned — targets must add up to $${fmt(total)}.`
              : `$${fmt(Math.abs(unassigned))} over — targets must add up to $${fmt(total)}.`}
          </span>
        )}
        {!dirty && balanced && (
          <span className="text-[12px] text-text-muted">
            Change a target to move money between strategies.
          </span>
        )}
      </div>

      {/* One plain-words confirm for the whole split. */}
      {confirming && dirty && (
        <div className="mt-3 rounded-xl border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3.5 py-3">
          <p className="text-sm text-text leading-relaxed">Apply this split?</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {preview.map((m, i) => (
              <li key={i} className="text-[13px] text-text leading-relaxed">
                <span className="font-bold">${fmt(m.amount)}</span>:{" "}
                {m.fromName} → {m.toName}
                {m.sharePart > 0 && (
                  <span className="text-amber-300">
                    {" "}
                    (${fmt(m.cashPart)} cash + ≈${fmt(m.sharePart)} as
                    positions — {m.toName} trades them into its own picks on
                    its next sync)
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onApply(
                  currents.map((c, i) => ({
                    portfolioId: c.portfolioId,
                    target: (parsed as number[])[i],
                  })),
                  "Split applied — the numbers above are live. Any moved positions restructure on the next sync (US market hours).",
                );
                setConfirming(false);
              }}
              disabled={disabled}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-red,#FF3333)]/50 text-[var(--color-red,#FF3333)] hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40 transition-colors"
            >
              {disabled ? "Applying…" : "Yes — apply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={disabled}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-white/15 text-text-muted hover:text-text disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SleeveRow({
  sleeve,
  current,
  target,
  invalid,
  disabled,
  paperOptions,
  onTarget,
}: {
  sleeve: SleeveCash;
  current: number;
  target: string;
  invalid: boolean;
  disabled: boolean;
  paperOptions: { id: string; name: string }[];
  onTarget: (raw: string) => void;
}) {
  const targetNum = Number(target);
  const drift =
    Number.isFinite(targetNum) && Math.abs(targetNum - current) > 1
      ? Math.round((targetNum - current) * 100) / 100
      : 0;
  return (
    <>
      <tr className="border-t border-white/[0.06] align-baseline">
        <td className="py-2 pr-2">
          <Link
            href={`/portfolios/${sleeve.slug}`}
            className="text-sm font-semibold text-text hover:text-[var(--color-green)] transition-colors"
          >
            {sleeve.displayName}
          </Link>
        </td>
        <td className="py-2 text-right font-mono text-text-dim whitespace-nowrap">
          ${fmt(current)}
        </td>
        <td className="py-2 pl-3 text-right whitespace-nowrap">
          <span className="inline-flex items-baseline gap-1.5">
            {drift !== 0 && (
              <span
                className={`text-[11px] font-mono ${drift > 0 ? "text-[var(--color-green)]" : "text-text-muted"}`}
              >
                {drift > 0 ? "+" : "−"}${fmt(Math.abs(drift))}
              </span>
            )}
            <span className="font-mono text-text">$</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={target}
              onChange={(e) => onTarget(e.target.value)}
              disabled={disabled}
              className={`w-28 rounded-lg border bg-transparent px-2 py-1 text-right text-sm font-mono text-text focus:outline-none disabled:opacity-50 ${
                invalid
                  ? "border-[var(--color-red)]/60"
                  : "border-white/[0.12] focus:border-[var(--color-green)]/50"
              }`}
              aria-label={`Target for ${sleeve.displayName}`}
            />
          </span>
        </td>
      </tr>
      <tr>
        <td colSpan={3} className="pb-2">
          {sleeve.offBookValue > 1 && (
            <p className="mb-1.5 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-3 py-1.5 text-xs text-amber-300 leading-relaxed">
              ${fmt(sleeve.offBookValue)} of this strategy&apos;s holdings are
              outside its own book
              {sleeve.followsPortfolioId == null
                ? " — and it isn't linked to a paper book, so nothing will restructure it. Set the mirror target under Manage."
                : " — they are traded into its own picks on the next sync (or Sync now under Manage)."}
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-wide text-text-muted hover:text-text">
              Manage
            </summary>
            <div className="mt-1.5 rounded-lg border border-white/[0.08] px-3 py-2">
              {/* Real-order controls: converge onto the paper book now, and
                  which paper book this strategy mirrors. Both keep their own
                  two-step confirms. */}
              <SyncLiveButton portfolioId={sleeve.portfolioId} />
              {paperOptions.length > 0 && (
                <FollowTargetPicker
                  portfolioId={sleeve.portfolioId}
                  currentId={sleeve.followsPortfolioId}
                  options={paperOptions}
                />
              )}
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

function AddStrategy({
  disabled,
  options,
  onAdd,
}: {
  disabled: boolean;
  options: { id: string; name: string }[];
  onAdd: (paperId: string, name: string) => void;
}) {
  const [paperId, setPaperId] = useState(options[0]?.id ?? "");
  const chosen = options.find((o) => o.id === paperId);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-text-dim">
        Bring another strategy live:
      </span>
      <select
        value={paperId}
        onChange={(e) => setPaperId(e.target.value)}
        disabled={disabled}
        className="rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
        aria-label="Paper portfolio to take live"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} className="bg-black">
            {o.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => chosen && onAdd(chosen.id, chosen.name)}
        disabled={disabled || !chosen}
        className="inline-flex items-center rounded-lg border border-[var(--color-green)]/40 px-3 py-1.5 text-[13px] font-medium text-[var(--color-green)] hover:bg-[var(--color-green)]/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Add
      </button>
      <span className="text-[11px] text-text-muted">
        appears at $0 — fund it with the split
      </span>
    </div>
  );
}

function AmountAction({
  label,
  hint,
  disabled,
  onSubmit,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onSubmit: (amount: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0;
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit(amount);
        setRaw("");
      }}
    >
      <input
        type="number"
        min="0.01"
        step="0.01"
        inputMode="decimal"
        placeholder="0.00"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={disabled}
        className="w-28 rounded-lg border border-white/[0.12] bg-transparent px-2.5 py-1.5 text-sm font-mono text-text placeholder:text-text-muted focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
        aria-label={`${label} amount`}
      />
      <button
        type="submit"
        disabled={disabled || !valid}
        className="inline-flex items-center rounded-lg border border-white/[0.12] px-3 py-1.5 text-[13px] font-medium text-text-dim hover:text-text hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {label}
      </button>
      <span className="text-[11px] text-text-muted">{hint}</span>
    </form>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
