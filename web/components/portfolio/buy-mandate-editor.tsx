"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePortfolioBuyMandate } from "@/lib/portfolios-mutations";

interface BuyMandateExample {
  id: string;
  label: string;
  summary: string;
  text: string;
}

const EXAMPLES: BuyMandateExample[] = [
  {
    id: "fundamentals-first",
    label: "Fundamentals first",
    summary: "Quality + valuation must both clear",
    text:
      "Only flag 5/5 conviction when fundamentals AND valuation both clear. " +
      "Required: rule-of-40 above 40, FCF margin above 10%, gross margin above 60%. " +
      "Veto if P/S above its 12-month median and revenue growth is decelerating QoQ. " +
      "Prior in-house BUY/BEAR verdicts must both be positive; either negative is at " +
      "most a 3/5. Prefer companies with multi-year revenue consistency.",
  },
  {
    id: "growth-momentum",
    label: "Growth momentum",
    summary: "Top-line acceleration > everything",
    text:
      "Flag 5/5 conviction for accelerating top-line stories: TTM revenue growth above " +
      "30% AND most recent quarter > TTM (QoQ acceleration). Margins can be thin but " +
      "must be improving — operating margin trending up year-over-year. Veto if " +
      "perf_52w_vs_spy is below -10% (don't catch falling knives) or if R40 is below 25. " +
      "Pay up for the fastest growers; valuation is secondary.",
  },
  {
    id: "diversify-first",
    label: "Diversify first",
    summary: "Sector + correlation awareness",
    text:
      "Before flagging 5/5, check current holdings for sector concentration. If we " +
      "already hold 3+ names in the same sector, downgrade this candidate by one " +
      "conviction notch. Prefer additions to under-represented sectors. Cap 5/5s " +
      "at names where the prior in-house BEAR verdict is positive (no obvious red " +
      "flags). Treat the curator's rationale as a starting point only.",
  },
];

/**
 * Per-portfolio editor for the buy-decisions mandate (migration 032).
 * Separate from the main mandate: the main one says WHAT the portfolio
 * should be; this one says HOW to evaluate any individual add to it.
 * Empty is fine — the buyer falls back to the main mandate alone.
 */
export default function BuyMandateEditor({
  initialBuyMandate,
}: {
  initialBuyMandate: string;
}) {
  const router = useRouter();
  const [buyMandate, setBuyMandate] = useState(initialBuyMandate);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = buyMandate !== initialBuyMandate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updatePortfolioBuyMandate({ buyMandate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="portfolio-buy-mandate"
            className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1"
          >
            Buy-decisions mandate
          </label>
          <p className="text-[10px] text-text-dim mb-1 font-mono">
            How the buying agent should evaluate adds to this portfolio.
            Empty means no per-buy rules — the agent works to the main
            mandate alone.
          </p>
          <textarea
            id="portfolio-buy-mandate"
            rows={7}
            maxLength={2000}
            placeholder="e.g. Only 5/5 conviction when R40 > 40, FCF margin > 10%, and prior bull/bear verdicts agree…"
            value={buyMandate}
            onChange={(e) => {
              setBuyMandate(e.target.value);
              setSaved(false);
            }}
            className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted resize-none"
          />
          <p className="text-[10px] text-text-muted mt-1 font-mono">
            {buyMandate.length} / 2000
          </p>
        </div>

        {error && (
          <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !dirty}
            className="px-4 py-2 bg-green/10 border border-green/40 text-green font-mono text-sm uppercase tracking-widest rounded hover:bg-green/20 hover:border-green disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40 transition-colors"
          >
            {pending ? "Saving…" : "Save changes →"}
          </button>
          {saved && !dirty && (
            <span className="text-xs font-mono text-green">✓ Saved</span>
          )}
        </div>
      </form>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Example briefs
        </p>
        <p className="text-[11px] text-text-muted leading-relaxed mb-3">
          Pick one and edit, or leave blank to use the main mandate only.
        </p>
        <ul className="space-y-2">
          {EXAMPLES.map((ex) => (
            <li key={ex.id}>
              <button
                type="button"
                onClick={() => {
                  setBuyMandate(ex.text);
                  setSaved(false);
                }}
                className="w-full text-left rounded-lg border border-white/10 bg-bg px-3 py-2.5 hover:border-cyan/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors group"
              >
                <span className="block text-sm font-medium text-text group-hover:text-cyan transition-colors">
                  {ex.label}
                </span>
                <span className="block text-[11px] font-mono text-text-muted mt-0.5">
                  {ex.summary}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
