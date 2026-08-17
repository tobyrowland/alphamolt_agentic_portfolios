"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LiveCashSummary } from "@/lib/live-cash-query";
import {
  creditAllowance,
  debitAllowance,
  transferAllowance,
} from "@/lib/live-cash-mutations";

/**
 * Owner-only cash console for a live portfolio's broker account (sleeves —
 * migration 083). Shows each sleeve's spending allowance next to the broker's
 * real cash, and lets the owner credit / debit / move allowances. Nothing here
 * places an order or moves money at the broker — an allowance only records who
 * may spend the shared pot.
 */
export default function LiveCashPanel({
  summary,
}: {
  summary: LiveCashSummary;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const current = summary.sleeves.find((s) => s.isCurrent);
  const others = summary.sleeves.filter((s) => !s.isCurrent);
  const totalAllowance = summary.sleeves.reduce((s, x) => s + x.allowance, 0);
  const overCommitted =
    summary.unallocated != null && summary.unallocated < -0.01;

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
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
    <div className="mt-5 border-t border-white/[0.08] pt-4">
      <h3 className="text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-text-dim mb-3">
        Cash allowances
      </h3>

      {/* Per-sleeve table */}
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
            <th className="text-left font-medium pb-1">Portfolio</th>
            <th className="text-right font-medium pb-1">Allowance</th>
            <th className="text-right font-medium pb-1">Holdings</th>
            <th className="text-right font-medium pb-1">Total</th>
          </tr>
        </thead>
        <tbody>
          {summary.sleeves.map((s) => (
            <tr key={s.portfolioId} className="border-t border-white/[0.06]">
              <td className="py-1.5 pr-2">
                <span className={s.isCurrent ? "text-text" : "text-text-dim"}>
                  {s.displayName}
                </span>
                {s.isCurrent && (
                  <span className="ml-1.5 text-[10px] font-mono uppercase text-[var(--color-green)]">
                    this
                  </span>
                )}
              </td>
              <td className="py-1.5 text-right font-mono text-text">
                ${fmt(s.allowance)}
              </td>
              <td className="py-1.5 text-right font-mono text-text-dim">
                ${fmt(s.holdingsValue)}
              </td>
              <td className="py-1.5 text-right font-mono text-text">
                ${fmt(s.allowance + s.holdingsValue)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/[0.1] text-text-dim">
            <td className="py-1.5">Broker cash</td>
            <td className="py-1.5 text-right font-mono" colSpan={3}>
              {summary.brokerCash == null ? "—" : `$${fmt(summary.brokerCash)}`}
            </td>
          </tr>
          <tr className="text-text-dim">
            <td className="py-0.5">Allowances total</td>
            <td className="py-0.5 text-right font-mono" colSpan={3}>
              ${fmt(totalAllowance)}
            </td>
          </tr>
          <tr className={overCommitted ? "text-[var(--color-red)]" : "text-text"}>
            <td className="py-0.5 font-medium">Unallocated</td>
            <td className="py-0.5 text-right font-mono font-medium" colSpan={3}>
              {summary.unallocated == null ? "—" : `$${fmt(summary.unallocated)}`}
            </td>
          </tr>
        </tfoot>
      </table>

      {overCommitted && (
        <p className="mt-2 text-xs text-[var(--color-red)] leading-relaxed">
          Allowances promise more than the account holds — debit one before it
          places an order that bounces.
        </p>
      )}
      {summary.brokerCash == null && (
        <p className="mt-2 text-[11px] text-text-muted leading-relaxed">
          Broker cash isn&apos;t readable from the website (no Alpaca keys in
          the web environment), so unallocated is unknown and crediting is
          disabled here. Debits and transfers still work; for credits use{" "}
          <code className="font-mono">live_cash.py --credit</code>.
        </p>
      )}

      {/* Actions on THIS sleeve */}
      {current && (
        <div className="mt-4 flex flex-col gap-2.5">
          <AmountAction
            label="Credit"
            hint="unallocated → this portfolio"
            disabled={pending || summary.unallocated == null}
            onSubmit={(amount) =>
              run(
                () => creditAllowance({ portfolioId: current.portfolioId, amount }),
                `Credited $${fmt(amount)} to ${current.displayName}.`,
              )
            }
          />
          <AmountAction
            label="Debit"
            hint="this portfolio → unallocated"
            disabled={pending}
            onSubmit={(amount) =>
              run(
                () => debitAllowance({ portfolioId: current.portfolioId, amount }),
                `Debited $${fmt(amount)} from ${current.displayName}.`,
              )
            }
          />
          {others.length > 0 && (
            <TransferAction
              disabled={pending}
              others={others.map((o) => ({
                id: o.portfolioId,
                name: o.displayName,
              }))}
              onSubmit={(toId, amount) =>
                run(
                  () =>
                    transferAllowance({
                      fromPortfolioId: current.portfolioId,
                      toPortfolioId: toId,
                      amount,
                    }),
                  `Moved $${fmt(amount)}.`,
                )
              }
            />
          )}
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
      {summary.ledger.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] font-mono uppercase tracking-wide text-text-muted mb-1.5">
            Recent movements
          </p>
          <ul className="flex flex-col gap-1">
            {summary.ledger.map((l) => (
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

      <p className="mt-3 text-[11px] text-text-muted leading-relaxed">
        An allowance is the most this portfolio&apos;s mirror may spend. Moving
        one never places an order — dividends and deposits land in unallocated
        until you credit them out, and sale proceeds return to the selling
        portfolio automatically.
      </p>
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

function TransferAction({
  disabled,
  others,
  onSubmit,
}: {
  disabled: boolean;
  others: { id: string; name: string }[];
  onSubmit: (toId: string, amount: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const [toId, setToId] = useState(others[0]?.id ?? "");
  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0 && toId !== "";
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit(toId, amount);
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
      <button
        type="submit"
        disabled={disabled || !valid}
        className="inline-flex items-center rounded-lg border border-white/[0.12] px-3 py-1.5 text-[13px] font-medium text-text-dim hover:text-text hover:border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Move
      </button>
      <span className="text-[11px] text-text-muted">to</span>
      <select
        value={toId}
        onChange={(e) => setToId(e.target.value)}
        disabled={disabled}
        className="rounded-lg border border-white/[0.12] bg-transparent px-2 py-1.5 text-[13px] text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
        aria-label="Transfer destination"
      >
        {others.map((o) => (
          <option key={o.id} value={o.id} className="bg-black">
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
