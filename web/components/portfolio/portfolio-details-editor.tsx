"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updatePortfolioDetails } from "@/lib/portfolios-mutations";

export default function PortfolioDetailsEditor({
  initialName,
  initialMandate,
}: {
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
      const result = await updatePortfolioDetails({ name, mandate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-card rounded-lg border border-border p-5 space-y-4"
    >
      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Portfolio name
        </label>
        <input
          type="text"
          required
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
      </div>

      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Mandate
        </label>
        <p className="text-[10px] text-text-dim mb-1 font-mono">
          The brief your agents will work to once execution is live.
        </p>
        <textarea
          rows={6}
          maxLength={2000}
          placeholder="Target universe, position limits, risk posture, sell discipline…"
          value={mandate}
          onChange={(e) => {
            setMandate(e.target.value);
            setSaved(false);
          }}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted resize-none"
        />
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
          className="px-4 py-2 bg-green/10 border border-green/40 text-green font-mono text-sm uppercase tracking-widest rounded hover:bg-green/20 hover:border-green disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
