"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { brokerCashNote, brokerCashTag } from "@/lib/live-cash-status";
import { useRouter } from "next/navigation";
import type { LiveCashSummary } from "@/lib/live-cash-query";
import type { LiveActivity } from "@/lib/live-activity-query";
import {
  createFollowerShell,
  creditAllowance,
  debitAllowance,
  transferAllowance,
} from "@/lib/live-cash-mutations";
import { syncLivePortfolioToAlpaca } from "@/lib/live-mirror-mutations";
import {
} from "@/lib/sleeve-funding";
import {
  buildHubState,
  describeLedger,
  relativeTime,
  sleeveColor,
} from "@/lib/live-activity";
import SplitBar from "@/components/account/split-bar";
import StrategyRow, {
  RowHeader,
  type StrategyMeta,
} from "@/components/account/strategy-row";
import MoveMoney from "@/components/account/move-money";
import {
  UNASSIGNED_ID,
  type Bucket,
  accountHeadline,
  routeMove,
} from "@/lib/money-move";
import ExecutionTimeline from "@/components/account/execution-timeline";

/**
 * The owner's control desk for real money, built around two questions:
 *
 *   1. How much should each strategy run?  → the allocation, in percentages.
 *   2. What's happening, and when?         → the execution timeline.
 *
 * The layout answers them in that order and then gets out of the way: pot,
 * proportion bar, timeline, one row per strategy, and — only while an edit is
 * live — a sticky bar carrying the single commitment.
 *
 * Two things this replaces are worth remembering. Targets used to be typed in
 * DOLLARS that had to sum to the pot, so most of the interface was spent
 * policing arithmetic the owner shouldn't have had to do; they are proportions
 * now, and the allocation is held at 100% by construction. And status used to
 * be said three times — panel, card, footnote — which flattened the hierarchy
 * until nothing looked more important than anything else.
 *
 * Nothing in the allocation places an order: moves re-attribute records inside
 * the one shared broker account. Sync and the mirror picker (per-row drawer) DO
 * place real orders and keep their own two-step confirms.
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
  // Paper books that already have a live follower (across every account) leave
  // the "bring another strategy live" picker — one follower per book.
  const followedPaperIds = new Set(
    accounts.flatMap((a) =>
      a.sleeves
        .map((s) => s.followsPortfolioId)
        .filter((id): id is string => id != null),
    ),
  );
  const unfollowedPaper = paperOptions.filter((p) => !followedPaperIds.has(p.id));
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

  const sleeves = account.sleeves;
  const currents = useMemo(
    () => sleeves.map((s) => round2(s.allowance + s.holdingsValue)),
    [sleeves],
  );
  const total = round2(currents.reduce((s, c) => s + c, 0));

  // ---- The buckets ---------------------------------------------------------
  // One decomposition of the account, by who owns the money. "Not assigned" is
  // a bucket like any strategy, which is what lets a single "move money" verb
  // replace the old credit / debit / re-split trio.
  const buckets: Bucket[] = useMemo(() => {
    const rows: Bucket[] = sleeves.map((s, i) => ({
      id: s.portfolioId,
      name: s.displayName,
      value: currents[i],
      cash: s.allowance,
    }));
    if (account.unallocated != null) {
      rows.push({
        id: UNASSIGNED_ID,
        name: "Not assigned",
        value: round2(account.unallocated),
        cash: round2(account.unallocated),
      });
    }
    return rows;
  }, [sleeves, currents, account.unallocated]);

  const headline = accountHeadline(total, account.unallocated);
  const accountTotal = headline.amount;

  // ---- What's happening ----------------------------------------------------
  const sleeveIds = new Set(sleeves.map((s) => s.portfolioId));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hub = useMemo(
    () =>
      buildHubState({
        sleeves: sleeves.map((s) => ({
          portfolioId: s.portfolioId,
          displayName: s.displayName,
          allowance: s.allowance,
          holdingsValue: s.holdingsValue,
          offBookValue: s.offBookValue,
          followsPortfolioId: s.followsPortfolioId,
          everFunded: s.everFunded,
          startingCash: s.startingCash,
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
        fills: (activity?.fills ?? []).filter((f) => sleeveIds.has(f.portfolioId)),
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
  const inFlight = hub.lines.some((l) => l.tone === "working" || l.offerSync === true);
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
    after?: () => void,
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
      after?.();
      router.refresh();
    });
  }

  // Only lines about ONE strategy reduce to a health dot on its row; the
  // account-wide ones (a run's outcome, over-commitment) stay in the timeline.
  const lineFor = (portfolioId: string) =>
    hub.lines.find((l) => l.portfolioId === portfolioId && l.short) ?? null;

  // The bar draws what the account IS — every bucket, unassigned included, so
  // it reconciles with the list beneath it. There is no target to preview: a
  // move is stated explicitly and previewed in the move box itself.
  const segments = [
    ...sleeves.map((s, i) => ({
      id: s.portfolioId,
      label: s.displayName,
      value: currents[i],
      target: currents[i],
      color: sleeveColor(i),
    })),
    ...(account.unallocated != null
      ? [{
          id: UNASSIGNED_ID,
          label: "Not assigned",
          value: round2(account.unallocated),
          target: round2(account.unallocated),
          color: "var(--color-border-light, #333333)",
        }]
      : []),
  ];

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-4">
      {/* The pot */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-text">
          {showKey && (
            <span className="mr-2 font-mono text-[11px] uppercase tracking-wide text-text-muted">
              {account.accountKey}
            </span>
          )}
          <span className="font-mono font-semibold tabular-nums">
            ${fmt(accountTotal)}
          </span>{" "}
          {headline.caption}
        </p>
        <p className="font-mono text-[11.5px] tabular-nums text-text-muted">
          {/* The reason the balance is missing belongs beside the missing
              number. Everything else that used to sit on this line was a
              SECOND decomposition of the same money (cash vs stock) shown
              beside the first (whose money) as though they were peers — the
              single thing that stopped the screen adding up. */}
          {brokerCashTag(account.brokerCashStatus) && (
            <span
              className="rounded border border-[var(--color-orange)]/40 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-orange)]"
              title={brokerCashNote(account.brokerCashStatus) ?? undefined}
            >
              {brokerCashTag(account.brokerCashStatus)}
            </span>
          )}
        </p>
      </div>

      <SplitBar segments={segments} total={accountTotal} dirty={false} />

      <div className="mt-3">
        <MoveMoney
          buckets={buckets}
          disabled={pending}
          onMove={(fromId, toId, amount) => {
            const route = routeMove(fromId, toId);
            if (!route) return;
            const name = (id: string) =>
              buckets.find((b) => b.id === id)?.name ?? "that strategy";
            const done = `Moved $${fmt(amount)} from ${name(fromId)} to ${name(toId)}.`;
            if (route.kind === "credit") {
              run(() => creditAllowance({ portfolioId: route.portfolioId, amount }), done);
            } else if (route.kind === "debit") {
              run(() => debitAllowance({ portfolioId: route.portfolioId, amount }), done);
            } else {
              run(
                () =>
                  transferAllowance({
                    fromPortfolioId: route.fromPortfolioId,
                    toPortfolioId: route.toPortfolioId,
                    amount,
                  }),
                done,
              );
            }
          }}
        />
      </div>

      <ExecutionTimeline
        state={hub}
        syncing={pending}
        onSync={(portfolioId) =>
          run(
            () => syncLivePortfolioToAlpaca({ portfolioId }),
            "Sync requested — it shows in the timeline until the run reports back.",
          )
        }
      />

      {/* The strategies */}
      <ul className="mt-4 -mx-1 flex flex-col rounded-lg border border-white/[0.07]">
        <RowHeader />
        {sleeves.map((s, i) => (
          <StrategyRow
            key={s.portfolioId}
            sleeve={s}
            color={sleeveColor(i)}
            current={currents[i]}
            sharePct={total > 0 ? (currents[i] / total) * 100 : 0}
            meta={liveMeta[s.portfolioId]}
            statusLine={lineFor(s.portfolioId)}
            disabled={pending}
            paperOptions={paperOptions}
          />
        ))}

        {account.unallocated != null && (
          <li className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border py-3">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full bg-border-light"
            />
            <span className="flex flex-grow flex-col gap-0.5">
              <span className="text-[15px] font-semibold text-text-dim">
                Not assigned
              </span>
              <span className="font-mono text-[11.5px] text-text-muted">
                sitting as cash &middot; no strategy is trading it
              </span>
            </span>
            <span className="font-mono text-[16px] tabular-nums">
              ${fmt(account.unallocated)}
            </span>
          </li>
        )}
      </ul>

      {/* Outcomes of a move or a sync. */}
      <p aria-live="polite" className="empty:hidden">
        {error && (
          <span
            role="alert"
            className="mt-2 block font-mono text-[11.5px] leading-relaxed text-[var(--color-red,#FF3333)]"
          >
            {error}
          </span>
        )}
        {notice && !error && (
          <span className="mt-2 block text-[12px] leading-relaxed text-text-dim">
            {notice}
          </span>
        )}
      </p>

      {/* Bring another paper strategy live, at $0, funded by the allocation */}
      {unfollowedPaper.length > 0 && sleeves.length > 0 && (
        <AddStrategy
          disabled={pending}
          options={unfollowedPaper}
          onAdd={(paperId, name) =>
            run(
              () =>
                createFollowerShell({
                  paperPortfolioId: paperId,
                  accountPortfolioId: sleeves[0].portfolioId,
                }),
              `${name} (Live) added at $0 — move money into it above.`,
            )
          }
        />
      )}

      {account.ledger.length > 0 && (
        <details className="mt-3 border-t border-white/[0.08] pt-2.5">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted hover:text-text">
            Every money movement
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {account.ledger.map((l) => (
              <li
                key={l.id}
                className="flex items-baseline justify-between gap-3 text-[11.5px] text-text-dim"
              >
                <span>
                  <span className="font-mono tabular-nums text-text">
                    {l.deltaUsd >= 0 ? "+" : "−"}${fmt(Math.abs(l.deltaUsd))}
                  </span>{" "}
                  {l.portfolioSlug} · {describeLedger(l.reason)}
                </span>
                <span className="whitespace-nowrap font-mono text-[10.5px] text-text-muted">
                  {relativeTime(l.createdAt, new Date(nowMs))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
        Changing the allocation re-attributes the shared broker account&apos;s
        records — it never places an order by itself. When a strategy&apos;s
        share can&apos;t be covered by cash, positions move with it and are
        traded into its own picks on its next sync.
        {brokerCashNote(account.brokerCashStatus) && (
          <> {brokerCashNote(account.brokerCashStatus)}</>
        )}
      </p>
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
      <span className="text-[12px] text-text-dim">Bring another strategy live:</span>
      <select
        value={paperId}
        onChange={(e) => setPaperId(e.target.value)}
        disabled={disabled}
        className="rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:border-white/35 focus:outline-none disabled:opacity-50"
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
        className="rounded-lg border border-white/[0.15] px-3 py-1.5 text-[13px] font-medium text-text-dim transition-colors hover:border-white/30 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        Add
      </button>
      <span className="text-[11px] text-text-muted">
        appears at $0 — give it a share of the account
      </span>
    </div>
  );
}

/** 70 → "70", 61.75 → "61.75" — no trailing zeros in a field being typed into. */
function formatPct(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
