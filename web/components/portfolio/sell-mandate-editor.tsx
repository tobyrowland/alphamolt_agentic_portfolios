"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePortfolioSellMandate } from "@/lib/portfolios-mutations";

interface SellMandateExample {
  id: string;
  label: string;
  summary: string;
  text: string;
}

const EXAMPLES: SellMandateExample[] = [
  {
    id: "only-broken-thesis",
    label: "Only on broken thesis",
    summary: "Conservative — sell on hard signals only",
    text:
      "Only sell when the recorded buy thesis is clearly broken: at least one " +
      "break_signal firing on current data, OR fundamental business change " +
      "(acquisition, segment divestiture, business-model pivot away from " +
      "the original thesis). Do NOT sell on short-term price moves, single " +
      "missed quarters, or noisy valuation re-rating. If no thesis is recorded " +
      "for the position, only sell on outright fraud / suspension / acquisition.",
  },
  {
    id: "broken-or-decel",
    label: "Broken thesis OR sustained decel",
    summary: "Moderate — broken thesis or 2+ qtrs decel",
    text:
      "Sell when EITHER (a) the recorded buy thesis is broken via a firing " +
      "break_signal, OR (b) the company has shown sustained year-on-year " +
      "deterioration in the metric the thesis was built on (revenue growth, " +
      "margins, FCF) for at least 2 consecutive quarters. Also sell if the " +
      "portfolio's main mandate no longer applies — e.g. the company has " +
      "drifted out of the target sector / size / quality bracket. Don't sell " +
      "on short-term price moves alone.",
  },
  {
    id: "vigilant",
    label: "Vigilant",
    summary: "Sell on any meaningful deterioration",
    text:
      "Sell on any meaningful deterioration in the company's quality, " +
      "valuation discipline, or fit with the portfolio mandate. Specifically: " +
      "R40 score dropped 10+ points from snapshot, gross margin compressed " +
      "3+ percentage points, revenue growth decelerated by 1/3 or more YoY, " +
      "or the prior in-house BEAR verdict has turned negative. Better to " +
      "rotate the cash than hold a deteriorating name.",
  },
];

/**
 * Per-portfolio editor for the sell-decisions mandate (migration 034).
 * This is the Portfolio Review Agent's PRIMARY directive — without it
 * the reviewer is a no-op (the agent doesn't carry its own sell
 * discipline). Empty = agent stays its hand.
 */
export default function SellMandateEditor({
  initialSellMandate,
}: {
  initialSellMandate: string;
}) {
  const router = useRouter();
  const [sellMandate, setSellMandate] = useState(initialSellMandate);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = sellMandate !== initialSellMandate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updatePortfolioSellMandate({ sellMandate });
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
            htmlFor="portfolio-sell-mandate"
            className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1"
          >
            Sell-decisions mandate
          </label>
          <p className="text-[10px] text-text-dim mb-1 font-mono">
            How the Portfolio Review Agent should decide when to exit a
            position. Empty means the agent stays its hand — it carries no
            sell discipline of its own.
          </p>
          <textarea
            id="portfolio-sell-mandate"
            rows={7}
            maxLength={2000}
            placeholder="e.g. Only sell when a recorded break_signal fires or the company is acquired…"
            value={sellMandate}
            onChange={(e) => {
              setSellMandate(e.target.value);
              setSaved(false);
            }}
            className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted resize-none"
          />
          <p className="text-[10px] text-text-muted mt-1 font-mono">
            {sellMandate.length} / 2000
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
          Pick one and edit, or leave blank to keep the reviewer idle.
        </p>
        <ul className="space-y-2">
          {EXAMPLES.map((ex) => (
            <li key={ex.id}>
              <button
                type="button"
                onClick={() => {
                  setSellMandate(ex.text);
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
