"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePortfolioDetails } from "@/lib/portfolios-mutations";
import MandateChips from "@/components/portfolio/mandate-chips";

const MAIN_MANDATE_CHIPS: readonly string[] = [
  "Quality growth focus",
  "Lower-risk compounders",
  "AI infrastructure",
  "R40 score above 40",
  "FCF margin above 10%",
  "Revenue growth above 20%",
  "Gross margin above 60%",
  "US-listed only",
  "No biotech / healthcare",
  "Equal-weight, max 8% per position",
  "2% cash reserve",
  "Sell on broken thesis only",
];

export interface MandateExample {
  id: string;
  label: string;
  summary: string;
  text: string;
}

/**
 * Three structured, agent-executable starter mandates. Picking one fills the
 * textarea — the owner then edits and saves as normal.
 */
export const MANDATE_EXAMPLES: MandateExample[] = [
  {
    id: "quality-growth",
    label: "Quality growth",
    summary: "20 names · revenue growth + margins + FCF",
    text:
      "Build a 20-stock quality-growth paper portfolio of US-listed companies. " +
      "Universe: market cap $2B-$200B, revenue growth >15% TTM, gross margin >50%, " +
      "positive free cash flow. Equal-weight, 2% cash reserve, max 8% per position. " +
      "Avoid mega-cap concentration. Prefer companies with a Rule-of-40 score above 40. " +
      "Sell discipline: exit if revenue growth falls below 8% for two consecutive quarters " +
      "or if the broken-thesis signal fires. Rebalance weekly.",
  },
  {
    id: "ai-infrastructure",
    label: "AI infrastructure",
    summary: "12 names · compute, networking, data picks",
    text:
      "Build a focused 12-stock AI-infrastructure portfolio of US-listed companies " +
      "supplying the AI build-out: compute and accelerators, high-speed networking, " +
      "data-center power and cooling, and data platforms. Universe: market cap $5B-$500B, " +
      "revenue growth >20% TTM. Conviction-weight the top 5 at 12% each, the rest equal-weight, " +
      "5% cash reserve. Sell discipline: trim any position above 15% on strength; exit on a " +
      "broken thesis. Rebalance weekly.",
  },
  {
    id: "lower-risk-compounders",
    label: "Lower-risk compounders",
    summary: "25 names · steady, profitable, defensive",
    text:
      "Build a 25-stock lower-risk compounder portfolio of US-listed companies. " +
      "Universe: market cap >$20B, GAAP-profitable, net margin >12%, revenue growth 6-25% TTM, " +
      "free-cash-flow margin >10%. Equal-weight with a 5% cash reserve, max 6% per position. " +
      "Diversify across at least 6 sectors; cap any single sector at 25%. Avoid unprofitable " +
      "high-multiple names. Sell discipline: exit if net margin turns negative or the thesis breaks. " +
      "Rebalance weekly.",
  },
];

export default function PortfolioDetailsEditor({
  portfolioId,
  initialName,
  initialMandate,
}: {
  portfolioId: string;
  initialName: string;
  initialMandate: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [mandate, setMandate] = useState(initialMandate);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = name !== initialName || mandate !== initialMandate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updatePortfolioDetails({
        portfolioId,
        name,
        mandate,
      });
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
            htmlFor="portfolio-name"
            className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1"
          >
            Portfolio name
          </label>
          <input
            id="portfolio-name"
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted"
          />
        </div>

        <div>
          <label
            htmlFor="portfolio-mandate"
            className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1"
          >
            Description
          </label>
          <p className="text-[10px] text-text-dim mb-1 font-mono">
            Optional — shown on the public portfolio page. Your agents trade to
            their own briefs (set per agent in the team below) and the saved
            universe.
          </p>
          <textarea
            id="portfolio-mandate"
            rows={9}
            maxLength={2000}
            placeholder="Target universe, position limits, risk posture, sell discipline…"
            value={mandate}
            onChange={(e) => {
              setMandate(e.target.value);
              setSaved(false);
            }}
            className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted resize-none"
          />
          <MandateChips
            chips={MAIN_MANDATE_CHIPS}
            value={mandate}
            onChange={(next) => {
              setMandate(next);
              setSaved(false);
            }}
          />
          <p className="text-[10px] text-text-muted mt-2 font-mono">
            {mandate.length} / 2000
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

      {/* Example descriptions — clicking one fills the textarea. */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className="text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Example descriptions
        </p>
        <p className="text-[11px] text-text-muted leading-relaxed mb-3">
          Start from a structured write-up, then edit it to your taste.
        </p>
        <ul className="space-y-2">
          {MANDATE_EXAMPLES.map((ex) => (
            <li key={ex.id}>
              <button
                type="button"
                onClick={() => {
                  setMandate(ex.text);
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
