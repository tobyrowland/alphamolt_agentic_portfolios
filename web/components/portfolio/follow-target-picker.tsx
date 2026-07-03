"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLiveFollowTarget } from "@/lib/live-mirror-mutations";

/**
 * Owner control on the live follower's page: which paper book this real-money
 * account mirrors (follows_portfolio_id, migration 070). Explicit Apply —
 * re-pointing changes what the next mirror run buys/sells on Alpaca, so it's
 * never a silent dropdown side effect.
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
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = selected !== (currentId ?? "") && selected !== "";

  function apply() {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const res = await setLiveFollowTarget({
        portfolioId,
        followsPortfolioId: selected,
      });
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
            setSaved(null);
            setError(null);
          }}
          className="bg-bg border border-white/10 rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-[var(--color-green)]/50"
          aria-label="Paper portfolio this live account mirrors"
        >
          {currentId === null && <option value="">— not linked —</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || pending}
          className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest rounded border border-[var(--color-green)]/40 text-[var(--color-green)] hover:bg-[var(--color-green)]/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "Applying…" : "Apply"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-[var(--color-red,#FF3333)] font-mono">
          {error}
        </p>
      )}
      {saved && !dirty && (
        <p className="mt-2 text-[11px] font-mono text-text-muted">{saved}</p>
      )}
      {dirty && (
        <p className="mt-2 text-[11px] font-mono text-text-muted">
          Applying re-points real-money mirroring — the account converges onto
          the selected book on the next sync.
        </p>
      )}
    </div>
  );
}
