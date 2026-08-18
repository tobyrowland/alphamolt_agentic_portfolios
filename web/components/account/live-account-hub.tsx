"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LiveCashSummary, SleeveCash } from "@/lib/live-cash-query";
import {
  createLiveFollower,
  creditAllowance,
  debitAllowance,
  transferAllowance,
} from "@/lib/live-cash-mutations";
import FollowTargetPicker from "@/components/portfolio/follow-target-picker";
import SyncLiveButton from "@/components/portfolio/sync-live-button";

/**
 * The owner's control hub for live (real-money) portfolios — every control in
 * one place on /account, outside the portfolios themselves (the live pages are
 * read-only views). Per broker account: the cash picture (broker cash,
 * unallocated, each sleeve's allowance), credit / debit / transfer, and per
 * sleeve the mirrors picker + Sync to Alpaca.
 *
 * Cash moves here are records, not orders: an allowance is the most a sleeve's
 * mirror may spend of the shared pot. Sync and the mirrors picker DO drive
 * real orders — both keep their own two-step confirms.
 */
export default function LiveAccountHub({
  accounts,
  paperOptions,
}: {
  accounts: LiveCashSummary[];
  paperOptions: { id: string; name: string }[];
}) {
  if (accounts.length === 0) return null;
  // Paper books that already have a live follower (across every account) —
  // the heartbeat pairs one follower per paper book, so these leave the
  // "Go live" picker.
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

  const totalAllowance = account.sleeves.reduce((s, x) => s + x.allowance, 0);
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

  return (
    <div className="rounded-2xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/[0.04] px-4 py-4">
      {/* Account cash picture */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {showKey && (
          <span className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
            {account.accountKey}
          </span>
        )}
        <Figure label="Broker cash" value={account.brokerCash} />
        <Figure label="Allowances" value={totalAllowance} />
        <Figure
          label="Unallocated"
          value={account.unallocated}
          tone={overCommitted ? "red" : "green"}
        />
      </div>
      {overCommitted && (
        <p className="mt-2 text-xs text-[var(--color-red)] leading-relaxed">
          Allowances promise more than the account holds — debit one before it
          places an order that bounces.
        </p>
      )}
      {account.brokerCash == null && (
        <p className="mt-2 text-[11px] text-text-muted leading-relaxed">
          Broker cash isn&apos;t readable from the website (no Alpaca keys in
          the web environment), so unallocated is unknown and crediting is
          disabled here. Debits and transfers still work; for credits use{" "}
          <code className="font-mono">live_cash.py --credit</code>.
        </p>
      )}

      {/* One block per sleeve: cash row + its own controls */}
      <div className="mt-4 space-y-4">
        {account.sleeves.map((s) => (
          <SleeveBlock
            key={s.portfolioId}
            sleeve={s}
            paperOptions={paperOptions}
            creditDisabled={pending || account.unallocated == null}
            debitDisabled={pending}
            onCredit={(amount) =>
              run(
                () => creditAllowance({ portfolioId: s.portfolioId, amount }),
                `Credited $${fmt(amount)} to ${s.displayName}.`,
              )
            }
            onDebit={(amount) =>
              run(
                () => debitAllowance({ portfolioId: s.portfolioId, amount }),
                `Debited $${fmt(amount)} from ${s.displayName}.`,
              )
            }
          />
        ))}
      </div>

      {/* Go live with another strategy: create a follower for an unfollowed
          paper book as a new sleeve of THIS account, funded from an existing
          sleeve in the same confirmed step. */}
      {unfollowedPaper.length > 0 && (
        <div className="mt-4 pt-4 border-t border-white/[0.08]">
          <p className="text-[11px] font-mono uppercase tracking-wide text-text-muted mb-2">
            Go live with another strategy
          </p>
          <GoLiveAction
            disabled={pending}
            paperOptions={unfollowedPaper}
            sleeves={account.sleeves.map((s) => ({
              id: s.portfolioId,
              name: s.displayName,
              allowance: s.allowance,
              holdingsValue: s.holdingsValue,
            }))}
            onSubmit={(paperId, fromId, amount, done) =>
              run(
                () =>
                  createLiveFollower({
                    paperPortfolioId: paperId,
                    fundFromPortfolioId: fromId,
                    amount,
                  }),
                done,
              )
            }
          />
        </div>
      )}

      {/* Between-sleeves transfer — only meaningful with 2+ */}
      {account.sleeves.length > 1 && (
        <div className="mt-4 pt-4 border-t border-white/[0.08]">
          <p className="text-[11px] font-mono uppercase tracking-wide text-text-muted mb-2">
            Move allowance between portfolios
          </p>
          <TransferAction
            disabled={pending}
            sleeves={account.sleeves.map((s) => ({
              id: s.portfolioId,
              name: s.displayName,
              allowance: s.allowance,
              holdingsValue: s.holdingsValue,
            }))}
            onSubmit={(fromId, toId, amount) =>
              run(
                () =>
                  transferAllowance({
                    fromPortfolioId: fromId,
                    toPortfolioId: toId,
                    amount,
                  }),
                `Moved $${fmt(amount)}.`,
              )
            }
          />
        </div>
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

      {/* Recent movements */}
      {account.ledger.length > 0 && (
        <div className="mt-4 pt-4 border-t border-white/[0.08]">
          <p className="text-[11px] font-mono uppercase tracking-wide text-text-muted mb-1.5">
            Recent movements
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

      <p className="mt-4 text-[11px] text-text-muted leading-relaxed">
        An allowance is the most a portfolio&apos;s mirror may spend — moving
        one never places an order. Dividends and deposits land in unallocated
        until you credit them out; sale proceeds return to the selling
        portfolio automatically. Sync and the mirrors picker DO place real
        orders and each ask you to confirm.
      </p>
    </div>
  );
}

function SleeveBlock({
  sleeve,
  paperOptions,
  creditDisabled,
  debitDisabled,
  onCredit,
  onDebit,
}: {
  sleeve: SleeveCash;
  paperOptions: { id: string; name: string }[];
  creditDisabled: boolean;
  debitDisabled: boolean;
  onCredit: (amount: number) => void;
  onDebit: (amount: number) => void;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/portfolios/${sleeve.slug}`}
          className="text-sm font-semibold text-text hover:text-[var(--color-green)] transition-colors"
        >
          {sleeve.displayName} →
        </Link>
        <div className="flex items-baseline gap-4 font-mono text-[13px]">
          <span className="text-text">
            ${fmt(sleeve.allowance)}
            <span className="ml-1 text-[10px] uppercase text-text-muted">
              cash
            </span>
          </span>
          <span className="text-text-dim">
            ${fmt(sleeve.holdingsValue)}
            <span className="ml-1 text-[10px] uppercase text-text-muted">
              held
            </span>
          </span>
          <span className="text-text">
            ${fmt(sleeve.allowance + sleeve.holdingsValue)}
            <span className="ml-1 text-[10px] uppercase text-text-muted">
              total
            </span>
          </span>
        </div>
      </div>

      {/* Guarantee 2 (in-kind funding): a sleeve holding positions outside
          its own strategy — inherited in kind, or unlinked — is flagged
          loudly until the mirror restructures it. It cannot sit unnoticed. */}
      {sleeve.offBookValue > 1 && (
        <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-300 leading-relaxed">
          Restructure pending: ${fmt(sleeve.offBookValue)} of these holdings
          are outside this portfolio&apos;s own strategy
          {sleeve.followsPortfolioId == null
            ? " — and it isn't linked to a paper book, so nothing will restructure it. Set MIRRORS below."
            : " (inherited when it was funded). They are sold on the next sync — the daily mirror run, or Sync to Alpaca below right now."}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <AmountAction
          label="Credit"
          hint="unallocated → this portfolio"
          disabled={creditDisabled}
          onSubmit={onCredit}
        />
        <AmountAction
          label="Debit"
          hint="this portfolio → unallocated"
          disabled={debitDisabled}
          onSubmit={onDebit}
        />
      </div>

      {/* Which paper book this follower mirrors (real-money re-point; the
          picker carries its own confirm step). */}
      {paperOptions.length > 0 && (
        <FollowTargetPicker
          portfolioId={sleeve.portfolioId}
          currentId={sleeve.followsPortfolioId}
          options={paperOptions}
        />
      )}

      {/* Manual converge-now (real orders; two-step confirm inside). */}
      <SyncLiveButton portfolioId={sleeve.portfolioId} />
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: "green" | "red";
}) {
  const color =
    tone === "red"
      ? "text-[var(--color-red)]"
      : tone === "green"
        ? "text-[var(--color-green)]"
        : "text-text";
  return (
    <span className="text-[13px] text-text-dim">
      {label}{" "}
      <span className={`font-mono font-semibold ${color}`}>
        {value == null ? "—" : `$${fmt(value)}`}
      </span>
    </span>
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

function GoLiveAction({
  disabled,
  paperOptions,
  sleeves,
  onSubmit,
}: {
  disabled: boolean;
  paperOptions: { id: string; name: string }[];
  sleeves: { id: string; name: string; allowance: number; holdingsValue: number }[];
  onSubmit: (
    paperId: string,
    fromId: string,
    amount: number,
    doneMessage: string,
  ) => void;
}) {
  const [paperId, setPaperId] = useState(paperOptions[0]?.id ?? "");
  const [fromId, setFromId] = useState(sleeves[0]?.id ?? "");
  const [raw, setRaw] = useState("");
  const [confirming, setConfirming] = useState(false);

  const amount = Number(raw);
  const paper = paperOptions.find((p) => p.id === paperId);
  const from = sleeves.find((s) => s.id === fromId);
  const valid =
    Number.isFinite(amount) && amount > 0 && paper != null && from != null;
  // Beyond spare cash the difference moves IN KIND (a proportional slice of
  // the source's positions, records only). Only a request beyond the source's
  // whole worth is refused.
  const worth = from ? from.allowance + from.holdingsValue : 0;
  const inKindShare =
    valid && from != null && amount > from.allowance + 0.01
      ? Math.round((amount - from.allowance) * 100) / 100
      : 0;
  const tooBig = valid && from != null && amount > worth + 0.01;

  const selectCls =
    "rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50";

  function submit() {
    if (!valid || !paper || !from) return;
    onSubmit(
      paperId,
      fromId,
      amount,
      inKindShare > 0
        ? `${paper.name} (Live) created — $${fmt(amount)} moved from ${from.name} ` +
            `($${fmt(Math.min(from.allowance, amount))} cash + ≈$${fmt(inKindShare)} of holdings in kind). ` +
            "A sync was requested to restructure the inherited positions; " +
            "orders fill during US market hours."
        : `${paper.name} (Live) created — $${fmt(amount)} moved from ${from.name}. ` +
            "Its mirror buys the paper book's shape on the next sync.",
    );
    setConfirming(false);
    setRaw("");
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={paperId}
          onChange={(e) => {
            setPaperId(e.target.value);
            setConfirming(false);
          }}
          disabled={disabled}
          className={selectCls}
          aria-label="Paper portfolio to take live"
        >
          {paperOptions.map((p) => (
            <option key={p.id} value={p.id} className="bg-black">
              {p.name}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-text-muted">funded with</span>
        <input
          type="number"
          min="0.01"
          step="0.01"
          inputMode="decimal"
          placeholder="0.00"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setConfirming(false);
          }}
          disabled={disabled}
          className="w-28 rounded-lg border border-white/[0.12] bg-transparent px-2.5 py-1.5 text-sm font-mono text-text placeholder:text-text-muted focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
          aria-label="Initial allowance"
        />
        {sleeves.length > 1 ? (
          <>
            <span className="text-[11px] text-text-muted">from</span>
            <select
              value={fromId}
              onChange={(e) => {
                setFromId(e.target.value);
                setConfirming(false);
              }}
              disabled={disabled}
              className={selectCls}
              aria-label="Funding source"
            >
              {sleeves.map((s) => (
                <option key={s.id} value={s.id} className="bg-black">
                  {s.name} (${fmt(s.allowance)})
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-[11px] text-text-muted">
            from {from?.name} (${from ? fmt(from.allowance) : "0.00"} spendable)
          </span>
        )}
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={disabled || !valid || tooBig}
            className="inline-flex items-center rounded-lg border border-[var(--color-green)]/40 px-3 py-1.5 text-[13px] font-medium text-[var(--color-green)] hover:bg-[var(--color-green)]/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Go live
          </button>
        )}
      </div>

      {tooBig && from && (
        <p className="mt-2 text-xs text-[var(--color-red)] leading-relaxed">
          {from.name} is only worth ${fmt(worth)} in total.
        </p>
      )}
      {!tooBig && inKindShare > 0 && !confirming && (
        <p className="mt-2 text-xs text-amber-300 leading-relaxed">
          Beyond {from?.name}&apos;s ${fmt(from?.allowance ?? 0)} spare cash —
          the remaining ≈${fmt(inKindShare)} moves as a proportional slice of
          its holdings (records only; nothing trades at move time).
        </p>
      )}

      {/* Real-money confirm: creating the follower arms its mirror — on the
          next sync it buys the paper book's shape with the funded allowance. */}
      {confirming && valid && paper && from && (
        <div className="mt-3 rounded-xl border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3.5 py-3">
          <p className="text-sm text-text leading-relaxed">
            Create <span className="font-bold">{paper.name} (Live)</span> and
            move <span className="font-bold">${fmt(amount)}</span> from{" "}
            <span className="font-bold">{from.name}</span>?
          </p>
          {inKindShare > 0 && (
            <p className="mt-1 text-[11px] font-mono text-amber-300 leading-relaxed">
              ${fmt(Math.min(from.allowance, amount))} moves as cash; ≈$
              {fmt(inKindShare)} moves as a slice of {from.name}&apos;s shares.
              The inherited names are then SOLD on the new portfolio&apos;s
              next sync and replaced with {paper.name}&apos;s picks.
            </p>
          )}
          <p className="mt-1 text-[11px] font-mono text-text-muted leading-relaxed">
            From the next sync its mirror will place real orders, buying{" "}
            {paper.name}&apos;s positions with that funding.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={disabled}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-red,#FF3333)]/50 text-[var(--color-red,#FF3333)] hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40 transition-colors"
            >
              {disabled ? "Creating…" : "Yes — go live"}
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

function TransferAction({
  disabled,
  sleeves,
  onSubmit,
}: {
  disabled: boolean;
  sleeves: { id: string; name: string; allowance: number; holdingsValue: number }[];
  onSubmit: (fromId: string, toId: string, amount: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const [fromId, setFromId] = useState(sleeves[0]?.id ?? "");
  const [toId, setToId] = useState(sleeves[1]?.id ?? "");
  const [confirming, setConfirming] = useState(false);
  const amount = Number(raw);
  const from = sleeves.find((s) => s.id === fromId);
  const to = sleeves.find((s) => s.id === toId);
  const valid =
    Number.isFinite(amount) && amount > 0 && fromId !== "" && toId !== "" &&
    fromId !== toId;
  // Beyond spare cash the difference moves IN KIND (a proportional slice of
  // the source's positions, records only) and the destination restructures on
  // its next sync — armed behind an explicit confirm.
  const worth = from ? from.allowance + from.holdingsValue : 0;
  const inKindShare =
    valid && from != null && amount > from.allowance + 0.01
      ? Math.round((amount - from.allowance) * 100) / 100
      : 0;
  const tooBig = valid && from != null && amount > worth + 0.01;
  const selectCls =
    "rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50";

  function fire() {
    onSubmit(fromId, toId, amount);
    setConfirming(false);
    setRaw("");
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || tooBig) return;
        if (inKindShare > 0) {
          setConfirming(true);
          return;
        }
        fire();
      }}
    >
      <input
        type="number"
        min="0.01"
        step="0.01"
        inputMode="decimal"
        placeholder="0.00"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          setConfirming(false);
        }}
        disabled={disabled}
        className="w-28 rounded-lg border border-white/[0.12] bg-transparent px-2.5 py-1.5 text-sm font-mono text-text placeholder:text-text-muted focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
        aria-label="Transfer amount"
      />
      <span className="text-[11px] text-text-muted">from</span>
      <select
        value={fromId}
        onChange={(e) => {
          setFromId(e.target.value);
          setConfirming(false);
        }}
        disabled={disabled}
        className={selectCls}
        aria-label="Transfer source"
      >
        {sleeves.map((s) => (
          <option key={s.id} value={s.id} className="bg-black">
            {s.name} (${fmt(s.allowance)})
          </option>
        ))}
      </select>
      <span className="text-[11px] text-text-muted">to</span>
      <select
        value={toId}
        onChange={(e) => setToId(e.target.value)}
        disabled={disabled}
        className={selectCls}
        aria-label="Transfer destination"
      >
        {sleeves.map((s) => (
          <option key={s.id} value={s.id} className="bg-black">
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={disabled || !valid || tooBig || confirming}
        className="inline-flex items-center rounded-lg border border-white/[0.12] px-3 py-1.5 text-[13px] font-medium text-text-dim hover:text-text hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Move
      </button>

      {tooBig && from && (
        <p className="basis-full text-xs text-[var(--color-red)] leading-relaxed">
          {from.name} is only worth ${fmt(worth)} in total.
        </p>
      )}
      {confirming && valid && !tooBig && from && to && (
        <div className="basis-full mt-1 rounded-xl border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3.5 py-3">
          <p className="text-sm text-text leading-relaxed">
            Move <span className="font-bold">${fmt(amount)}</span> from{" "}
            <span className="font-bold">{from.name}</span> to{" "}
            <span className="font-bold">{to.name}</span>?
          </p>
          <p className="mt-1 text-[11px] font-mono text-amber-300 leading-relaxed">
            Only ${fmt(from.allowance)} is spare cash — the remaining ≈$
            {fmt(inKindShare)} moves as a slice of {from.name}&apos;s shares.
            {to.name} then SELLS those inherited names on its next sync and
            buys its own book.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={fire}
              disabled={disabled}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-red,#FF3333)]/50 text-[var(--color-red,#FF3333)] hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40 transition-colors"
            >
              {disabled ? "Moving…" : "Yes — move in kind"}
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
    </form>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
