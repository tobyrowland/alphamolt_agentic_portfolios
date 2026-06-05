"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveScreen } from "@/lib/screen/saved-mutations";
import {
  FILTER_FIELDS,
  FILTER_OPS,
  METRIC_META,
  NAMED_FILTERS,
  PRESETS,
  TEXT_FIELDS,
  encodeConfig,
  filterChipLabel,
  newFilterFor,
  presetConfig,
  type Filter,
  type FilterField,
  type FilterOp,
  type ScreenConfig,
} from "@/lib/screen/config";

interface Row {
  rank: number;
  ticker: string;
  name: string | null;
  sector: string | null;
  country: string | null;
  price: number | null;
  price_asof: string | null;
  score: number;
  ps: number | null;
  rev_growth_ttm: number | null;
  gross_margin: number | null;
  fcf_margin: number | null;
  rule_of_40: number | null;
  ret_52w: number | null;
  bull: boolean | null;
  bear: boolean | null;
}
interface ScreenData {
  rows: Row[];
  match_count: number;
  total_universe: number;
  cut_index: number;
  data_asof: string | null;
}

function fmt(v: number | null, opts?: { pct?: boolean; mult?: boolean; dp?: number }): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const dp = opts?.dp ?? (opts?.pct ? 1 : opts?.mult ? 1 : 2);
  const s = v.toFixed(dp);
  if (opts?.pct) return `${s}%`;
  if (opts?.mult) return `${s}×`;
  return s;
}
const PAGE_SIZE = 250;

// Hover explanations for the (jargon-y) ranking controls.
const WEIGHT_HELP: Record<"quality" | "value" | "momentum", string> = {
  quality:
    "Quality — how strong the business is: 0.60×Rule of 40 + 0.25×free-cash-flow margin + 0.15×gross margin, scored as percentiles within the filtered set. Raise it to favour profitable, efficient compounders.",
  value:
    "Value — how cheap it is on sales versus the stock's own 12-month median P/S (not an absolute P/S). Raise it to favour names trading below their usual valuation.",
  momentum:
    "Momentum — trailing 52-week price return, collared so falling knives and blow-off tops don't dominate. Raise it to favour recent leaders.",
};
const RANKING_HELP =
  "Each name's Score is a percentile blend of Quality, Value and Momentum, weighted by these sliders, relative to the names matching your filters — so it's this screen's own ranking, not a fixed house score.";
const AI_HELP =
  "Multiply each Score by the AI bull/bear verdict: dual-positive ×1.30, story-but-red-flags ×0.70, avoid ×0.40, sound-or-unrated ×1.00. Uncheck to ignore the AI overlay.";
const TOPN_HELP =
  "The top N ranked names become your buyer's candidate pool — the cut line in the table. Only these feed the swarm.";

function topWeight(w: { quality: number; value: number; momentum: number }): string {
  const e = Object.entries(w) as [string, number][];
  e.sort((a, b) => b[1] - a[1]);
  return e[0][0];
}

interface Col {
  key: string;
  label: string;
  green?: boolean;
  render: (r: Row) => string;
}
const BASE_COLS: Col[] = [
  { key: "ps", label: "P/S", render: (r) => fmt(r.ps, { mult: true }) },
  { key: "rev_growth_ttm", label: "Rev gr%", green: true, render: (r) => fmt(r.rev_growth_ttm, { pct: true }) },
  { key: "gross_margin", label: "GM%", green: true, render: (r) => fmt(r.gross_margin, { pct: true }) },
  { key: "rule_of_40", label: "R40", green: true, render: (r) => fmt(r.rule_of_40, { dp: 0 }) },
];
const EXTRA_COLS: Col[] = [
  { key: "fcf_margin", label: "FCF M%", green: true, render: (r) => fmt(r.fcf_margin, { pct: true }) },
  { key: "ret_52w", label: "52w%", render: (r) => fmt(r.ret_52w, { pct: true, dp: 0 }) },
];

export default function ScreenerClient({
  initialConfig,
  initialData,
}: {
  initialConfig: ScreenConfig;
  initialData: ScreenData;
  defaultEncoded?: string;
}) {
  const [config, setConfig] = useState<ScreenConfig>(initialConfig);
  const [data, setData] = useState<ScreenData>(initialData);
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState(initialConfig.brief ?? "");
  const [briefDirty, setBriefDirty] = useState(false);
  const [compileStatus, setCompileStatus] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [saveLink, setSaveLink] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [extraCols, setExtraCols] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const firstRender = useRef(true);

  // Render only the first chunk; "Load more" reveals more from memory. Reset to
  // the first page whenever the ranking changes.
  useEffect(() => setVisible(PAGE_SIZE), [data]);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
  }, []);

  // Live re-rank on config change (debounced) + URL sync. Skips initial mount.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      const encoded = encodeConfig(config);
      try {
        const res = await fetch(`/api/screen?config=${encoded}`, { cache: "no-store" });
        if (res.ok) setData((await res.json()) as ScreenData);
      } finally {
        setLoading(false);
      }
      const isClean = encoded === encodeConfig(presetConfig(config.preset ?? ""));
      const url =
        isClean && config.preset && config.preset !== "custom"
          ? `/screener?preset=${config.preset}`
          : `/screener?config=${encoded}`;
      window.history.replaceState(null, "", url);
    }, 350);
    return () => clearTimeout(handle);
  }, [config]);

  const patch = useCallback((p: Partial<ScreenConfig>) => {
    setConfig((c) => ({ ...c, preset: "custom", ...p }));
    setSaveLink(null);
  }, []);

  function selectPreset(id: string) {
    const c = presetConfig(id);
    setConfig(c);
    setBrief(c.brief ?? "");
    setBriefDirty(false);
    setCompileStatus(null);
    setSaveLink(null);
  }

  async function compile() {
    if (!brief.trim()) return;
    setCompiling(true);
    setCompileStatus("Compiling…");
    try {
      const res = await fetch("/api/compile-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      if (!res.ok) {
        setCompileStatus("Compile failed — tune the knobs directly.");
        return;
      }
      const { compiled } = await res.json();
      setConfig((c) => ({
        ...c,
        preset: "custom",
        brief,
        filters: compiled.filters,
        weights: compiled.weights,
        aiMultiplier: compiled.aiMultiplier,
      }));
      setBriefDirty(false);
      const fc = compiled.filters.length;
      setCompileStatus(`compiled — ${fc} filter${fc === 1 ? "" : "s"} + a ${topWeight(compiled.weights)}-tilted weighting`);
    } finally {
      setCompiling(false);
    }
  }

  async function onSave() {
    if (!signedIn) {
      setShareMsg("Sign in to save — viewing & sharing stay open.");
      return;
    }
    const name =
      config.preset && config.preset !== "custom"
        ? PRESETS[config.preset]?.label ?? "My screen"
        : "Custom screen";
    const res = await saveScreen({ name, config });
    if (res.ok) setSaveLink(`/screener?screen=${res.slug}`);
    else setShareMsg(res.error);
  }
  async function onShare() {
    const url = `${window.location.origin}/screener?config=${encodeConfig(config)}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareMsg("Link copied");
    } catch {
      setShareMsg(url);
    }
  }

  function setFilter(i: number, p: Partial<Filter>) {
    patch({ filters: config.filters.map((f, idx) => (idx === i ? { ...f, ...p } : f)) as Filter[] });
  }
  function removeFilter(i: number) {
    patch({ filters: config.filters.filter((_, idx) => idx !== i) });
  }
  function addNamedFilter(field: FilterField) {
    setAddOpen(false);
    patch({ filters: [...config.filters, newFilterFor(field)] });
  }

  const usedFields = useMemo(() => new Set(config.filters.map((f) => f.field)), [config.filters]);
  const cols = useMemo(() => [...BASE_COLS, ...EXTRA_COLS.filter((c) => extraCols.has(c.key))], [extraCols]);
  const metricColCount = 1 + cols.length; // Score + metric cols
  // "Run as a portfolio" applies this screen as the portfolio's selection
  // recipe (screen_config) and lands on the portfolio page — see
  // app/screener/run/route.ts.
  const runHref = `/screener/run?config=${encodeConfig(config)}`;

  const card = "rounded-xl border border-white/10 bg-white/[0.02]";

  return (
    <div>
      {/* How this works — at the top, under the h1: the screen ranks the whole
          universe, the top N flow to a portfolio. Screen → top N → Portfolio. */}
      <div className="mb-4">
        <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mb-2">
          How this works
        </div>
        <div className="flex items-stretch gap-0 flex-wrap">
          <div className="flex-1 min-w-[200px] rounded-xl border border-[var(--color-cyan)]/45 bg-[var(--color-cyan)]/[0.06] p-3.5">
            <div className="font-mono text-[12px] text-[var(--color-cyan)]">
              ● THIS SCREEN{" "}
              <span className="text-[9px] text-text-muted tracking-[0.05em]">YOU ARE HERE</span>
            </div>
            <div className="text-[11px] text-text-muted mt-1.5 leading-relaxed">
              Ranks every US equity by your config. Re-ranks live.
            </div>
          </div>
          <div className="flex-[0_0_130px] min-w-[120px] flex flex-col items-center justify-center px-1">
            <div className="font-mono text-[10px] text-green">top {config.topN}</div>
            <div
              className="w-full h-px my-1.5 relative"
              style={{ background: "linear-gradient(90deg,rgba(38,224,240,.5),rgba(55,219,128,.5))" }}
            >
              <span className="absolute -right-0.5 -top-[5px] text-green text-[11px]">▶</span>
            </div>
            <div className="font-mono text-[9px] text-text-muted">candidates</div>
          </div>
          <Link
            href={runHref}
            className="flex-1 min-w-[200px] rounded-xl border border-green/45 bg-green/[0.06] p-3.5 hover:bg-green/[0.1] transition-colors"
          >
            <div className="font-mono text-[12px] text-green">PORTFOLIO →</div>
            <div className="text-[11px] text-text-muted mt-1.5 leading-relaxed">
              Your <span className="text-text">swarm</span> drafts &amp; trades them — marked to
              market, daily.
            </div>
            <div className="font-mono text-[10px] text-green mt-2">
              Run this screen as a portfolio →
            </div>
          </Link>
        </div>
      </div>

      {/* Preset chips */}
      <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mr-1">
          Preset
        </span>
        {Object.values(PRESETS).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => selectPreset(p.id)}
            aria-pressed={config.preset === p.id}
            title={p.description}
            className={`font-mono text-[10.5px] rounded-md px-2.5 py-1.5 border transition-colors ${
              config.preset === p.id
                ? "text-[var(--color-cyan)] border-[var(--color-cyan)]/50 bg-[var(--color-cyan)]/[0.08]"
                : "text-text-muted border-white/10 hover:text-text"
            }`}
          >
            {p.label}
          </button>
        ))}
        <span
          className={`font-mono text-[10.5px] rounded-md px-2.5 py-1.5 border ${
            config.preset === "custom"
              ? "text-[var(--color-cyan)] border-[var(--color-cyan)]/50 bg-[var(--color-cyan)]/[0.08]"
              : "text-text-muted/50 border-white/10"
          }`}
        >
          Custom
        </span>
      </div>

      {/* Compact, pre-filled brief */}
      <label htmlFor="brief" className="sr-only">
        Strategy brief
      </label>
      <textarea
        id="brief"
        value={brief}
        onChange={(e) => {
          setBrief(e.target.value);
          setBriefDirty(true);
        }}
        rows={2}
        placeholder="Describe the stocks you want — e.g. Rule of 40 winners, no biotech, P/S under 15…"
        className="w-full resize-y rounded-lg bg-white/[0.02] border border-white/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-text placeholder:text-text-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40"
      />
      <div className="flex items-center gap-3 mt-2 mb-1 flex-wrap">
        <button
          type="button"
          onClick={compile}
          disabled={compiling || !brief.trim()}
          className="font-mono text-[11px] rounded-md px-3 py-1.5 bg-green text-black disabled:opacity-40"
        >
          {compiling ? "Compiling…" : briefDirty ? "Recompile ↻" : "Compile to screen"}
        </button>
        <span className="font-mono text-[10.5px] text-text-muted" aria-live="polite">
          {compileStatus ?? "the brief is for humans; the compiled filters & weights are what drive the screener"}
        </span>
      </div>

      {/* Screen bar: friendly filter chips + collapsed weighting on the right */}
      <div className="flex items-start gap-2 flex-wrap mt-3.5 mb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mt-2">
          Filters
        </span>

        {config.filters.map((f, i) => (
          <FilterChip
            key={`${f.field}-${i}`}
            filter={f}
            onChange={(p) => setFilter(i, p)}
            onRemove={() => removeFilter(i)}
          />
        ))}

        {/* + add filter menu */}
        <details
          className="relative"
          open={addOpen}
          onToggle={(e) => setAddOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="list-none cursor-pointer font-mono text-[10.5px] text-text-muted border border-dashed border-white/20 rounded-md px-2.5 py-1.5 hover:text-text marker:hidden [&::-webkit-details-marker]:hidden">
            + add filter
          </summary>
          <div className="absolute z-30 mt-1.5 w-52 rounded-xl border border-white/10 bg-[#0b1214] shadow-2xl p-1.5">
            {NAMED_FILTERS.filter((nf) => !usedFields.has(nf.field)).map((nf) => (
              <button
                key={nf.field}
                type="button"
                onClick={() => addNamedFilter(nf.field)}
                className="block w-full text-left font-mono text-[11px] text-text-dim hover:text-text hover:bg-white/5 rounded px-2 py-1.5"
              >
                {METRIC_META[nf.field]
                  ? `${nf.label} ${METRIC_META[nf.field].op === "<=" ? "below" : "above"}…`
                  : `${nf.label}…`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAdvancedOpen((v) => !v);
              }}
              className="block w-full text-left font-mono text-[11px] text-text-muted/70 hover:text-text hover:bg-white/5 rounded px-2 py-1.5 border-t border-white/10 mt-1 pt-2"
            >
              Advanced (field · operator · value)…
            </button>
          </div>
        </details>

      </div>

      {/* Advanced raw add row */}
      {advancedOpen && (
        <AdvancedAdd
          onAdd={(f) => {
            setAdvancedOpen(false);
            patch({ filters: [...config.filters, f] });
          }}
        />
      )}

      {/* Count + actions */}
      <div className="font-mono text-[10.5px] text-text-muted flex justify-between flex-wrap gap-1.5 mb-2">
        <span>
          {data.match_count} of {data.total_universe} · re-ranks live{loading ? " · …" : ""}
        </span>
        <span className="flex gap-3 items-center" aria-live="polite">
          <button type="button" onClick={onShare} className="text-[var(--color-cyan)] hover:underline">
            Share ↗
          </button>
          <button type="button" onClick={onSave} className="text-text-muted hover:text-text">
            Save
          </button>
          {saveLink ? (
            <Link href={saveLink} className="text-[var(--color-cyan)] underline">
              saved
            </Link>
          ) : shareMsg ? (
            <span className="text-text-muted">{shareMsg}</span>
          ) : (
            <span className="text-[var(--color-cyan)]">in this URL</span>
          )}
        </span>
      </div>

      {/* Configure scoring — sits right above the table it drives */}
      <details className={`mb-2 ${card}`}>
        <summary
          title="Configure how the Score is computed — the balance of Quality, Value and Momentum, the AI multiplier, and how many top names flow to a portfolio."
          className="list-none cursor-pointer font-mono text-[11px] text-[var(--color-cyan)] px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden flex items-center justify-between"
        >
          <span>⚙ Configure scoring</span>
          <span className="text-text-muted/60">
            Q {config.weights.quality} · V {config.weights.value} · M {config.weights.momentum}
            {config.aiMultiplier ? " · AI×" : ""} · top {config.topN} ▾
          </span>
        </summary>
        <div className="px-3 pb-3 sm:max-w-[520px]">
          <div className="flex items-center justify-between mt-1.5 gap-2">
            <span
              title={RANKING_HELP}
              className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted cursor-help underline decoration-dotted decoration-white/25 underline-offset-2"
            >
              This screen&apos;s own ranking{" "}
              <span aria-hidden className="text-text-muted/50 no-underline">ⓘ</span>
            </span>
            <label
              title={AI_HELP}
              className="font-mono text-[10.5px] text-[var(--color-cyan)] inline-flex items-center gap-1.5 cursor-help shrink-0"
            >
              <input
                type="checkbox"
                checked={config.aiMultiplier}
                onChange={(e) => patch({ aiMultiplier: e.target.checked })}
                className="accent-[var(--color-cyan)]"
              />
              AI bull/bear ×
            </label>
          </div>
          {(["quality", "value", "momentum"] as const).map((k) => (
            <div key={k} className="mt-2.5">
              <div className="flex justify-between font-mono text-[11px] text-text-muted capitalize">
                <span
                  title={WEIGHT_HELP[k]}
                  className="cursor-help underline decoration-dotted decoration-white/25 underline-offset-2"
                >
                  {k} <span aria-hidden className="text-text-muted/50 no-underline">ⓘ</span>
                </span>
                <span className="text-text">{config.weights[k]}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={config.weights[k]}
                onChange={(e) => patch({ weights: { ...config.weights, [k]: Number(e.target.value) } })}
                className="w-full accent-[var(--color-cyan)]"
                aria-label={`${k} weight, ${config.weights[k]} of 100`}
                title={WEIGHT_HELP[k]}
              />
            </div>
          ))}
          <div className="mt-3">
            <div className="flex justify-between font-mono text-[11px] text-text-muted">
              <span
                title={TOPN_HELP}
                className="cursor-help underline decoration-dotted decoration-white/25 underline-offset-2"
              >
                Top N → portfolio <span aria-hidden className="text-text-muted/50 no-underline">ⓘ</span>
              </span>
              <span className="text-[var(--color-cyan)]">{config.topN}</span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              value={config.topN}
              onChange={(e) => patch({ topN: Math.max(1, Math.min(200, Number(e.target.value))) })}
              className="w-full accent-[var(--color-cyan)]"
              aria-label={`Top N candidates, ${config.topN}`}
              title={TOPN_HELP}
            />
          </div>
        </div>
      </details>

      {/* Results */}
      <div className={`${card} overflow-hidden`}>
        <table className="w-full border-collapse" aria-label="Screened equities ranked by your composite">
          <thead>
            <tr className="bg-white/[0.02]">
              <Th className="text-left w-7">#</Th>
              <Th className="text-left">Ticker</Th>
              <Th>Score</Th>
              {cols.map((c) => (
                <Th key={c.key}>{c.label}</Th>
              ))}
              <th className="relative font-mono text-[10px] text-text-muted font-normal px-2 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => setColsOpen((v) => !v)}
                  aria-expanded={colsOpen}
                  className="hover:text-text"
                >
                  cols ▾
                </button>
                {colsOpen && (
                  <div className="absolute right-0 z-30 mt-1 w-40 rounded-xl border border-white/10 bg-[#0b1214] shadow-2xl p-1 text-left">

                    {EXTRA_COLS.map((c) => (
                      <label
                        key={c.key}
                        className="flex items-center gap-2 text-[11px] font-mono text-text-dim hover:bg-white/5 rounded px-2 py-1.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={extraCols.has(c.key)}
                          onChange={(e) =>
                            setExtraCols((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(c.key);
                              else next.delete(c.key);
                              return next;
                            })
                          }
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.slice(0, visible).map((r, i) => (
              <RowView
                key={r.ticker}
                r={r}
                cols={cols}
                cut={i === data.cut_index && data.cut_index < data.rows.length}
                dim={i >= data.cut_index}
                spanCols={metricColCount + 3}
                topN={config.topN}
                runHref={runHref}
              />
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={metricColCount + 3} className="p-6 text-center text-sm text-text-muted">
                  No matches — loosen your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data.rows.length > visible && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-4 py-2 hover:text-text hover:border-white/25"
          >
            Load {Math.min(PAGE_SIZE, data.rows.length - visible)} more
          </button>
          <span className="font-mono text-[10.5px] text-text-muted">
            showing {visible} of {data.rows.length}
          </span>
        </div>
      )}

      {/* Related screens */}
      <nav className="mt-5 flex gap-4 flex-wrap text-[12px] text-text-muted" aria-label="Related screens">
        <Link href="/screener?preset=deep-value" className="hover:text-text">
          Deep Value screen →
        </Link>
        <Link href="/screener?preset=high-fcf" className="hover:text-text">
          High FCF screen →
        </Link>
        <Link href="/leaderboard" className="hover:text-text">
          AI agent leaderboard →
        </Link>
      </nav>

      <footer className="border-t border-white/10 mt-5 pt-4">
        <p className="font-mono text-[10.5px] text-text-muted">
          Ranked by your configured composite · a research tool, not a
          recommendation · paper-trading only, not financial advice.
        </p>
      </footer>
    </div>
  );
}

/** A filter as a chip whose <details> opens a slider (operator implied). */
function FilterChip({
  filter,
  onChange,
  onRemove,
}: {
  filter: Filter;
  onChange: (p: Partial<Filter>) => void;
  onRemove: () => void;
}) {
  const isText = TEXT_FIELDS.has(filter.field);
  const m = METRIC_META[filter.field];
  return (
    <details className="inline-block align-top">
      <summary className="list-none cursor-pointer font-mono text-[11px] text-text border border-[var(--color-cyan)]/35 bg-[var(--color-cyan)]/[0.05] rounded-md px-2.5 py-1.5 inline-flex items-center gap-2 marker:hidden [&::-webkit-details-marker]:hidden">
        {filterChipLabel(filter)}
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove filter"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onRemove();
            }
          }}
          className="text-text-muted hover:text-text"
        >
          ✕
        </span>
      </summary>
      <div className="mt-1.5 w-[180px] rounded-lg border border-white/10 bg-[#0b1214] p-2.5">
        <div className="flex justify-between font-mono text-[10.5px] text-text-muted mb-1.5">
          <span>
            {m?.label ?? filter.field} {m?.op === "<=" ? "below" : "above"}
          </span>
          <span className="text-[var(--color-cyan)]">
            {filter.value}
            {m?.unit ?? ""}
          </span>
        </div>
        {isText ? (
          <input
            aria-label={`${filter.field} value`}
            value={String(filter.value ?? "")}
            onChange={(e) => onChange({ value: e.target.value })}
            className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-text"
          />
        ) : m ? (
          <input
            type="range"
            min={m.min}
            max={m.max}
            step={m.step}
            value={Number(filter.value)}
            onChange={(e) => onChange({ value: Number(e.target.value) })}
            aria-label={`${m.label} ${m.op === "<=" ? "at most" : "at least"} ${filter.value}${m.unit}`}
            className="w-full accent-[var(--color-cyan)]"
          />
        ) : null}
      </div>
    </details>
  );
}

/** The raw field · operator · value editor (power users). */
function AdvancedAdd({ onAdd }: { onAdd: (f: Filter) => void }) {
  const [field, setField] = useState<FilterField>("rule_of_40");
  const [op, setOp] = useState<FilterOp>(">=");
  const [value, setValue] = useState("40");
  const isText = TEXT_FIELDS.has(field);
  return (
    <div className="flex items-center gap-2 flex-wrap mb-2 rounded-lg border border-white/10 bg-black/20 p-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">Advanced</span>
      <select
        aria-label="Field"
        value={field}
        onChange={(e) => setField(e.target.value as FilterField)}
        className="bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f} value={f} className="bg-black">{f}</option>
        ))}
      </select>
      <select
        aria-label="Operator"
        value={op}
        onChange={(e) => setOp(e.target.value as FilterOp)}
        className="bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
      >
        {FILTER_OPS.map((o) => (
          <option key={o} value={o} className="bg-black">{o}</option>
        ))}
      </select>
      <input
        aria-label="Value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-24 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
      />
      <button
        type="button"
        onClick={() =>
          onAdd({ field, op, value: isText ? value : Number(value) || 0 })
        }
        className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-2.5 py-1 hover:text-text"
      >
        Add
      </button>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`font-mono text-[10px] tracking-[0.04em] text-text-muted font-normal px-2 py-2.5 text-right ${className}`}>
      {children}
    </th>
  );
}

function RowView({
  r,
  cols,
  cut,
  dim,
  spanCols,
  topN,
  runHref,
}: {
  r: Row;
  cols: Col[];
  cut: boolean;
  dim: boolean;
  spanCols: number;
  topN: number;
  runHref: string;
}) {
  return (
    <>
      {cut && (
        <tr>
          <td colSpan={spanCols} className="p-0 border-t border-green/45">
            <div className="flex justify-between items-center gap-2 flex-wrap bg-green/[0.07] px-2.5 py-1.5">
              <span className="font-mono text-[10px] text-green tracking-[0.05em]">
                ▲ TOP {topN} — what flows to a portfolio
              </span>
              <Link href={runHref} className="font-mono text-[10px] text-green hover:underline">
                Run as a portfolio →
              </Link>
            </div>
          </td>
        </tr>
      )}
      <tr className={`hover:bg-white/[0.025] ${dim ? "opacity-50" : ""}`}>
        <td className="px-2 py-2.5 text-left font-mono text-text-muted text-xs border-t border-white/10">
          {r.rank}
        </td>
        <td className="px-2 py-2.5 text-left border-t border-white/10">
          <Link href={`/company/${r.ticker}`} className="hover:text-[var(--color-cyan)]">
            <span className="font-mono text-text text-[12.5px]">{r.ticker}</span>{" "}
            <span className="text-[11px] text-text-muted">{r.name}</span>
          </Link>
        </td>
        <td className="px-2 py-2.5 text-right text-[12.5px] font-mono border-t border-white/10 text-[var(--color-cyan)]">
          {fmt(r.score, { dp: 1 })}
        </td>
        {cols.map((c) => (
          <td
            key={c.key}
            className={`px-2 py-2.5 text-right text-[12.5px] font-mono border-t border-white/10 ${c.green ? "text-green" : "text-text"}`}
          >
            {c.render(r)}
          </td>
        ))}
        <td className="border-t border-white/10" />
      </tr>
    </>
  );
}
