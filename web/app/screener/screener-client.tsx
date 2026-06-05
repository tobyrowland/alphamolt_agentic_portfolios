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

// Default + optional table columns (UX follow-up §4): lead with ~5, the rest
// behind "columns ▾".
interface Col {
  key: string;
  label: string;
  green?: boolean;
  render: (r: Row) => string;
}
const BASE_COLS: Col[] = [
  { key: "score", label: "Score", green: true, render: (r) => fmt(r.score, { dp: 1 }) },
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
  const [editingFilter, setEditingFilter] = useState<number | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [extraCols, setExtraCols] = useState<Set<string>>(new Set());
  const [tuneOpen, setTuneOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const firstRender = useRef(true);

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
    setBrief(c.brief ?? ""); // preset fills the brief (UX §2)
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
    setEditingFilter(null);
    patch({ filters: config.filters.filter((_, idx) => idx !== i) });
  }
  function addNamedFilter(field: FilterField) {
    setAddMenuOpen(false);
    patch({ filters: [...config.filters, newFilterFor(field)] });
    setEditingFilter(config.filters.length); // open the new chip's slider
  }

  const usedFields = useMemo(() => new Set(config.filters.map((f) => f.field)), [config.filters]);
  const cols = useMemo(
    () => [...BASE_COLS, ...EXTRA_COLS.filter((c) => extraCols.has(c.key))],
    [extraCols],
  );

  return (
    <div>
      {/* Preset chips */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
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
            className={`font-mono text-[11px] rounded-full px-3 py-1.5 border transition-colors ${
              config.preset === p.id
                ? "text-green border-green/50 bg-green/10"
                : "text-text-muted border-white/10 hover:text-text hover:border-white/25"
            }`}
          >
            {p.label}
          </button>
        ))}
        {config.preset === "custom" && (
          <span className="font-mono text-[11px] rounded-full px-3 py-1.5 border text-green border-green/50 bg-green/10">
            Custom
          </span>
        )}
      </div>

      {/* Compact brief */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 mb-3">
        <label htmlFor="brief" className="sr-only">
          Plain-English screen brief
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
          className="w-full resize-none rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm text-text placeholder:text-text-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40"
        />
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <button
            type="button"
            onClick={compile}
            disabled={compiling || !brief.trim()}
            className="font-mono text-[11px] rounded-md px-3 py-1.5 bg-green text-black disabled:opacity-40"
          >
            {compiling ? "Compiling…" : briefDirty ? "Recompile ↻" : "Compile to screen"}
          </button>
          {compileStatus && (
            <span className="font-mono text-[11px] text-text-muted" aria-live="polite">
              {compileStatus}
            </span>
          )}
        </div>
      </div>

      {/* Friendly filter bar */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mr-1">
          Filters
        </span>
        {config.filters.map((f, i) => (
          <button
            key={`${f.field}-${i}`}
            type="button"
            onClick={() => setEditingFilter(editingFilter === i ? null : i)}
            aria-expanded={editingFilter === i}
            className={`inline-flex items-center gap-1.5 font-mono text-[11px] rounded-full px-3 py-1.5 border transition-colors ${
              editingFilter === i
                ? "text-green border-green/50 bg-green/10"
                : "text-text border-green/25 bg-black/20 hover:border-green/40"
            }`}
          >
            {filterChipLabel(f)}
            <span
              role="button"
              tabIndex={0}
              aria-label="Remove filter"
              onClick={(e) => {
                e.stopPropagation();
                removeFilter(i);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  removeFilter(i);
                }
              }}
              className="text-text-muted hover:text-text"
            >
              ✕
            </span>
          </button>
        ))}

        {/* + add filter (named-filter menu) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            aria-expanded={addMenuOpen}
            className="font-mono text-[11px] rounded-full border border-dashed border-white/25 text-text-muted px-3 py-1.5 hover:text-text"
          >
            + add filter
          </button>
          {addMenuOpen && (
            <div className="absolute z-20 mt-1 w-52 rounded-lg border border-white/10 bg-[#0b0b0b] p-1 shadow-xl">
              {NAMED_FILTERS.filter((nf) => !usedFields.has(nf.field)).map((nf) => (
                <button
                  key={nf.field}
                  type="button"
                  onClick={() => addNamedFilter(nf.field)}
                  className="block w-full text-left text-sm text-text-dim hover:text-text hover:bg-white/5 rounded px-2 py-1.5"
                >
                  {nf.label}
                </button>
              ))}
              {NAMED_FILTERS.every((nf) => usedFields.has(nf.field)) && (
                <p className="text-xs text-text-muted px-2 py-1.5">All filters added.</p>
              )}
            </div>
          )}
        </div>

        <span className="font-mono text-[11px] text-text-muted ml-auto" aria-live="polite">
          {data.match_count} match{data.match_count === 1 ? "" : "es"}
          {loading ? " · …" : ""}
        </span>
      </div>

      {/* Inline chip adjuster (slider / value) */}
      {editingFilter != null && config.filters[editingFilter] && (
        <FilterAdjuster
          filter={config.filters[editingFilter]}
          onChange={(p) => setFilter(editingFilter, p)}
          onClose={() => setEditingFilter(null)}
        />
      )}

      <div className="font-mono text-[10.5px] text-text-muted my-2 flex justify-between flex-wrap gap-1.5">
        <span>
          {data.match_count} companies · top {Math.min(config.topN, data.match_count)} feed the
          buyer · {data.total_universe} in universe
        </span>
        <span className="text-green">filters &amp; weights live in this URL</span>
      </div>

      {/* Results — lead with the table */}
      <div className="flex items-center justify-end mb-1.5">
        <div className="relative">
          <button
            type="button"
            onClick={() => setColMenuOpen((v) => !v)}
            aria-expanded={colMenuOpen}
            className="font-mono text-[11px] text-text-muted hover:text-text border border-white/10 rounded-md px-2 py-1"
          >
            columns ▾
          </button>
          {colMenuOpen && (
            <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-white/10 bg-[#0b0b0b] p-1 shadow-xl">
              {EXTRA_COLS.map((c) => (
                <label
                  key={c.key}
                  className="flex items-center gap-2 text-sm text-text-dim hover:bg-white/5 rounded px-2 py-1.5 cursor-pointer"
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
        </div>
      </div>

      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full border-collapse" aria-label="Screened equities, ranked by your composite score">
          <thead>
            <tr className="bg-white/[0.02]">
              <Th className="text-left w-8">#</Th>
              <Th className="text-left">Ticker</Th>
              {cols.map((c) => (
                <Th key={c.key}>{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <RowView
                key={r.ticker}
                r={r}
                cols={cols}
                cut={i === data.cut_index && data.cut_index < data.rows.length}
                dim={i >= data.cut_index}
              />
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td colSpan={2 + cols.length} className="p-6 text-center text-sm text-text-muted">
                  No matches — loosen your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Tune ranking — collapsed by default */}
      <details
        className="mt-3 rounded-xl border border-white/10 bg-white/[0.02]"
        open={tuneOpen}
        onToggle={(e) => setTuneOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none px-4 py-3 text-sm text-text font-medium list-none flex items-center gap-2">
          <span className="text-green">⚙</span> Tune ranking
          <span className="text-text-muted font-normal text-xs">
            — weighting, AI multiplier, top N
          </span>
        </summary>
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
              Score weighting
            </span>
            <label className="font-mono text-[11px] text-green inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.aiMultiplier}
                onChange={(e) => patch({ aiMultiplier: e.target.checked })}
              />
              AI bull/bear ×
            </label>
          </div>
          <div className="flex gap-5 flex-wrap">
            {(["quality", "value", "momentum"] as const).map((k) => (
              <label key={k} className="flex-1 min-w-[150px]">
                <span className="font-mono text-[11px] text-text-muted flex justify-between capitalize">
                  <span>{k}</span>
                  <span className="text-text">{config.weights[k]}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={config.weights[k]}
                  onChange={(e) => patch({ weights: { ...config.weights, [k]: Number(e.target.value) } })}
                  className="w-full accent-green"
                  aria-label={`${k} weight, ${config.weights[k]} of 100`}
                />
              </label>
            ))}
            <label className="min-w-[110px]">
              <span className="font-mono text-[11px] text-text-muted flex justify-between">
                <span>Top N → buyer</span>
                <span className="text-text">{config.topN}</span>
              </span>
              <input
                type="number"
                min={1}
                max={200}
                value={config.topN}
                onChange={(e) => patch({ topN: Math.max(1, Math.min(200, Number(e.target.value))) })}
                className="w-full bg-black/30 border border-white/10 rounded-md px-2 py-1 text-sm text-text mt-1"
              />
            </label>
          </div>

          <div className="flex gap-2 mt-4 flex-wrap items-center">
            <button
              type="button"
              onClick={onShare}
              className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-3 py-1.5 hover:text-text"
            >
              Share ↗
            </button>
            <button
              type="button"
              onClick={onSave}
              className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-3 py-1.5 hover:text-text"
            >
              Save
            </button>
            {saveLink && (
              <Link href={saveLink} className="font-mono text-[11px] text-green underline">
                saved → {saveLink}
              </Link>
            )}
            {shareMsg && (
              <span className="font-mono text-[11px] text-text-muted" aria-live="polite">
                {shareMsg}
              </span>
            )}
          </div>

          {/* Advanced raw filter editor (power users) */}
          <details
            className="mt-4 border-t border-white/10 pt-3"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="cursor-pointer select-none text-[11px] font-mono text-text-muted">
              Advanced filters (field · operator · value)
            </summary>
            <div className="mt-2 space-y-2">
              {config.filters.map((f, i) => (
                <div key={`adv-${i}`} className="flex items-center gap-2 flex-wrap">
                  <select
                    aria-label="Filter field"
                    value={f.field}
                    onChange={(e) => {
                      const field = e.target.value as FilterField;
                      const isText = TEXT_FIELDS.has(field);
                      setFilter(i, {
                        field,
                        op: isText ? "==" : f.op,
                        value: isText ? String(f.value ?? "") : Number(f.value) || 0,
                      });
                    }}
                    className="bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
                  >
                    {FILTER_FIELDS.map((ff) => (
                      <option key={ff} value={ff} className="bg-black">{ff}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter operator"
                    value={f.op}
                    onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })}
                    className="bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
                  >
                    {FILTER_OPS.map((op) => (
                      <option key={op} value={op} className="bg-black">{op}</option>
                    ))}
                  </select>
                  {TEXT_FIELDS.has(f.field) ? (
                    <input
                      aria-label="Filter value"
                      value={String(f.value ?? "")}
                      onChange={(e) => setFilter(i, { value: e.target.value })}
                      className="w-32 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
                    />
                  ) : (
                    <input
                      aria-label="Filter value"
                      type="number"
                      value={Number(f.value)}
                      onChange={(e) => setFilter(i, { value: Number(e.target.value) })}
                      className="w-20 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-xs text-text"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeFilter(i)}
                    className="text-text-muted hover:text-text text-xs"
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </details>
        </div>
      </details>

      <footer className="border-t border-white/10 mt-5 pt-4">
        <p className="font-mono text-[10.5px] text-text-muted">
          Ranked by your configured composite · a research tool, not a
          recommendation · paper-trading only, not financial advice.
        </p>
      </footer>
    </div>
  );
}

function FilterAdjuster({
  filter,
  onChange,
  onClose,
}: {
  filter: Filter;
  onChange: (p: Partial<Filter>) => void;
  onClose: () => void;
}) {
  const isText = TEXT_FIELDS.has(filter.field);
  const m = METRIC_META[filter.field];
  return (
    <div className="rounded-xl border border-green/30 bg-black/30 p-3 mb-2 flex items-center gap-3 flex-wrap">
      <span className="font-mono text-[11px] text-text">{filterChipLabel(filter)}</span>
      {isText ? (
        <input
          aria-label={`${filter.field} value`}
          value={String(filter.value ?? "")}
          onChange={(e) => onChange({ value: e.target.value })}
          className="flex-1 min-w-[160px] bg-black/40 border border-white/10 rounded px-2 py-1 text-sm text-text"
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
          className="flex-1 min-w-[200px] accent-green"
        />
      ) : null}
      <button
        type="button"
        onClick={onClose}
        className="font-mono text-[11px] text-text-muted hover:text-text"
      >
        done
      </button>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`font-mono text-[10px] tracking-[0.04em] text-text-muted font-normal px-3 py-2.5 text-right ${className}`}>
      {children}
    </th>
  );
}

function RowView({ r, cols, cut, dim }: { r: Row; cols: Col[]; cut: boolean; dim: boolean }) {
  return (
    <>
      {cut && (
        <tr aria-hidden>
          <td colSpan={2 + cols.length} className="px-3 py-1 bg-green/[0.06] border-t border-green/30">
            <span className="font-mono text-[10px] text-green">
              ── cut line: above feeds your buyer · below is ranked, not bought ──
            </span>
          </td>
        </tr>
      )}
      <tr className={dim ? "opacity-45" : ""}>
        <td className="px-3 py-2.5 text-left font-mono text-text-muted text-xs border-t border-white/10">
          {r.rank}
        </td>
        <td className="px-3 py-2.5 text-left border-t border-white/10">
          <Link href={`/company/${r.ticker}`} className="hover:text-green">
            <span className="font-mono text-text text-[12.5px]">{r.ticker}</span>{" "}
            <span className="text-[11px] text-text-muted">{r.name}</span>
          </Link>
        </td>
        {cols.map((c) => (
          <td
            key={c.key}
            className={`px-3 py-2.5 text-right text-[12.5px] font-mono border-t border-white/10 ${
              c.green ? "text-green" : "text-text"
            }`}
          >
            {c.render(r)}
          </td>
        ))}
      </tr>
    </>
  );
}

function topWeight(w: { quality: number; value: number; momentum: number }): string {
  const entries = Object.entries(w) as [string, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}
