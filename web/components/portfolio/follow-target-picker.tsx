"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLiveFollowTarget } from "@/lib/live-mirror-mutations";

/**
 * Owner control on the live follower's page: which paper book this real-money
 * account mirrors (follows_portfolio_id, migration 070). Two-step commit —
 * Apply arms an explicit confirmation spelling out the from→to change, because
 * re-pointing makes the next mirror run sell/buy real positions on Alpaca to
 * converge onto a different book.
 */
export default function FollowTargetPicker({
  portfolioId,
  currentId,
  options,
}: {
  portfolioId: string;
  /** The currently-followed paper book's id (null = unlinked). */
  currentId: string | null;
  options: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(currentId ?? "");
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = selected !== (currentId ?? "") && selected !== "";
  const currentName =
    options.find((o) => o.id === currentId)?.name ?? "not linked";
  const selectedName = options.find((o) => o.id === selected)?.name ?? "";

  function reset() {
    setConfirming(false);
    setSaved(null);
    setError(null);
  }

  function confirmApply() {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const res = await setLiveFollowTarget({
        portfolioId,
        followsPortfolioId: selected,
      });
      setConfirming(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved("Updated — the next sync converges onto this book.");
      router.refresh();
    });
  }

  return (
    <div className="mt-4 pt-4 border-t border-white/10">
      <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
        Mirrors
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            reset();
          }}
          disabled={pending}
          className="bg-bg border border-white/10 rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-[var(--color-green)]/50 disabled:opacity-50"
          aria-label="Paper portfolio this live account mirrors"
        >
          {currentId === null && <option value="">— not linked —</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!dirty || pending}
            className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-green)]/40 text-[var(--color-green)] hover:bg-[var(--color-green)]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Apply
          </button>
        )}
      </div>

      {/* Step 2 — the real-money confirmation. Nothing is written until the
          owner explicitly confirms the from→to change. */}
      {confirming && dirty && (
        <div className="mt-3 rounded-xl border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3.5 py-3">
          <p className="text-sm text-text leading-relaxed">
            Re-point real-money mirroring from{" "}
            <span className="font-bold">{currentName}</span> to{" "}
            <span className="font-bold">{selectedName}</span>?
          </p>
          <p className="mt-1 text-[11px] font-mono text-text-muted leading-relaxed">
            On the next sync the Alpaca account will sell and buy real
            positions to match {selectedName} — potentially replacing most of
            the book.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={confirmApply}
              disabled={pending}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-red,#FF3333)]/50 text-[var(--color-red,#FF3333)] hover:bg-[var(--color-red,#FF3333)]/10 disabled:opacity-40 transition-colors"
            >
              {pending ? "Applying…" : `Yes — mirror ${selectedName}`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-white/15 text-text-muted hover:text-text disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-[var(--color-red,#FF3333)] font-mono">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="mt-2 text-[11px] font-mono text-text-muted">{saved}</p>
      )}
    </div>
  );
}
