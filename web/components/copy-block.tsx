"use client";

import { useState } from "react";

interface Props {
  code: string;
  language?: string;
}

export default function CopyBlock({ code, language }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context). Silently fail —
      // users can still select-and-copy manually.
    }
  }

  return (
    <div className="relative group">
      <pre className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3 overflow-x-auto text-xs font-mono text-text leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy ${language ?? ""} snippet`}
        className="absolute top-2 right-2 text-[10px] font-mono uppercase tracking-[0.14em] px-2 py-1 rounded border border-white/10 bg-bg/80 text-text-muted hover:text-[var(--color-cyan)] hover:border-[var(--color-cyan)]/40 transition-colors"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
