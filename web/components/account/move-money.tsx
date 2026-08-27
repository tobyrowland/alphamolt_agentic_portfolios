"use client";

import { useState } from "react";
import {
  UNASSIGNED_ID,
  type Bucket,
  maxMovable,
  moveExplainer,
  moveRefusal,
  previewAfter,
  routeMove,
} from "@/lib/money-move";

function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * The account's one money-moving control: from, to, amount.
 *
 * Always open, above the list it changes — this is a surface people come to in
 * order to DO something, so the verb does not live behind a disclosure inside a
 * row. `routeMove` picks which server action carries it, so the owner never has
 * to know that crediting the pot, debiting it and moving between strategies are
 * three different operations underneath.
 */
export default function MoveMoney({
  buckets,
  disabled,
  onMove,
}: {
  buckets: Bucket[];
  disabled: boolean;
  onMove: (fromId: string, toId: string, amount: number) => void;
}) {
  // Default to moving OUT of the pot — the common case — but never to a
  // bucket that isn't on offer: when the broker balance can't be read there is
  // no pot, and defaulting to it would open on a refusal.
  const hasPot = buckets.some((b) => b.id === UNASSIGNED_ID);
  const [fromId, setFromId] = useState(
    hasPot ? UNASSIGNED_ID : (buckets[0]?.id ?? ""),
  );
  const [toId, setToId] = useState(
    buckets.find((b) => b.id !== (hasPot ? UNASSIGNED_ID : buckets[0]?.id))?.id ?? "",
  );
  const [raw, setRaw] = useState("");

  const from = buckets.find((b) => b.id === fromId) ?? null;
  const to = buckets.find((b) => b.id === toId) ?? null;
  const amount = Number(raw);
  const typed = raw.trim() !== "" && Number.isFinite(amount) && amount > 0;
  const refusal = moveRefusal(from, to, typed ? amount : NaN);
  const canMove = !!from && !!to && typed && !refusal && !disabled;
  const rows = from && to && typed ? previewAfter(from, to, amount) : [];

  return (
    <div
      className={`rounded-xl border bg-bg-card px-4 py-3.5 transition-colors ${
        rows.length > 0 ? "border-cyan/35" : "border-border"
      }`}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
        Move money
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2.5">
        <BucketPicker
          label="From"
          value={fromId}
          buckets={buckets}
          disabled={disabled}
          onChange={(id) => {
            setFromId(id);
            if (id === toId) {
              setToId(buckets.find((b) => b.id !== id)?.id ?? "");
            }
          }}
        />
        <span aria-hidden className="pb-2 font-mono text-[17px] text-text-muted">
          &#8594;
        </span>
        <BucketPicker
          label="To"
          value={toId}
          buckets={buckets.filter((b) => b.id !== fromId)}
          disabled={disabled}
          onChange={setToId}
        />

        <form
          className="ml-auto flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canMove) return;
            onMove(fromId, toId, amount);
            setRaw("");
          }}
        >
          <div className="flex flex-col gap-1">
            <label
              htmlFor="move-amount"
              className="text-[11px] text-text-muted"
            >
              Amount
            </label>
            <input
              id="move-amount"
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              disabled={disabled}
              className="w-32 rounded-lg border border-border-light bg-transparent px-3 py-2 font-mono text-[14px] tabular-nums text-text placeholder:text-text-muted focus:border-cyan focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={!canMove}
            className="rounded-lg border border-green/50 bg-green/10 px-5 py-2 text-[13.5px] font-semibold text-green transition-colors hover:bg-green/20 disabled:cursor-not-allowed disabled:border-border-light disabled:bg-transparent disabled:text-text-muted"
          >
            Move
          </button>
        </form>
      </div>

      {/* Everything that happens, before it happens. */}
      {rows.length > 0 && !refusal && from && to && (
        <div className="mt-3.5 flex flex-col gap-1.5 border-t border-border pt-3">
          <p className="text-[12.5px] text-text-muted">After this move</p>
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2.5">
              <span className="w-44 text-[13px] text-text-dim">{r.name}</span>
              <span className="font-mono text-[13px] tabular-nums text-text-muted line-through">
                ${fmt(r.before)}
              </span>
              <span aria-hidden className="font-mono text-[13px] text-text-muted">
                &#8594;
              </span>
              <span
                className={`font-mono text-[13px] tabular-nums ${
                  r.after > r.before ? "text-green" : "text-text"
                }`}
              >
                ${fmt(r.after)}
              </span>
            </div>
          ))}
          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
            {moveExplainer(from, to)}
          </p>
        </div>
      )}

      {refusal && typed && (
        <p className="mt-3 text-[12.5px] text-orange">{refusal}</p>
      )}

      {/* The ceiling, stated while choosing rather than after submitting. */}
      {!typed && from && to && routeMove(fromId, toId) && (
        <p className="mt-3 text-[12px] text-text-muted">
          Up to{" "}
          <span className="font-mono tabular-nums">
            ${fmt(maxMovable(from, to))}
          </span>{" "}
          can move from {from.name}.
        </p>
      )}
    </div>
  );
}

function BucketPicker({
  label,
  value,
  buckets,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  buckets: Bucket[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const selected = buckets.find((b) => b.id === value);
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={`move-${label.toLowerCase()}`}
        className="text-[11px] text-text-muted"
      >
        {label}
      </label>
      <select
        id={`move-${label.toLowerCase()}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="min-w-[190px] rounded-lg border border-border-light bg-transparent px-3 py-2 text-[14px] text-text focus:border-cyan focus:outline-none"
      >
        {buckets.map((b) => (
          <option key={b.id} value={b.id} className="bg-bg">
            {b.name}
          </option>
        ))}
      </select>
      <span className="font-mono text-[11.5px] tabular-nums text-text-muted">
        {selected ? `$${fmt(selected.value)}` : "—"}
      </span>
    </div>
  );
}
