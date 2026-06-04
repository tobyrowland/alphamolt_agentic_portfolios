"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveScreen } from "@/lib/screen/saved-mutations";
import {
  FILTER_FIELDS,
  FILTER_OPS,
  PRESETS,
  TEXT_FIELDS,
  encodeConfig,
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

const FIELD_LABEL: Record<FilterField, string> = {
  sector: "Sector",
  country: "Country",
  ps: "P/S",
  rev_growth_ttm: "Rev growth %",
  gross_margin: "Gross margin %",
  fcf_margin: "FCF margin %",
  net_margin: "Net margin %",
  operating_margin: "Op margin %",
  rule_of_40: "Rule of 40",
  ret_52w: "52w return %",
  price: "Price $",
};

function fmt(v: number | null, opts?: { pct?: boolean; mult?: boolean; dp?: number }): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const dp = opts?.dp ?? (opts?.pct ? 1 : opts?.mult ? 1 : 2);
  const s = v.toFixed(dp);
  if (opts?.pct) return `${s}%`;
  if (opts?.mult) return `${s}×`;
  return s;
}

export default function ScreenerClient({
  initialConfig,
  initialData,
  defaultEncoded,
}: {
  initialConfig: ScreenConfig;
  initialData: ScreenData;
  defaultEncoded: string;
}) {
  const [config, setConfig] = useState<ScreenConfig>(initialConfig);
  const [data, setData] = useState<ScreenData>(initialData);
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState(initialConfig.brief ?? "");
  const [compileStatus, setCompileStatus] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [saveLink, setSaveLink] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
  }, []);

  // Live re-rank: whenever the compiled config changes, re-fetch /api/screen
  // (debounced) and sync the URL. Skips the initial mount (SSR already paid).
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
        if (res.ok) {
          const json = await res.json();
          setData(json as ScreenData);
        }
      } finally {
        setLoading(false);
      }
      // Clean URL for an unmodified preset, else the encoded config.
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
    setBrief("");
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
        setCompileStatus("Compile failed — edit the knobs directly.");
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
      const fc = compiled.filters.length;
      const tilt = topWeight(compiled.weights);
      setCompileStatus(`compiled — ${fc} filter${fc === 1 ? "" : "s"} + a ${tilt}-tilted weighting`);
    } finally {
      setCompiling(false);
    }
  }

  async function onSave() {
    if (!signedIn) {
      setSaveLink(null);
      setShareMsg("Sign in to save — viewing & sharing stay open.");
      return;
    }
    const name = config.preset && config.preset !== "custom"
      ? PRESETS[config.preset]?.label ?? "My screen"
      : "Custom screen";
    const res = await saveScreen({ name, config });
    if (res.ok) setSaveLink(`/screener?screen=${res.slug}`);
    else setShareMsg(res.error);
  }

  async function onShare() {
    const encoded = encodeConfig(config);
    const url = `${window.location.origin}/screener?config=${encoded}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareMsg("Link copied to clipboard");
    } catch {
      setShareMsg(url);
    }
  }

  function addFilter() {
    const used = new Set(config.filters.map((f) => f.field));
    const field = FILTER_FIELDS.find((f) => !used.has(f)) ?? "ps";
    const isText = TEXT_FIELDS.has(field);
    patch({
      filters: [
        ...config.filters,
        { field, op: isText ? "==" : "<=", value: isText ? "" : 0 } as Filter,
      ],
    });
  }
  function updateFilter(i: number, p: Partial<Filter>) {
    const next = config.filters.map((f, idx) => (idx === i ? { ...f, ...p } : f));
    patch({ filters: next as Filter[] });
  }
  function removeFilter(i: number) {
    patch({ filters: config.filters.filter((_, idx) => idx !== i) });
  }

  const rows = data.rows;

  return (
    <div>
      {/* ---- Brief panel ---- */}
      <section
        className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mb-3"
        aria-label="Screen brief"
      >
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mr-1">
            Preset
          </span>
          {Object.values(PRESETS).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPreset(p.id)}
              aria-pressed={config.preset === p.id}
              className={`font-mono text-[11px] rounded-md px-2.5 py-1.5 border transition-colors ${
                config.preset === p.id
                  ? "text-green border-green/50 bg-green/10"
                  : "text-text-muted border-white/10 hover:text-text"
              }`}
            >
              {p.label}
            </button>
          ))}
          <span
            className={`font-mono text-[11px] rounded-md px-2.5 py-1.5 border ${
              config.preset === "custom"
                ? "text-green border-green/50 bg-green/10"
                : "text-text-muted/60 border-white/10"
            }`}
          >
            Custom
          </span>
        </div>

        <label htmlFor="brief" className="sr-only">
          Plain-English screen brief
        </label>
        <textarea
          id="brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={2}
          placeholder="e.g. Rule of 40 winners, no biotech, P/S under 15, lean quality-tilted…"
          className="w-full resize-y rounded-md bg-black/30 border border-white/10 px-3 py-2 text-sm text-text placeholder:text-text-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-green/40"
        />
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <button
            type="button"
            onClick={compile}
            disabled={compiling || !brief.trim()}
            className="font-mono text-[11px] rounded-md px-3 py-1.5 bg-green text-black disabled:opacity-40"
          >
            {compiling ? "Compiling…" : "Compile to screen"}
          </button>
          {compileStatus && (
            <span className="font-mono text-[11px] text-text-muted" aria-live="polite">
              {compileStatus}
            </span>
          )}
          <span className="font-mono text-[10px] text-text-muted/70">
            the brief is for humans; the compiled knobs below are what the buyer
            reads
          </span>
        </div>
      </section>

      {/* ---- Compiled screen panel ---- */}
      <details className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mb-3" open>
        <summary className="cursor-pointer text-green font-mono text-[11px] select-none">
          Compiled screen — filters &amp; score weighting
        </summary>

        <div className="flex items-center gap-2 flex-wrap mt-3 pb-3 border-b border-white/10">
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mr-1">
            Filters
          </span>
          {config.filters.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 font-mono text-[11px] rounded-md border border-green/30 bg-black/30 px-2 py-1"
            >
              <select
                aria-label="Filter field"
                value={f.field}
                onChange={(e) => {
                  const field = e.target.value as FilterField;
                  const isText = TEXT_FIELDS.has(field);
                  updateFilter(i, {
                    field,
                    op: isText ? "==" : f.op,
                    value: isText ? String(f.value ?? "") : Number(f.value) || 0,
                  });
                }}
                className="bg-transparent text-text focus:outline-none"
              >
                {FILTER_FIELDS.map((ff) => (
                  <option key={ff} value={ff} className="bg-black">
                    {FIELD_LABEL[ff]}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter operator"
                value={f.op}
                onChange={(e) => updateFilter(i, { op: e.target.value as FilterOp })}
                className="bg-transparent text-text focus:outline-none"
              >
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op} className="bg-black">
                    {op}
                  </option>
                ))}
              </select>
              {TEXT_FIELDS.has(f.field) ? (
                <input
                  aria-label="Filter value"
                  value={String(f.value ?? "")}
                  onChange={(e) => updateFilter(i, { value: e.target.value })}
                  className="w-28 bg-transparent text-text focus:outline-none border-b border-white/10"
                />
              ) : (
                <input
                  aria-label="Filter value"
                  type="number"
                  value={Number(f.value)}
                  onChange={(e) => updateFilter(i, { value: Number(e.target.value) })}
                  className="w-16 bg-transparent text-text focus:outline-none border-b border-white/10"
                />
              )}
              <button
                type="button"
                aria-label="Remove filter"
                onClick={() => removeFilter(i)}
                className="text-text-muted hover:text-text"
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={addFilter}
            className="font-mono text-[11px] rounded-md border border-dashed border-white/20 text-text-muted px-2 py-1 hover:text-text"
          >
            + add filter
          </button>
          <span className="font-mono text-[11px] text-text-muted ml-auto" aria-live="polite">
            {data.match_count} match{data.match_count === 1 ? "" : "es"}
            {loading ? " · …" : ""}
          </span>
        </div>

        <div className="flex items-center justify-between mt-3 mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
            Score weighting — this screen&apos;s own ranking
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
                onChange={(e) =>
                  patch({ weights: { ...config.weights, [k]: Number(e.target.value) } })
                }
                className="w-full accent-green"
                aria-label={`${k} weight`}
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

        <div className="flex gap-2 mt-3">
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
            <Link href={saveLink} className="font-mono text-[11px] text-green px-2 py-1.5 underline">
              saved → {saveLink}
            </Link>
          )}
          {shareMsg && (
            <span className="font-mono text-[11px] text-text-muted px-2 py-1.5" aria-live="polite">
              {shareMsg}
            </span>
          )}
        </div>
      </details>

      <div className="font-mono text-[10.5px] text-text-muted mb-2 flex justify-between flex-wrap gap-1.5">
        <span>
          {data.match_count} companies · top {Math.min(config.topN, data.match_count)} feed your
          buyer · re-ranks live · {data.total_universe} in universe
        </span>
        <span className="text-green">filters &amp; weights live in this URL</span>
      </div>

      {/* ---- Results ---- */}
      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full border-collapse" aria-label="Screened equities, ranked by your composite score">
          <thead>
            <tr className="bg-white/[0.02]">
              <Th className="text-left w-8">#</Th>
              <Th className="text-left">Ticker</Th>
              <Th>Score</Th>
              <Th>P/S</Th>
              <Th>Rev gr%</Th>
              <Th>GM%</Th>
              <Th>FCF M%</Th>
              <Th>R40</Th>
              <Th>52w%</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <RowView key={r.ticker} r={r} cut={i === data.cut_index && data.cut_index < rows.length} dim={i >= data.cut_index} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-sm text-text-muted">
                  No matches — loosen your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-white/10 mt-5 pt-4">
        <p className="font-mono text-[10.5px] text-text-muted">
          Ranked by your configured composite · a research tool, not a
          recommendation · paper-trading only, not financial advice.
        </p>
      </footer>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`font-mono text-[10px] tracking-[0.04em] text-text-muted font-normal px-2.5 py-2 text-right ${className}`}
    >
      {children}
    </th>
  );
}

function RowView({ r, cut, dim }: { r: Row; cut: boolean; dim: boolean }) {
  return (
    <>
      {cut && (
        <tr aria-hidden>
          <td colSpan={9} className="px-2.5 py-1 bg-green/[0.06] border-t border-green/30">
            <span className="font-mono text-[10px] text-green">
              ── cut line: above feeds your buyer · below is ranked, not bought ──
            </span>
          </td>
        </tr>
      )}
      <tr className={dim ? "opacity-45" : ""}>
        <td className="px-2.5 py-2 text-left font-mono text-text-muted text-xs border-t border-white/10">
          {r.rank}
        </td>
        <td className="px-2.5 py-2 text-left border-t border-white/10">
          <Link href={`/company/${r.ticker}`} className="hover:text-green">
            <span className="font-mono text-text text-[12.5px]">{r.ticker}</span>{" "}
            <span className="text-[11px] text-text-muted">{r.name}</span>
          </Link>
        </td>
        <Td className="text-green font-mono">{fmt(r.score, { dp: 1 })}</Td>
        <Td className="font-mono">{fmt(r.ps, { mult: true })}</Td>
        <Td className="font-mono text-green">{fmt(r.rev_growth_ttm, { pct: true })}</Td>
        <Td className="font-mono text-green">{fmt(r.gross_margin, { pct: true })}</Td>
        <Td className="font-mono text-green">{fmt(r.fcf_margin, { pct: true })}</Td>
        <Td className="font-mono text-green">{fmt(r.rule_of_40, { dp: 0 })}</Td>
        <Td className="font-mono">{fmt(r.ret_52w, { pct: true, dp: 0 })}</Td>
      </tr>
    </>
  );
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2.5 py-2 text-right text-[12.5px] border-t border-white/10 ${className}`}>{children}</td>;
}

function topWeight(w: { quality: number; value: number; momentum: number }): string {
  const entries = Object.entries(w) as [string, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}
