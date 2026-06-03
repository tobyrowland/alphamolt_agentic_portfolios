"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Risk acknowledgement for the SECRET live (real-money / Alpaca) portfolio
// feature — rendered only on the surfaces that expose it, not site-wide.
// Bump the version suffix to re-prompt everyone after a material wording
// change. Per-browser via localStorage — deliberately lightweight; it's an
// in-group beta notice, not a signed agreement.
const ACK_KEY = "alphamolt_live_risk_ack_v1";

export default function BetaDisclaimer() {
  // Start "acknowledged" so the server render and first client render both emit
  // nothing (no hydration mismatch, no flash for returning visitors). The
  // effect then reveals the modal only for users who haven't accepted.
  const [acknowledged, setAcknowledged] = useState(true);

  useEffect(() => {
    try {
      setAcknowledged(window.localStorage.getItem(ACK_KEY) === "1");
    } catch {
      // localStorage blocked (private mode / disabled) — show it each visit
      // rather than suppress it.
      setAcknowledged(false);
    }
  }, []);

  function accept() {
    try {
      window.localStorage.setItem(ACK_KEY, "1");
    } catch {
      /* non-fatal — dismiss for this session regardless */
    }
    setAcknowledged(true);
  }

  if (acknowledged) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="beta-disclaimer-title"
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-[480px] rounded-2xl border p-6 sm:p-7"
        style={{
          background: "var(--color-bg-card)",
          borderColor: "rgba(255,255,255,0.12)",
          boxShadow:
            "0 20px 60px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)",
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-orange)]/40 bg-[var(--color-orange)]/[0.08] px-2.5 py-1 text-[11px] font-mono font-bold uppercase tracking-[0.14em] text-[var(--color-orange)]">
          Real money · private beta
        </span>

        <h2
          id="beta-disclaimer-title"
          className="mt-4 text-[20px] sm:text-[22px] font-bold tracking-[-0.02em] text-text leading-snug"
        >
          Live trading — entirely at your own risk
        </h2>

        <p className="mt-3 text-sm text-text-muted leading-relaxed">
          This is an <strong className="text-text-dim">experimental, private
          beta</strong> feature that mirrors your portfolio to a{" "}
          <strong className="text-text-dim">real brokerage account and places
          real-money orders</strong>. It&rsquo;s provided <em>as-is</em>, with
          no guarantee of data accuracy, execution, or availability. You use it{" "}
          <strong className="text-text-dim">entirely at your own risk</strong>{" "}
          — we bear no responsibility for any losses. Nothing here is financial
          advice.
        </p>

        <p className="mt-3 text-xs text-text-muted leading-relaxed">
          By continuing you accept this and our{" "}
          <Link
            href="/terms"
            className="text-text-dim underline decoration-1 underline-offset-2 hover:text-text"
          >
            Terms
          </Link>{" "}
          and{" "}
          <Link
            href="/privacy"
            className="text-text-dim underline decoration-1 underline-offset-2 hover:text-text"
          >
            Privacy
          </Link>{" "}
          policy.
        </p>

        <button
          type="button"
          onClick={accept}
          autoFocus
          className="mt-6 w-full rounded-lg border border-[var(--color-green)]/40 bg-[var(--color-green)]/[0.10] px-4 py-2.5 text-sm font-bold text-[var(--color-green)] hover:bg-[var(--color-green)]/[0.18] transition-colors"
        >
          I understand — continue
        </button>
      </div>
    </div>
  );
}
