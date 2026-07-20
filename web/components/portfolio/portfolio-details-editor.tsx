"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  generatePortfolioDescription,
  updatePortfolioDetails,
} from "@/lib/portfolios-mutations";

/**
 * Name + description editor on the portfolio page. Since the mandate demotion
 * the description is just the public blurb — so this is a deliberately simple
 * text box, with one power tool: "Generate", which drafts the description
 * server-side from what the portfolio actually is (the saved universe screen
 * + the hired agents' briefs). The draft only fills the textarea — nothing is
 * stored until the owner clicks Save.
 */
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
  const [generating, startGenerate] = useTransition();

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

  function handleGenerate() {
    setError(null);
    setSaved(false);
    startGenerate(async () => {
      const result = await generatePortfolioDescription({ portfolioId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMandate(result.text);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-[760px]">
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
        <div className="flex items-center justify-between gap-3 mb-1">
          <label
            htmlFor="portfolio-mandate"
            className="text-xs font-mono uppercase tracking-widest text-text-dim"
          >
            Description
          </label>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            title="Draft a description from your saved universe and the agents' briefs — you can edit it before saving."
            className="rounded border border-cyan/40 px-2.5 py-1 font-mono text-[11px] text-cyan hover:bg-cyan/10 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 transition-colors"
          >
            {generating ? "Generating…" : "✨ Generate"}
          </button>
        </div>
        <p className="text-[10px] text-text-dim mb-1 font-mono">
          Optional — shown on the public portfolio page. Generate drafts it
          from your universe &amp; agent briefs; edit freely before saving.
        </p>
        <textarea
          id="portfolio-mandate"
          rows={5}
          maxLength={2000}
          placeholder="What this portfolio is about — or hit Generate."
          value={mandate}
          onChange={(e) => {
            setMandate(e.target.value);
            setSaved(false);
          }}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text leading-relaxed focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan/40 focus:border-cyan/50 placeholder:text-text-muted resize-none"
        />
        <p className="text-[10px] text-text-muted mt-1 font-mono">
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
  );
}
