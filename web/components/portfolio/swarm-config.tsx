"use client";

/**
 * Config-in-place home for a portfolio (portfolio page brief + agent-selection
 * follow-up). Owner-only: the mandate (brief + building blocks), the swarm
 * coordination toggle, the engine loop, and the swarm roster (buyers +
 * reviewers as rich cards). A thin link to the portfolio's screen.
 *
 * Agent selection is a registry-backed GALLERY — you pick a real registered
 * agent by its track record; you never type a "brain" (that was the bug that
 * kept regressing). remit + knobs are membership config set on top, per
 * portfolio. Every mutation calls router.refresh() so the roster updates
 * immediately.
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SwarmLoop from "@/components/portfolio/swarm-loop";
import { roleFor } from "@/lib/agent-roles";
import {
  updatePortfolioDetails,
  addAgentToPortfolio,
  removeAgentFromPortfolio,
  setMemberSwarmConfig,
  setDraftConfig,
} from "@/lib/portfolios-mutations";
import { b64urlEncode } from "@/lib/screen/config";

type Role = "buyer" | "reviewer";

interface Member {
  agent_id: string;
  handle: string;
  display_name: string;
  powered_by: string | null;
  strategy: string | null;
  role: Role | null;
  remit: string | null;
  config: Record<string, unknown> | null;
}

export interface AgentCatalogEntry {
  handle: string;
  displayName: string;
  poweredBy: string | null;
  isHouse: boolean;
  strategy: string | null;
  return30d: number | null;
  /** Realized win rate %, or null when no realized sells yet. */
  winPct: number | null;
  /** Sells in the trailing 30 days (reviewer "N sells / 30D"). */
  sells30d: number;
}

interface Props {
  portfolioId: string;
  slug: string;
  name: string;
  mandate: string;
  members: Member[];
  catalog: AgentCatalogEntry[];
  screenConfig: Record<string, unknown> | null;
  draftEnabled: boolean;
  /** Current holdings count — feeds the swarm-loop "YOUR BOOK" live count. */
  bookCount: number;
}

const BLOCKS: { group: string; items: { label: string; text: string }[] }[] = [
  {
    group: "Quality",
    items: [
      { label: "★ Rule of 40 winners", text: "Rule of 40 winners" },
      { label: "Fat gross margins", text: "gross margin > 60%" },
      { label: "Strong FCF", text: "FCF margin > 10%" },
    ],
  },
  {
    group: "Value",
    items: [
      { label: "★ Cheap on sales", text: "P/S below its own 12-month median" },
      { label: "P/S < 15", text: "P/S < 15" },
    ],
  },
  {
    group: "Exclude",
    items: [
      { label: "★ No biotech", text: "exclude Health Technology" },
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

/** The role a registered agent can fill, from its strategy (registry truth). */
function strategyRole(strategy: string | null): Role | null {
  const r = roleFor(strategy).role;
  if (r === "Buying Agent") return "buyer";
  if (r === "Reviewer") return "reviewer";
  return null;
}

/** A seated member's effective role — explicit role, else inferred from
 *  strategy so a buyer is never hidden just because role wasn't stamped. */
function memberRole(m: Member): Role | null {
  return m.role ?? strategyRole(m.strategy);
}

function fmtReturn(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** Track-record line for a card — buyers lead with 30d return + win rate,
 *  reviewers with their 30d sell count (matching the design mock). */
function TrackRecord({
  role,
  return30d,
  winPct,
  sells30d,
  align = "right",
}: {
  role: Role;
  return30d: number | null;
  winPct: number | null;
  sells30d: number;
  align?: "left" | "right";
}) {
  const up = (return30d ?? 0) >= 0;
  if (role === "reviewer") {
    return (
      <span className="font-mono text-[11px] text-text-muted">
        {sells30d} {sells30d === 1 ? "sell" : "sells"} · 30D
      </span>
    );
  }
  return (
    <span className={`font-mono text-[11px] ${align === "right" ? "text-right" : ""}`}>
      <span style={{ color: up ? "var(--color-green,#00FF41)" : "var(--color-red,#FF3333)" }}>
        {fmtReturn(return30d)}
      </span>
      <span className="text-text-muted"> · 30D</span>
      {winPct != null && (
        <span className="text-text-muted"> · WIN {Math.round(winPct)}%</span>
      )}
    </span>
  );
}

export default function SwarmConfig({
  portfolioId,
  slug,
  name,
  mandate,
  members,
  catalog,
  screenConfig,
  draftEnabled,
  bookCount,
}: Props) {
  const router = useRouter();
  const [brief, setBrief] = useState(mandate);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const buyers = members.filter((m) => memberRole(m) === "buyer");
  const reviewers = members.filter((m) => memberRole(m) === "reviewer");
  const topN = Number((screenConfig as { topN?: number } | null)?.topN ?? 40);
  const screenHref = screenConfig
    ? `/screener?config=${b64urlEncode(JSON.stringify(screenConfig))}`
    : "/screener";

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  }
  function refresh() {
    router.refresh();
  }

  function saveBrief() {
    start(async () => {
      const r = await updatePortfolioDetails({ portfolioId, name, mandate: brief });
      flash(r.ok ? "Mandate saved" : r.error);
      if (r.ok) refresh();
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
      if (r.ok) refresh();
    });
  }

  const seatedHandles = useMemo(
    () => new Set(members.map((m) => m.handle)),
    [members],
  );

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
        <div className="mt-3 flex items-center gap-3 flex-wrap">
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
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-center justify-between gap-3">
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
        {draftEnabled && buyers.length > 0 && (
          <p className="mt-2 font-mono text-[11px] text-text-muted">
            draft order:{" "}
            {buyers.map((b, i) => (
              <span key={b.agent_id}>
                {i > 0 && " → "}
                <span className="text-text">{b.display_name}</span>
              </span>
            ))}{" "}
            <span className="text-text-muted/60">(reverses each round)</span>
          </p>
        )}
      </div>

      {/* How the swarm runs — the engine loop, right above the roster you
          configure (brief §3). Spacing handled by the parent space-y-6. */}
      <SwarmLoop
        buyers={buyers.length}
        reviewers={reviewers.length}
        bookCount={bookCount}
        candidates={topN}
        className=""
      />

      {/* Rosters — registry-backed gallery, no free-text brain. */}
      <RosterEditor
        title="Buyers"
        role="buyer"
        seated={buyers}
        catalog={catalog}
        seatedHandles={seatedHandles}
        portfolioId={portfolioId}
        onFlash={flash}
        onRefresh={refresh}
      />
      <RosterEditor
        title="Reviewers"
        role="reviewer"
        seated={reviewers}
        catalog={catalog}
        seatedHandles={seatedHandles}
        portfolioId={portfolioId}
        onFlash={flash}
        onRefresh={refresh}
      />
    </section>
  );
}

function BrainBadge({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span className="text-[9px] font-mono uppercase tracking-[0.1em] text-green border border-green/30 rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function RosterEditor({
  title,
  role,
  seated,
  catalog,
  seatedHandles,
  portfolioId,
  onFlash,
  onRefresh,
}: {
  title: string;
  role: Role;
  seated: Member[];
  catalog: AgentCatalogEntry[];
  seatedHandles: Set<string>;
  portfolioId: string;
  onFlash: (m: string) => void;
  onRefresh: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [, start] = useTransition();

  // Registry agents that can fill this role and aren't already seated, best
  // track record first (the hero metric — people pick the winner).
  const available = useMemo(
    () =>
      catalog
        .filter((a) => strategyRole(a.strategy) === role && !seatedHandles.has(a.handle))
        .sort((x, y) => (y.return30d ?? -1e9) - (x.return30d ?? -1e9)),
    [catalog, role, seatedHandles],
  );

  function addAgent(handle: string) {
    start(async () => {
      const r = await addAgentToPortfolio({
        portfolioId,
        handle,
        role,
        config:
          role === "buyer"
            ? { convictionGate: 1, maxPerName: 0.08, cadence: "daily" }
            : { cadence: "weekly" },
      });
      onFlash(r.ok ? `Added ${handle}` : r.error);
      if (r.ok) {
        setPicking(false);
        onRefresh();
      }
    });
  }

  const subtitle =
    role === "buyer" ? "opens positions" : "manages & sells";

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text">
          {title}{" "}
          <span className="text-text-muted font-normal text-xs">· {subtitle}</span>{" "}
          <span className="text-text-muted font-normal">({seated.length})</span>
        </h2>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-3 py-1.5 hover:text-text"
        >
          {picking ? "Close" : seated.length > 0 ? "Swap in another brain" : `+ Add a ${role}`}
        </button>
      </div>

      {/* Seated roster */}
      {seated.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {seated.map((m) => {
            const cat = catalog.find((c) => c.handle === m.handle);
            return (
              <SeatedCard
                key={m.agent_id}
                member={m}
                role={role}
                return30d={cat?.return30d ?? null}
                winPct={cat?.winPct ?? null}
                sells30d={cat?.sells30d ?? 0}
                portfolioId={portfolioId}
                onFlash={onFlash}
                onRefresh={onRefresh}
              />
            );
          })}
        </div>
      ) : (
        !picking && (
          <EmptyRoster
            role={role}
            recommended={available.slice(0, 4)}
            onAdd={addAgent}
            onBrowse={() => setPicking(true)}
          />
        )
      )}

      {/* Gallery picker */}
      {picking && (
        <AgentGallery role={role} agents={available} onAdd={addAgent} />
      )}
    </div>
  );
}

function EmptyRoster({
  role,
  recommended,
  onAdd,
  onBrowse,
}: {
  role: Role;
  recommended: AgentCatalogEntry[];
  onAdd: (handle: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-white/15 p-4">
      <p className="text-sm text-text-muted mb-3">
        No {role}s yet. {role === "buyer" ? "Buyers draft names from your screen." : "Reviewers decide what to sell."}{" "}
        Add one to get started:
      </p>
      {recommended.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {recommended.map((a) => (
            <GalleryCard key={a.handle} agent={a} role={role} onAdd={onAdd} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted">No agents available to add.</p>
      )}
      <button
        type="button"
        onClick={onBrowse}
        className="mt-3 font-mono text-[11px] text-green hover:underline"
      >
        Browse all {role}s →
      </button>
    </div>
  );
}

function AgentGallery({
  role,
  agents,
  onAdd,
}: {
  role: Role;
  agents: AgentCatalogEntry[];
  onAdd: (handle: string) => void;
}) {
  const [tab, setTab] = useState<"all" | "house" | "community">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"return" | "handle">("return");

  const shown = useMemo(() => {
    let list = agents;
    if (tab === "house") list = list.filter((a) => a.isHouse);
    if (tab === "community") list = list.filter((a) => !a.isHouse);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((a) => a.handle.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q));
    return [...list].sort((x, y) =>
      sort === "return"
        ? (y.return30d ?? -1e9) - (x.return30d ?? -1e9)
        : x.handle.localeCompare(y.handle),
    );
  }, [agents, tab, query, sort]);

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3" role="dialog" aria-label={`Choose a ${role}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <div className="flex gap-1" role="tablist" aria-label="Source">
          {(["all", "house", "community"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`font-mono text-[10px] uppercase tracking-[0.1em] rounded px-2 py-1 border ${
                tab === t ? "text-green border-green/50 bg-green/10" : "text-text-muted border-white/10"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search handle…"
          aria-label="Search agents"
          className="flex-1 min-w-[120px] bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-text"
        />
        <label className="text-[10px] font-mono text-text-muted inline-flex items-center gap-1">
          sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "return" | "handle")}
            className="bg-black/40 border border-white/10 rounded px-1 text-text"
          >
            <option value="return" className="bg-black">30d return</option>
            <option value="handle" className="bg-black">handle</option>
          </select>
        </label>
      </div>
      {shown.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2 max-h-[360px] overflow-y-auto">
          {shown.map((a) => (
            <GalleryCard key={a.handle} agent={a} role={role} onAdd={onAdd} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted py-3 text-center">No matching agents.</p>
      )}
    </div>
  );
}

function GalleryCard({
  agent,
  role,
  onAdd,
}: {
  agent: AgentCatalogEntry;
  role: Role;
  onAdd: (handle: string) => void;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm text-text font-medium truncate">{agent.displayName}</span>
            <BrainBadge label={agent.poweredBy} />
          </div>
          <span className="font-mono text-[11px] text-text-muted">@{agent.handle}</span>
        </div>
        <span className="text-[9px] font-mono uppercase tracking-[0.1em] text-text-muted shrink-0">
          {agent.isHouse ? "House" : "Community"}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-text-muted">
          track record
        </span>
        <TrackRecord
          role={role}
          return30d={agent.return30d}
          winPct={agent.winPct}
          sells30d={agent.sells30d}
        />
      </div>
      <button
        type="button"
        onClick={() => onAdd(agent.handle)}
        className="font-mono text-[11px] rounded-md bg-green text-black px-3 py-1.5 hover:opacity-90"
      >
        Add
      </button>
    </div>
  );
}

function SeatedCard({
  member,
  role,
  return30d,
  winPct,
  sells30d,
  portfolioId,
  onFlash,
  onRefresh,
}: {
  member: Member;
  role: Role;
  return30d: number | null;
  winPct: number | null;
  sells30d: number;
  portfolioId: string;
  onFlash: (m: string) => void;
  onRefresh: () => void;
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
  const accent = role === "buyer" ? "var(--color-green)" : "var(--color-red)";

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
      if (r.ok) onRefresh();
    });
  }
  function remove() {
    start(async () => {
      const r = await removeAgentFromPortfolio({ portfolioId, handle: member.handle });
      onFlash(r.ok ? `Removed ${member.handle}` : r.error);
      if (r.ok) onRefresh();
    });
  }

  return (
    <div
      className="rounded-lg border bg-black/20 p-3"
      style={{ borderColor: `color-mix(in srgb, ${accent} 35%, transparent)` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm text-text font-medium truncate">{member.display_name}</span>
            <span
              className="text-[9px] font-mono uppercase tracking-[0.1em] rounded px-1.5 py-0.5"
              style={{ color: accent, border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)` }}
            >
              ✓ on your team
            </span>
          </div>
          <span className="font-mono text-[11px] text-text-muted">
            @{member.handle}
            {member.powered_by && <> · brain: {member.powered_by}</>}
          </span>
        </div>
        <div className="shrink-0 pt-0.5">
          <TrackRecord
            role={role}
            return30d={return30d}
            winPct={winPct}
            sells30d={sells30d}
          />
        </div>
      </div>
      <input
        value={remit}
        onChange={(e) => setRemit(e.target.value)}
        placeholder={role === "buyer" ? "style / remit (e.g. high-conviction growth)" : "style / focus (e.g. thesis-strict)"}
        aria-label="Remit"
        className="mt-2 w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-text"
      />
      <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] text-text-muted">
        {role === "buyer" && (
          <>
            <label className="inline-flex items-center gap-1">
              conv ≥
              <select
                value={gate}
                onChange={(e) => setGate(Number(e.target.value))}
                aria-label="Conviction gate"
                className="bg-black/40 border border-white/10 rounded px-1 text-text"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n} className="bg-black">{n}</option>
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
                aria-label="Max percent per name"
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
            aria-label="Cadence"
            className="bg-black/40 border border-white/10 rounded px-1 text-text"
          >
            {["daily", "weekly", "monthly"].map((c) => (
              <option key={c} value={c} className="bg-black">{c}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={save}
            className="font-mono text-[11px] rounded border border-white/10 text-text-muted px-2 py-0.5 hover:text-text"
          >
            save
          </button>
          <button
            type="button"
            onClick={remove}
            aria-label={`Remove ${member.handle}`}
            className="font-mono text-[11px] rounded border border-white/10 text-text-muted px-2 py-0.5 hover:text-[var(--color-red,#FF3333)]"
          >
            remove
          </button>
        </div>
      </div>
    </div>
  );
}
