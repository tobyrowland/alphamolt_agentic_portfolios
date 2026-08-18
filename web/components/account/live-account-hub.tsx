"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LiveCashSummary, SleeveCash } from "@/lib/live-cash-query";
import type { LiveActivity } from "@/lib/live-activity-query";
import {
  applyLiveSplit,
  createFollowerShell,
  creditAllowance,
  debitAllowance,
} from "@/lib/live-cash-mutations";
import { syncLivePortfolioToAlpaca } from "@/lib/live-mirror-mutations";
import { planSplitMoves } from "@/lib/sleeve-funding";
import {
  buildHubState,
  describeLedger,
  relativeTime,
  sleeveColor,
  type HubLine,
} from "@/lib/live-activity";
import SplitBar from "@/components/account/split-bar";
import StrategyCard, {
  type StrategyMeta,
} from "@/components/account/strategy-card";
import WhatsHappening from "@/components/account/whats-happening";

/**
 * The owner's control room for real money, built around two questions:
 *
 *   1. How much should each strategy run?  → the split editor.
 *   2. Is anything happening right now?    → the "what's happening" panel.
 *
 * Question 2 used to have no answer at all. A dispatched sync left no trace, a
 * $0 strategy looked the same whether a transfer was in flight or had never
 * been attempted, and money movements were hidden behind an "Advanced" fold —
 * so the honest state of a real-money account had to be guessed. Now every
 * strategy is its own colour-keyed card, the pot is drawn as a bar, and the
 * panel says in a sentence what is (or isn't) outstanding.
 *
 * Nothing in the split editor places an order — moves re-attribute records of
 * the one shared broker account. Sync and the "copies" picker (per-card
 * Manage) DO drive real orders and keep their own confirms.
 */
export default function LiveAccountHub({
  accounts,
  paperOptions,
  liveMeta,
  activity,
}: {
  accounts: LiveCashSummary[];
  paperOptions: { id: string; name: string }[];
  /** Per live portfolio id: P&L, position count, the book it copies. */
  liveMeta?: Record<string, StrategyMeta>;
  activity?: LiveActivity;
}) {
  if (accounts.length === 0) return null;
  // Paper books that already have a live follower (across every account)
  // leave the "bring another strategy live" picker — one follower per book.
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
          liveMeta={liveMeta ?? {}}
          activity={activity}
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
  liveMeta,
  activity,
  showKey,
}: {
  account: LiveCashSummary;
  paperOptions: { id: string; name: string }[];
  unfollowedPaper: { id: string; name: string }[];
  liveMeta: Record<string, StrategyMeta>;
  activity?: LiveActivity;
  showKey: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totalWorth =
    Math.round(
      account.sleeves.reduce((s, x) => s + x.allowance + x.holdingsValue, 0) *
        100,
    ) / 100;

  // The hub's state over time. Rendered on the client so relative times track
  // the viewer's clock; `nowMs` is fixed per render pass to keep it stable.
  const sleeveIds = new Set(account.sleeves.map((s) => s.portfolioId));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hub = useMemo(
    () =>
      buildHubState({
        sleeves: account.sleeves.map((s) => ({
          portfolioId: s.portfolioId,
          displayName: s.displayName,
          allowance: s.allowance,
          holdingsValue: s.holdingsValue,
          offBookValue: s.offBookValue,
          followsPortfolioId: s.followsPortfolioId,
          everFunded: s.everFunded,
        })),
        ledger: account.ledger.map((l) => ({
          id: l.id,
          portfolioId: l.portfolioId,
          portfolioSlug: l.portfolioSlug,
          deltaUsd: l.deltaUsd,
          reason: l.reason,
          note: l.note,
          createdAt: l.createdAt,
        })),
        runs: (activity?.runs ?? []).filter(
          (r) => r.portfolioId == null || sleeveIds.has(r.portfolioId),
        ),
        fills: (activity?.fills ?? []).filter((f) =>
          sleeveIds.has(f.portfolioId),
        ),
        unallocated: account.unallocated,
        brokerCash: account.brokerCash,
        nowMs,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, activity, nowMs],
  );

  // Only tick (and only re-read the server) while something is genuinely in
  // flight, so a quiet account costs nothing. Stops after 10 minutes — beyond
  // that the scheduled run is the mechanism, not this page.
  const inFlight = hub.lines.some(
    (l) => l.tone === "working" || l.offerSync === true,
  );
  useEffect(() => {
    if (!inFlight) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - startedAt > 10 * 60_000) {
        clearInterval(timer);
        return;
      }
      setNowMs(Date.now());
      router.refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

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
      setNowMs(Date.now());
      router.refresh();
    });
  }

  // Remount the editor whenever the underlying numbers change, so targets
  // re-seed from fresh currents after every apply / refresh.
  const editorKey = account.sleeves
    .map((s) => `${s.portfolioId}:${s.allowance}:${s.holdingsValue}`)
    .join("|");

  const segments = account.sleeves.map((s, i) => ({
    id: s.portfolioId,
    label: s.displayName,
    value: Math.round((s.allowance + s.holdingsValue) * 100) / 100,
    color: sleeveColor(i),
  }));

  return (
    <div className="rounded-2xl border border-[var(--color-green,#00FF41)]/30 bg-[var(--color-green,#00FF41)]/[0.04] px-4 py-4">
      {/* The pot */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-text">
          {showKey && (
            <span className="mr-2 font-mono text-[11px] uppercase tracking-wide text-text-muted">
              {account.accountKey}
            </span>
          )}
          Your strategies run{" "}
          <span className="font-mono font-semibold">${fmt(totalWorth)}</span> of
          real money
        </p>
        <p className="text-[12px] text-text-dim">
          Broker cash{" "}
          <span className="font-mono">
            {account.brokerCash == null ? "—" : `$${fmt(account.brokerCash)}`}
          </span>
          <span className="mx-2 text-text-muted">·</span>
          Not given to a strategy{" "}
          <span className="font-mono">
            {account.unallocated == null ? "—" : `$${fmt(account.unallocated)}`}
          </span>
        </p>
      </div>

      <SplitBar segments={segments} total={totalWorth} />

      <WhatsHappening
        state={hub}
        syncing={pending}
        onSync={(portfolioId) =>
          run(
            () => syncLivePortfolioToAlpaca({ portfolioId }),
            "Sync requested — it shows above until the run reports back.",
          )
        }
      />

      {account.brokerCash == null && (
        <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
          The website can&apos;t read your broker balance (no Alpaca keys in
          this environment), so &quot;not given to a strategy&quot; is unknown
          and crediting is disabled here. This does not affect the split below —
          moving money between strategies never needs the broker.
        </p>
      )}

      {/* The split editor */}
      <SplitEditor
        key={editorKey}
        sleeves={account.sleeves}
        paperOptions={paperOptions}
        liveMeta={liveMeta}
        hubLines={hub.lines}
        disabled={pending}
        error={error}
        notice={notice}
        onApply={(targets, assumedTotal, done) =>
          run(() => applyLiveSplit({ targets, assumedTotal }), done)
        }
      />

      {/* Bring another paper strategy live, at $0, funded by the split */}
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

      {/* Rarely-needed plumbing, out of the way */}
      <details className="mt-4 border-t border-white/[0.08] pt-3">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wide text-text-muted hover:text-text">
          Advanced — spare cash &amp; full history
        </summary>
        <div className="mt-3 space-y-4">
          {account.brokerCash == null && (
            <p className="text-[11px] leading-relaxed text-text-muted">
              For credits use{" "}
              <code className="font-mono">live_cash.py --credit</code>.
            </p>
          )}
          {account.sleeves.map((s) => (
            <div key={s.portfolioId}>
              <p className="mb-1.5 text-[12px] text-text-dim">
                {s.displayName} — cash ${fmt(s.allowance)}
              </p>
              <div className="flex flex-col gap-2">
                <AmountAction
                  label="Credit"
                  hint="spare account cash → this strategy"
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
                  hint="this strategy → spare account cash"
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
              <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-text-muted">
                Every money movement
              </p>
              <ul className="flex flex-col gap-1">
                {account.ledger.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-baseline justify-between gap-3 text-[12px] text-text-dim"
                  >
                    <span>
                      <span
                        className={
                          l.deltaUsd >= 0
                            ? "font-mono text-[var(--color-green,#00FF41)]"
                            : "font-mono text-text"
                        }
                      >
                        {l.deltaUsd >= 0 ? "+" : "−"}$
                        {fmt(Math.abs(l.deltaUsd))}
                      </span>{" "}
                      {l.portfolioSlug} · {describeLedger(l.reason)}
                    </span>
                    <span className="whitespace-nowrap font-mono text-[11px] text-text-muted">
                      {relativeTime(l.createdAt, new Date(nowMs))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>

      <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
        Changing the split re-attributes the shared broker account&apos;s
        records — it never places an order by itself. When a strategy&apos;s
        share can&apos;t be covered by cash, positions move with it and are
        traded into its own picks on its next sync.
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
  liveMeta,
  hubLines,
  disabled,
  error,
  notice,
  onApply,
}: {
  sleeves: SleeveCash[];
  paperOptions: { id: string; name: string }[];
  liveMeta: Record<string, StrategyMeta>;
  hubLines: HubLine[];
  disabled: boolean;
  error: string | null;
  notice: string | null;
  onApply: (
    targets: { portfolioId: string; target: number }[],
    assumedTotal: number,
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
  // The card the owner last typed into — where the apply controls belong.
  const [editedIndex, setEditedIndex] = useState<number | null>(null);

  function setTarget(i: number, raw: string) {
    setConfirming(false);
    setEditedIndex(i);
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
  // Which cards no longer show what the strategy actually runs. With two
  // strategies, typing one target auto-fills the other, so both go pending —
  // but only the card the owner typed into carries the apply controls.
  const changed = currents.map(
    (c, i) => parsed[i] == null || Math.abs((parsed[i] as number) - c.current) > 1,
  );
  const edited = changed.some(Boolean);
  const applyIndex =
    editedIndex != null && changed[editedIndex]
      ? editedIndex
      : changed.findIndex(Boolean);

  // Only lines with a compact form belong on a card — account-wide ones (a
  // run's outcome, over-commitment) stay in the panel where they apply.
  const lineFor = (portfolioId: string) =>
    hubLines.find((l) => l.portfolioId === portfolioId && l.short) ?? null;

  /**
   * The commitment, rendered inside the card that was just edited. It used to
   * live below every card, which on a tall card meant the owner typed a number
   * and had nothing on screen telling them it wasn't live yet — or offering to
   * make it live.
   */
  const applyBlock = (
    <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.05] px-3 py-2">
      {!confirming && (
        <>
          <p className="text-[12px] leading-relaxed text-amber-200">
            <span className="font-semibold">Not applied yet.</span>{" "}
            {balanced && dirty
              ? preview
                  .map(
                    (m) =>
                      `Applying moves $${fmt(m.amount)} from ${m.fromName} to ${m.toName}.`,
                  )
                  .join(" ")
              : unassigned != null && unassigned > 0
                ? `$${fmt(unassigned)} of the account isn't assigned to a strategy — the targets have to add up to $${fmt(total)}.`
                : unassigned != null
                  ? `The targets are $${fmt(Math.abs(unassigned))} over — they have to add up to $${fmt(total)}.`
                  : "Enter an amount for every strategy."}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={disabled || !dirty || !balanced}
              className="inline-flex items-center rounded-lg bg-[var(--color-green,#00FF41)] px-3.5 py-1.5 text-[13px] font-bold text-black transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {disabled ? "Applying…" : "Apply split"}
            </button>
            <button
              type="button"
              onClick={() => {
                setTargets(currents.map((c) => c.current.toFixed(2)));
                setEditedIndex(null);
                setConfirming(false);
              }}
              disabled={disabled}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </>
      )}

      {/* One plain-words confirm for the whole split, in place. */}
      {confirming && dirty && (
        <div>
          <p className="text-sm leading-relaxed text-text">Apply this split?</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {preview.map((m, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-text">
                <span className="font-bold">${fmt(m.amount)}</span>: {m.fromName}{" "}
                → {m.toName}
                {m.sharePart > 0 && (
                  <span className="text-amber-300">
                    {" "}
                    (${fmt(m.cashPart)} cash + ≈${fmt(m.sharePart)} as positions
                    — {m.toName} trades them into its own picks on its next sync)
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
                  total,
                  "Split applied — the numbers above are live. Any moved positions restructure on the next sync.",
                );
                setConfirming(false);
              }}
              disabled={disabled}
              className="rounded border border-[var(--color-red,#FF3333)]/50 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-red,#FF3333)] transition-colors hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40"
            >
              {disabled ? "Applying…" : "Yes — apply"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={disabled}
              className="rounded border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-text-muted transition-colors hover:text-text disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Outcomes report where the action was taken. */}
      <p aria-live="polite" className="empty:hidden">
        {error && (
          <span
            role="alert"
            className="mt-2 block font-mono text-xs leading-relaxed text-[var(--color-red,#FF3333)]"
          >
            {error}
          </span>
        )}
        {notice && !error && (
          <span className="mt-2 block text-xs leading-relaxed text-[var(--color-green,#00FF41)]">
            {notice}
          </span>
        )}
      </p>
    </div>
  );

  return (
    <div className="mt-4">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
        How much should each strategy run?
      </p>
      <div className="flex flex-col gap-2.5">
        {currents.map((c, i) => (
          <StrategyCard
            key={c.portfolioId}
            sleeve={c}
            color={sleeveColor(i)}
            current={c.current}
            sharePct={total > 0 ? (c.current / total) * 100 : 0}
            meta={liveMeta[c.portfolioId]}
            target={targets[i]}
            invalid={parsed[i] == null}
            disabled={disabled}
            paperOptions={paperOptions}
            statusLine={lineFor(c.portfolioId)}
            pending={changed[i]}
            applySlot={edited && i === applyIndex ? applyBlock : undefined}
            onTarget={(raw) => setTarget(i, raw)}
          />
        ))}
      </div>

      {/* Nothing pending: say how to start, with no orphaned button. */}
      {!edited && (
        <p className="mt-3 text-[12px] text-text-muted">
          Change a target to move money between strategies — you&apos;ll get an
          apply button right there.
        </p>
      )}

      {/* The last outcome survives the block disappearing after a success. */}
      {!edited && notice && !error && (
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-green,#00FF41)]">
          {notice}
        </p>
      )}
    </div>
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
        className="rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:border-[var(--color-green,#00FF41)]/50 focus:outline-none disabled:opacity-50"
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
        className="inline-flex items-center rounded-lg border border-[var(--color-green,#00FF41)]/40 px-3 py-1.5 text-[13px] font-medium text-[var(--color-green,#00FF41)] transition-colors hover:bg-[var(--color-green,#00FF41)]/10 disabled:cursor-not-allowed disabled:opacity-50"
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
        className="w-28 rounded-lg border border-white/[0.12] bg-transparent px-2.5 py-1.5 font-mono text-sm text-text placeholder:text-text-muted focus:border-[var(--color-green,#00FF41)]/50 focus:outline-none disabled:opacity-50"
        aria-label={`${label} amount`}
      />
      <button
        type="submit"
        disabled={disabled || !valid}
        className="inline-flex items-center rounded-lg border border-white/[0.12] px-3 py-1.5 text-[13px] font-medium text-text-dim transition-colors hover:border-white/20 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
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
