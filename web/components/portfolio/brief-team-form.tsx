"use client";

/**
 * Brief-first onboarding card (onboarding brief §3): "Brief a team that's
 * standing by", ~80% pre-filled. The mandate is the one required decision;
 * universe and agents default and are editable later. On GO the portfolio is
 * created with the chosen universe preset and a pre-rostered buyer + reviewer.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createPortfolio } from "@/lib/portfolios-mutations";

interface PresetOption {
  id: string;
  label: string;
  description: string;
}

// Tappable mandate starters (brief §3) — a phrase to mutate instead of facing
// a blank box. Each nudges the matching universe preset so the two stay in
// step, but the owner can change either independently.
const TEMPLATES: { label: string; preset: string; text: string }[] = [
  {
    label: "Quality compounders",
    preset: "quality-growth",
    text: "Durable quality compounders — high Rule of 40, fat free cash flow and gross margins, valuation kept sane. Hold through volatility; sell only on a broken thesis.",
  },
  {
    label: "Deep value",
    preset: "deep-value",
    text: "Cheap on sales versus their own history. I'll tolerate weaker quality for the discount; trim into strength and exit when the gap closes.",
  },
  {
    label: "GARP",
    preset: "quality-growth",
    text: "Growth at a reasonable price — double-digit revenue growth without paying a blow-off multiple. Sell when growth decelerates or the multiple runs ahead of the fundamentals.",
  },
];

export default function BriefTeamForm({
  presets,
  defaultPreset,
  defaultName,
  redirectTo,
}: {
  presets: PresetOption[];
  defaultPreset: string;
  defaultName: string;
  /** Where to land after a successful create (e.g. "/account" from the
   *  standalone /account/new page). Default: refresh in place. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [preset, setPreset] = useState(defaultPreset);
  const [mandate, setMandate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function applyTemplate(t: (typeof TEMPLATES)[number]) {
    setMandate(t.text);
    setPreset(t.preset);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!mandate.trim()) {
      setError("Write a one-line mandate — it's the brief your team trades to.");
      return;
    }
    startTransition(async () => {
      const result = await createPortfolio({
        displayName: name.trim() || defaultName,
        mandate,
        presetId: preset,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (redirectTo) {
        router.push(redirectTo);
        router.refresh();
      } else {
        router.refresh();
      }
    });
  }

  const selectedPreset = presets.find((p) => p.id === preset);

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-white/10">
        <h2 className="text-base font-bold tracking-[-0.01em] text-text">
          Brief your team
        </h2>
        <p className="mt-0.5 text-[13px] text-text-muted">
          Most of it&apos;s set. Tell them what to chase — that&apos;s the part
          only you can write.
        </p>
      </div>

      {/* UNIVERSE — pre-filled, never blocks */}
      <Row label="Universe">
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-[var(--color-green,#00FF41)]/50"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <span className="text-[11px] text-text-muted truncate">
            {selectedPreset?.description}
          </span>
          <Link
            href={`/screener?preset=${preset}`}
            className="shrink-0 text-[11px] font-mono text-[var(--color-cyan,#00F2FF)] hover:brightness-110"
          >
            refine in screener →
          </Link>
        </div>
      </Row>

      {/* AGENTS — pre-rostered, editable later */}
      <Row label="Agents">
        <ul className="space-y-1.5">
          <Seat role="Buyer" desc="picks names from your universe" />
          <Seat role="Reviewer" desc="sells when a thesis breaks" />
        </ul>
        <p className="mt-1.5 text-[11px] text-text-muted">
          Pre-rostered. Swap or add agents from the portfolio page once
          you&apos;re in.
        </p>
      </Row>

      {/* MANDATE — the one required decision */}
      <Row label="Mandate" required>
        <textarea
          rows={4}
          maxLength={2000}
          required
          placeholder="e.g. R40 winners, +10–75% vs SPY, strong quarterly revenue growth, limited margin erosion. Sell only on a broken thesis."
          value={mandate}
          onChange={(e) => setMandate(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-[var(--color-green,#00FF41)]/50 placeholder:text-text-muted resize-none"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => applyTemplate(t)}
              className="rounded-full border border-white/10 px-3 py-1 text-[11px] text-text-muted hover:text-text hover:border-white/25 transition-colors"
            >
              {t.label}
            </button>
          ))}
        </div>
      </Row>

      {/* Name — pre-filled, low-friction (not the decision) */}
      <Row label="Name">
        <input
          type="text"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-[var(--color-green,#00FF41)]/50"
        />
      </Row>

      {error && (
        <div className="px-5 pt-1">
          <p className="text-sm text-[var(--color-red,#FF3333)] font-mono border-l-2 border-[var(--color-red,#FF3333)] pl-3 py-1">
            {error}
          </p>
        </div>
      )}

      {/* GO + the reassurance, at the moment of commitment (brief §3) */}
      <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 border-t border-white/10">
        <button
          type="submit"
          disabled={pending}
          className="px-5 py-2.5 bg-[var(--color-green,#00FF41)]/10 border border-[var(--color-green,#00FF41)]/40 text-[var(--color-green,#00FF41)] font-mono text-sm uppercase tracking-widest rounded hover:bg-[var(--color-green,#00FF41)]/20 hover:border-[var(--color-green,#00FF41)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "Briefing…" : "Brief the team →"}
        </button>
        <span className="text-[12px] text-text-muted">
          You can edit the universe, agents and mandate any time before
          execution goes live.
        </span>
      </div>
    </form>
  );
}

function Row({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-4 border-b border-white/10">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-[var(--color-green,#00FF41)]">
          {label}
        </span>
        {required ? (
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-cyan,#00F2FF)]">
            required
          </span>
        ) : (
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
            pre-filled
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Seat({ role, desc }: { role: string; desc: string }) {
  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className="font-semibold text-text">{role}</span>
      <span className="text-text-muted text-[13px]">— {desc}</span>
    </li>
  );
}
