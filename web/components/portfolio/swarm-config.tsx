"use client";

/**
 * Config-in-place home for a portfolio (portfolio page brief). Owner-only:
 * the mandate (brief + building blocks), the swarm roster (buyers + reviewers
 * with per-member remit/knobs), the snake-draft toggle, and a thin link to the
 * portfolio's screen. Nothing here lives on the Dashboard.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import SwarmLoop from "@/components/portfolio/swarm-loop";
import {
  updatePortfolioDetails,
  addAgentToPortfolio,
  removeAgentFromPortfolio,
  setMemberSwarmConfig,
  setDraftConfig,
} from "@/lib/portfolios-mutations";
import { b64urlEncode } from "@/lib/screen/config";

interface Member {
  agent_id: string;
  handle: string;
  display_name: string;
  powered_by: string | null;
  role: "buyer" | "reviewer" | null;
  remit: string | null;
  config: Record<string, unknown> | null;
}

interface Props {
  portfolioId: string;
  slug: string;
  name: string;
  mandate: string;
  members: Member[];
  screenConfig: Record<string, unknown> | null;
  draftEnabled: boolean;
  /** Current holdings count — feeds the swarm-loop "YOUR BOOK" live count. */
  bookCount: number;
}

// Curated building blocks (brief §2). Clicking inserts the phrase into the
// brief; popular ones marked ★. A data-driven popularity list can come later.
const BLOCKS: { group: string; items: { label: string; text: string; star?: boolean }[] }[] = [
  {
    group: "Quality",
    items: [
      { label: "★ Rule of 40 winners", text: "Rule of 40 winners", star: true },
      { label: "Fat gross margins", text: "gross margin > 60%" },
      { label: "Strong FCF", text: "FCF margin > 10%" },
    ],
  },
  {
    group: "Value",
    items: [
      { label: "★ Cheap on sales", text: "P/S below its own 12-month median", star: true },
      { label: "P/S < 15", text: "P/S < 15" },
    ],
  },
  {
    group: "Exclude",
    items: [
      { label: "★ No biotech", text: "exclude Health Technology", star: true },
      { label: "No finance", text: "exclude Finance" },
    ],
  },
  {
    group: "Rules",
    items: [
      { label: "Momentum tilt", text: "tilt toward 52-week price strength" },
      { label: "Quality tilt", text: "tilt heavily toward quality" },
    ],
  },
];

export default function SwarmConfig({
  portfolioId,
  slug,
  name,
  mandate,
  members,
  screenConfig,
  draftEnabled,
  bookCount,
}: Props) {
  const [brief, setBrief] = useState(mandate);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const buyers = members.filter((m) => m.role === "buyer");
  const reviewers = members.filter((m) => m.role === "reviewer");
  const topN = Number((screenConfig as { topN?: number } | null)?.topN ?? 40);
  const screenHref = screenConfig
    ? `/screener?config=${b64urlEncode(JSON.stringify(screenConfig))}`
    : "/screener";

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  }

  function saveBrief() {
    start(async () => {
      const r = await updatePortfolioDetails({ portfolioId, name, mandate: brief });
      flash(r.ok ? "Mandate saved" : r.error);
    });
  }
  function insertBlock(text: string) {
    setBrief((b) => (b.trim() ? `${b.trim()}, ${text}` : text));
  }
  function toggleDraft(on: boolean) {
    start(async () => {
      const r = await setDraftConfig({
        portfolioId,
        draftConfig: on ? { order: "snake", cycle: "daily" } : null,
      });
      flash(r.ok ? (on ? "Swarm coordination on" : "Swarm coordination off") : r.error);
    });
  }

  return (
    <section className="space-y-6" aria-label="Portfolio configuration">
      {/* Mandate */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <h2 className="text-sm font-semibold text-text mb-1">Mandate</h2>
        <p className="text-xs text-text-muted mb-2">
          One plain-English brief — your portfolio&apos;s constitution. Its
          selection rules compile into your screen.
        </p>
        <label htmlFor="mandate" className="sr-only">
          Portfolio mandate
        </label>
        <textarea
          id="mandate"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40"
        />
        <div className="mt-3 space-y-2">
          {BLOCKS.map((g) => (
            <div key={g.group} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-text-muted w-16">
                {g.group}
              </span>
              {g.items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => insertBlock(it.text)}
                  className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-2 py-1 hover:text-text hover:border-green/40"
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={saveBrief}
            disabled={pending}
            className="font-mono text-[11px] rounded-md px-3 py-1.5 bg-green text-black disabled:opacity-40"
          >
            Save mandate
          </button>
          <Link href={screenHref} className="font-mono text-[11px] text-green hover:underline">
            → your screen · top {topN} candidates · view screen
          </Link>
          {msg && <span className="font-mono text-[11px] text-text-muted">{msg}</span>}
        </div>
      </div>

      {/* Draft toggle */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text">Swarm coordination</h2>
          <p className="text-xs text-text-muted">
            Snake-draft buying across your buyers (one name per turn, rotating
            order, shared cash) + first-valid-sell across reviewers. Off = each
            agent runs independently.
          </p>
        </div>
        <label className="font-mono text-[11px] text-green inline-flex items-center gap-2 shrink-0">
          <input
            type="checkbox"
            checked={draftEnabled}
            onChange={(e) => toggleDraft(e.target.checked)}
          />
          Run as a swarm
        </label>
      </div>

      {/* How the swarm runs — the engine loop, shown right above the roster
          you configure (brief §3). Spacing handled by the parent space-y-6. */}
      <SwarmLoop
        buyers={buyers.length}
        reviewers={reviewers.length}
        bookCount={bookCount}
        candidates={topN}
        className=""
      />

      {/* Buyers */}
      <RosterEditor
        title="Buyers"
        role="buyer"
        members={buyers}
        portfolioId={portfolioId}
        slug={slug}
        onFlash={flash}
      />

      {/* Reviewers */}
      <RosterEditor
        title="Reviewers"
        role="reviewer"
        members={reviewers}
        portfolioId={portfolioId}
        slug={slug}
        onFlash={flash}
      />
    </section>
  );
}

function RosterEditor({
  title,
  role,
  members,
  portfolioId,
  onFlash,
}: {
  title: string;
  role: "buyer" | "reviewer";
  members: Member[];
  portfolioId: string;
  slug: string;
  onFlash: (m: string) => void;
}) {
  const [handle, setHandle] = useState("");
  const [remit, setRemit] = useState("");
  const [, start] = useTransition();

  function add() {
    if (!handle.trim()) return;
    start(async () => {
      const r = await addAgentToPortfolio({
        portfolioId,
        handle: handle.trim(),
        role,
        remit: remit.trim() || undefined,
        config:
          role === "buyer"
            ? { convictionGate: 1, maxPerName: 0.08, cadence: "daily" }
            : { cadence: "weekly" },
      });
      onFlash(r.ok ? `Added ${handle}` : r.error);
      if (r.ok) {
        setHandle("");
        setRemit("");
      }
    });
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <h2 className="text-sm font-semibold text-text mb-2">
        {title}{" "}
        <span className="text-text-muted font-normal">({members.length})</span>
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {members.map((m) => (
          <AgentCard
            key={m.agent_id}
            member={m}
            role={role}
            portfolioId={portfolioId}
            onFlash={onFlash}
          />
        ))}
        {members.length === 0 && (
          <p className="text-xs text-text-muted">No {title.toLowerCase()} yet.</p>
        )}
      </div>

      <div className="mt-3 flex items-end gap-2 flex-wrap">
        <label className="text-[11px] text-text-muted">
          Add a {role}
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="agent handle"
            className="block mt-1 w-40 bg-black/30 border border-white/10 rounded-md px-2 py-1 text-sm text-text"
          />
        </label>
        <label className="text-[11px] text-text-muted">
          Remit
          <input
            value={remit}
            onChange={(e) => setRemit(e.target.value)}
            placeholder={role === "buyer" ? "e.g. deep value" : "e.g. thesis-strict"}
            className="block mt-1 w-44 bg-black/30 border border-white/10 rounded-md px-2 py-1 text-sm text-text"
          />
        </label>
        <button
          type="button"
          onClick={add}
          className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-3 py-1.5 hover:text-text"
        >
          + add
        </button>
      </div>
    </div>
  );
}

function AgentCard({
  member,
  role,
  portfolioId,
  onFlash,
}: {
  member: Member;
  role: "buyer" | "reviewer";
  portfolioId: string;
  onFlash: (m: string) => void;
}) {
  const cfg = (member.config ?? {}) as {
    convictionGate?: number;
    maxPerName?: number;
    cadence?: string;
  };
  const [gate, setGate] = useState(Number(cfg.convictionGate ?? 1));
  const [maxPct, setMaxPct] = useState(Number(cfg.maxPerName ?? 0.08) * 100);
  const [cadence, setCadence] = useState(String(cfg.cadence ?? (role === "buyer" ? "daily" : "weekly")));
  const [remit, setRemit] = useState(member.remit ?? "");
  const [, start] = useTransition();

  function save() {
    start(async () => {
      const r = await setMemberSwarmConfig({
        portfolioId,
        handle: member.handle,
        remit,
        config:
          role === "buyer"
            ? { convictionGate: gate, maxPerName: maxPct / 100, cadence }
            : { cadence },
      });
      onFlash(r.ok ? `Saved ${member.handle}` : r.error);
    });
  }
  function remove() {
    start(async () => {
      const r = await removeAgentFromPortfolio({ portfolioId, handle: member.handle });
      onFlash(r.ok ? `Removed ${member.handle}` : r.error);
    });
  }

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm text-text font-medium">{member.display_name}</span>
          {member.powered_by && (
            <span className="ml-2 text-[10px] font-mono text-green border border-green/30 rounded px-1.5 py-0.5">
              {member.powered_by}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={remove}
          aria-label={`Remove ${member.handle}`}
          className="text-text-muted hover:text-text text-xs"
        >
          remove
        </button>
      </div>
      <input
        value={remit}
        onChange={(e) => setRemit(e.target.value)}
        placeholder={role === "buyer" ? "remit (e.g. deep value)" : "focus (e.g. drawdown)"}
        className="mt-2 w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-text"
      />
      <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] text-text-muted">
        {role === "buyer" && (
          <>
            <label className="inline-flex items-center gap-1">
              conviction ≥
              <select
                value={gate}
                onChange={(e) => setGate(Number(e.target.value))}
                className="bg-black/40 border border-white/10 rounded px-1 text-text"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n} className="bg-black">
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1">
              max/name %
              <input
                type="number"
                min={1}
                max={100}
                value={Math.round(maxPct)}
                onChange={(e) => setMaxPct(Number(e.target.value))}
                className="w-14 bg-black/40 border border-white/10 rounded px-1 text-text"
              />
            </label>
          </>
        )}
        <label className="inline-flex items-center gap-1">
          cadence
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className="bg-black/40 border border-white/10 rounded px-1 text-text"
          >
            {["daily", "weekly", "monthly"].map((c) => (
              <option key={c} value={c} className="bg-black">
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={save}
          className="font-mono text-[11px] rounded border border-white/10 text-text-muted px-2 py-0.5 hover:text-text"
        >
          save
        </button>
      </div>
    </div>
  );
}
