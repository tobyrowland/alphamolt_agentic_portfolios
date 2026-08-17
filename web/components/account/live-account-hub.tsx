"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LiveCashSummary, SleeveCash } from "@/lib/live-cash-query";
import {
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
  return (
    <div className="space-y-6">
      {accounts.map((a) => (
        <AccountPanel
          key={a.accountKey}
          account={a}
          paperOptions={paperOptions}
          showKey={accounts.length > 1}
        />
      ))}
    </div>
  );
}

function AccountPanel({
  account,
  paperOptions,
  showKey,
}: {
  account: LiveCashSummary;
  paperOptions: { id: string; name: string }[];
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

function TransferAction({
  disabled,
  sleeves,
  onSubmit,
}: {
  disabled: boolean;
  sleeves: { id: string; name: string }[];
  onSubmit: (fromId: string, toId: string, amount: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const [fromId, setFromId] = useState(sleeves[0]?.id ?? "");
  const [toId, setToId] = useState(sleeves[1]?.id ?? "");
  const amount = Number(raw);
  const valid =
    Number.isFinite(amount) && amount > 0 && fromId !== "" && toId !== "" &&
    fromId !== toId;
  const selectCls =
    "rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50";
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit(fromId, toId, amount);
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
        aria-label="Transfer amount"
      />
      <span className="text-[11px] text-text-muted">from</span>
      <select
        value={fromId}
        onChange={(e) => setFromId(e.target.value)}
        disabled={disabled}
        className={selectCls}
        aria-label="Transfer source"
      >
        {sleeves.map((s) => (
          <option key={s.id} value={s.id} className="bg-black">
            {s.name}
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
        disabled={disabled || !valid}
        className="inline-flex items-center rounded-lg border border-white/[0.12] px-3 py-1.5 text-[13px] font-medium text-text-dim hover:text-text hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Move
      </button>
    </form>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
