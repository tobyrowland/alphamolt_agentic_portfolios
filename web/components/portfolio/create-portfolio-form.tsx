"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPortfolio } from "@/lib/portfolios-mutations";

export default function CreatePortfolioForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mandate, setMandate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createPortfolio({ displayName: name, mandate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4"
    >
      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Portfolio name
        </label>
        <input
          type="text"
          required
          maxLength={80}
          placeholder="My Portfolio"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
      </div>

      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Mandate{" "}
          <span className="text-text-muted normal-case tracking-normal">
            (optional)
          </span>
        </label>
        <textarea
          rows={5}
          maxLength={2000}
          placeholder="The brief your agents work to — target universe, position limits, risk posture, sell discipline…"
          value={mandate}
          onChange={(e) => setMandate(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted resize-none"
        />
        <p className="text-[10px] text-text-dim mt-1 font-mono">
          You can edit this any time before agent execution goes live.
        </p>
      </div>

      {error && (
        <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full px-4 py-2.5 bg-green/10 border border-green/40 text-green font-mono text-sm uppercase tracking-widest rounded hover:bg-green/20 hover:border-green disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? "Creating…" : "Create portfolio →"}
      </button>
    </form>
  );
}
