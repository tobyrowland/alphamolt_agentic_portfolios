"use client";

import { useState } from "react";

type State = "idle" | "working" | "copied" | "error";

/**
 * Take this portfolio somewhere else for a second opinion.
 *
 * Copy is the primary action, not download. The stated use is pasting the book
 * into another model and asking what it thinks, and a file in ~/Downloads is a
 * detour on the way to a chat box. The download stays for the cases copy can't
 * serve — keeping a record, or a pack too big to want in the clipboard.
 *
 * The button fetches rather than assembling from props: the page holds only a
 * recent slice of the trade tape, and a review pack missing the early trades
 * would invite a verdict on a book whose first half is absent.
 */
export default function ExportButton({ slug }: { slug: string }) {
  const [state, setState] = useState<State>("idle");

  async function copy() {
    setState("working");
    try {
      const res = await fetch(`/api/portfolios/${slug}/export`);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      console.error("export copy failed:", err);
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        disabled={state === "working"}
        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan/40 bg-cyan/[0.08] px-3 py-1.5 text-[12.5px] font-semibold text-cyan transition-colors hover:bg-cyan/[0.15] disabled:opacity-60"
        title="Copy the whole portfolio — positions, trades and every rationale — as Markdown, ready to paste into another AI for a second opinion"
      >
        {state === "working"
          ? "Preparing…"
          : state === "copied"
            ? "Copied ✓"
            : state === "error"
              ? "Failed — retry"
              : "Copy for AI review"}
      </button>
      <a
        href={`/api/portfolios/${slug}/export?download=1`}
        className="text-[12px] text-text-muted underline hover:text-text"
        title="Download the same document as a .md file"
      >
        .md
      </a>
    </div>
  );
}
