"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveScreen } from "@/lib/screen/saved-mutations";
import {
  excludeFromScreener,
  unexcludeFromScreener,
} from "@/lib/screen/exclusions-mutations";
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
  screenConfigSchema,
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
  industry: string | null;
  country: string | null;
  price: number | null;
  price_asof: string | null;
  score: number;
  ps: number | null;
  rev_growth_ttm: number | null;
  gross_margin: number | null;
  fcf_margin: number | null;
  net_margin: number | null;
  operating_margin: number | null;
  rule_of_40: number | null;
  ret_52w: number | null;
  perf_52w_vs_spy: number | null;
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
// Percent with an explicit sign — for signed metrics (returns, alpha) where the
// direction is the point.
function fmtSigned(v: number | null, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}
const PAGE_SIZE = 250;
// localStorage key for the viewer's chosen extra result columns (survives refresh).
const COLS_STORAGE_KEY = "alphamolt:screener:cols";
// localStorage key for the viewer's last screen recipe (filters/weights), so a
// bare /screener visit restores it instead of resetting to the default preset.
const CONFIG_STORAGE_KEY = "alphamolt:screener:config";
// localStorage key for the viewer's CUSTOM recipe specifically — remembered
// independently of the active preset, so switching to a house preset and back
// to "Custom" restores the filters/weights they'd set (not the preset's).
const CUSTOM_STORAGE_KEY = "alphamolt:screener:custom";

/** The "Custom" preset is anything that isn't an unmodified house preset:
 *  an explicit `custom`, an empty preset, or an unknown id. Drives both the
 *  Custom card's active state and whether the editable filter bar shows. */
function isCustomConfig(c: ScreenConfig): boolean {
  return !c.preset || c.preset === "custom" || !PRESETS[c.preset];
}

// Hover explanations for the result columns (header mouseover).
const COL_HELP: Record<string, string> = {
  ps: "Price-to-sales — market cap ÷ trailing-12-month revenue. Lower is cheaper on sales.",
  rev_growth_ttm: "Revenue growth — trailing twelve months, year over year.",
  gross_margin: "Gross margin — gross profit ÷ revenue.",
  rule_of_40:
    "Rule of 40 — revenue growth % + free-cash-flow margin %. ≥ 40 is the bar for a healthy growth-vs-profitability balance.",
  fcf_margin: "Free-cash-flow margin — free cash flow ÷ revenue.",
  ret_52w: "Trailing 52-week price return — the raw move, not measured against the market.",
  perf_52w_vs_spy:
    "Alpha vs SPY — the stock's trailing 52-week return minus SPY's over the same window. Positive = beat the market. This is what the Momentum score ranks on.",
};

// Hover explanations for the (jargon-y) ranking controls.
const WEIGHT_HELP: Record<"quality" | "value" | "momentum", string> = {
  quality:
    "Quality — how strong the business is: 0.60×Rule of 40 + 0.25×free-cash-flow margin + 0.15×gross margin, scored as percentiles within the filtered set. Raise it to favour profitable, efficient compounders.",
  value:
    "Value — how cheap it is on sales versus the stock's own 12-month median P/S (not an absolute P/S). Raise it to favour names trading below their usual valuation.",
  momentum:
    "Momentum — trailing 52-week return vs SPY (alpha), collared so falling knives and blow-off tops don't dominate. Raise it to favour names beating the market.",
};
const RANKING_HELP =
  "Each name's Score is a percentile blend of Quality, Value and Momentum, weighted by these sliders, relative to the names matching your filters — so it's this screen's own ranking, not a fixed house score.";
const AI_HELP =
  "Multiply each Score by the AI bull/bear verdict: dual-positive ×1.30, story-but-red-flags ×0.70, avoid ×0.40, sound-or-unrated ×1.00. Uncheck to ignore the AI overlay.";
const TOPN_HELP =
  "The top N ranked names become your buyer's candidate pool — the cut line in the table. Only these feed the swarm.";

// How many visits the "how this works" intro auto-shows before it stays hidden.
const INTRO_MAX_VIEWS = 3;
const INTRO_KEY = "screenerIntroViews";

interface Col {
  key: string;
  label: string;
  green?: boolean; // force green text (a "more = better" metric)
  signed?: (r: Row) => number | null; // colour the cell green/red by this value's sign
  help?: string; // header mouseover explaining the column
  render: (r: Row) => string;
}
// "vs SPY" (alpha) is a base column: it's the Momentum driver, so showing it by
// default makes the ranking legible without opening the column picker.
const BASE_COLS: Col[] = [
  { key: "ps", label: "P/S", help: COL_HELP.ps, render: (r) => fmt(r.ps, { mult: true }) },
  { key: "rev_growth_ttm", label: "Rev gr%", green: true, help: COL_HELP.rev_growth_ttm, render: (r) => fmt(r.rev_growth_ttm, { pct: true }) },
  { key: "gross_margin", label: "GM%", green: true, help: COL_HELP.gross_margin, render: (r) => fmt(r.gross_margin, { pct: true }) },
  { key: "rule_of_40", label: "R40", green: true, help: COL_HELP.rule_of_40, render: (r) => fmt(r.rule_of_40, { dp: 0 }) },
  { key: "perf_52w_vs_spy", label: "vs SPY", help: COL_HELP.perf_52w_vs_spy, signed: (r) => r.perf_52w_vs_spy, render: (r) => fmtSigned(r.perf_52w_vs_spy) },
];
const EXTRA_COLS: Col[] = [
  { key: "fcf_margin", label: "FCF M%", green: true, help: COL_HELP.fcf_margin, render: (r) => fmt(r.fcf_margin, { pct: true }) },
  { key: "ret_52w", label: "52w%", help: COL_HELP.ret_52w, signed: (r) => r.ret_52w, render: (r) => fmtSigned(r.ret_52w, 0) },
  { key: "net_margin", label: "Net M%", green: true, render: (r) => fmt(r.net_margin, { pct: true }) },
  { key: "operating_margin", label: "Op M%", green: true, render: (r) => fmt(r.operating_margin, { pct: true }) },
  { key: "price", label: "Price", render: (r) => (r.price == null ? "—" : `$${r.price.toFixed(2)}`) },
  { key: "sector", label: "Sector", render: (r) => r.sector ?? "—" },
  { key: "country", label: "Country", render: (r) => r.country ?? "—" },
  { key: "industry", label: "Industry", render: (r) => r.industry ?? "—" },
];

export default function ScreenerClient({
  initialConfig,
  initialData,
  sectors = [],
  companyTickers = [],
  exclusions = [],
}: {
  initialConfig: ScreenConfig;
  initialData: ScreenData;
  /** Distinct sectors for the sector filter dropdown. */
  sectors?: string[];
  /** Tickers that have a /company/<ticker> page (others render unlinked). */
  companyTickers?: string[];
  /** Tickers on the manual 1-year blocklist (owner-managed). */
  exclusions?: string[];
  defaultEncoded?: string;
}) {
  const linkable = useMemo(
    () => new Set(companyTickers.map((t) => t.toUpperCase())),
    [companyTickers],
  );
  const [config, setConfig] = useState<ScreenConfig>(initialConfig);
  // The remembered Custom recipe — restored when the Custom card is picked.
  // Seeded from the initial config if it's already custom, else a blank canvas
  // (no filters, balanced default weights).
  const [customConfig, setCustomConfig] = useState<ScreenConfig>(() =>
    isCustomConfig(initialConfig)
      ? { ...initialConfig, preset: "custom" }
      : screenConfigSchema.parse({ preset: "custom" }),
  );
  const [data, setData] = useState<ScreenData>(initialData);
  const [loading, setLoading] = useState(false);
  const [excluded, setExcluded] = useState<string[]>(exclusions);
  const [exclBusy, setExclBusy] = useState(false);
  const [exclMsg, setExclMsg] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [saveLink, setSaveLink] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [extraCols, setExtraCols] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const firstRender = useRef(true);
  const colsHydrated = useRef(false);
  const configHydrated = useRef(false);
  const customHydrated = useRef(false);

  // Render only the first chunk; "Load more" reveals more from memory. Reset to
  // the first page whenever the ranking changes.
  useEffect(() => setVisible(PAGE_SIZE), [data]);

  // The chosen extra columns are a per-viewer VIEW preference (not part of the
  // shareable screen recipe), so they persist in localStorage rather than the
  // URL — otherwise a refresh silently drops them. Hydrate after mount (so the
  // server/client first paint match), then mirror every change back.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE_KEY);
      if (raw) {
        const keys = (JSON.parse(raw) as string[]).filter((k) =>
          EXTRA_COLS.some((c) => c.key === k),
        );
        if (keys.length) setExtraCols(new Set(keys));
      }
    } catch {
      /* ignore malformed/blocked storage — just start with no extra columns */
    }
    colsHydrated.current = true;
  }, []);

  useEffect(() => {
    if (!colsHydrated.current) return; // don't overwrite storage with the pre-hydration empty set
    try {
      localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify([...extraCols]));
    } catch {
      /* storage unavailable (private mode / quota) — non-fatal */
    }
  }, [extraCols]);

  // The filters/weights ARE the shareable recipe, so an explicit URL
  // (?config/?preset/?screen/?sector) always wins. But on a bare /screener
  // visit (e.g. the nav link), restore the viewer's last screen from
  // localStorage — otherwise navigating back silently resets to the default
  // preset and the filters appear "dropped". Hydrate after mount, then mirror.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const bare = !["config", "preset", "sector", "screen"].some((k) =>
        params.has(k),
      );
      if (bare) {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (raw) {
          const parsed = screenConfigSchema.safeParse(JSON.parse(raw));
          if (parsed.success) setConfig(parsed.data);
        }
      }
    } catch {
      /* malformed/blocked storage — keep the URL/default config */
    }
    configHydrated.current = true;
  }, []);

  useEffect(() => {
    if (!configHydrated.current) return; // don't save the default over a restored screen
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [config]);

  // The Custom recipe is remembered separately so it survives switching to a
  // house preset and back (and a refresh). Hydrate after mount, then mirror.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
      if (raw) {
        const parsed = screenConfigSchema.safeParse(JSON.parse(raw));
        if (parsed.success) setCustomConfig({ ...parsed.data, preset: "custom" });
      }
    } catch {
      /* malformed/blocked storage — keep the seeded custom config */
    }
    customHydrated.current = true;
  }, []);

  // Keep the remembered Custom recipe in sync whenever the user is editing in
  // custom mode; picking a house preset leaves it untouched (so it's there to
  // restore). Mirror to storage once hydrated.
  useEffect(() => {
    if (!customHydrated.current) return;
    if (!isCustomConfig(config)) return;
    setCustomConfig(config);
    try {
      localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [config]);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
  }, []);

  // Show the "how this works" intro the first few visits, then leave it hidden
  // (re-openable via the small link). Tracked client-side in localStorage.
  useEffect(() => {
    try {
      const n = Number(localStorage.getItem(INTRO_KEY) ?? "0");
      if (n < INTRO_MAX_VIEWS) {
        setShowIntro(true);
        localStorage.setItem(INTRO_KEY, String(n + 1));
      }
    } catch {
      /* localStorage unavailable — just skip the intro */
    }
  }, []);

  function dismissIntro() {
    setShowIntro(false);
    try {
      localStorage.setItem(INTRO_KEY, String(INTRO_MAX_VIEWS));
    } catch {
      /* ignore */
    }
  }

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

  // Re-fetch the current screen — used after an exclusion changes the universe.
  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/screen?config=${encodeConfig(config)}`, {
        cache: "no-store",
      });
      if (res.ok) setData((await res.json()) as ScreenData);
    } finally {
      setLoading(false);
    }
  }, [config]);

  const excludedSet = useMemo(
    () => new Set(excluded.map((t) => t.toUpperCase())),
    [excluded],
  );

  // Rows actually shown: drop any optimistically-excluded ticker. In steady
  // state the server already filtered these, so this only hides the just-
  // clicked name in the window before the refetch settles.
  const rows = useMemo(
    () =>
      excludedSet.size
        ? data.rows.filter((r) => !excludedSet.has(r.ticker.toUpperCase()))
        : data.rows,
    [data.rows, excludedSet],
  );

  // Optimistic: hide the row immediately (excludedSet filters the table), then
  // persist. Roll back + surface the reason on failure so it's never silent.
  async function onExclude(ticker: string) {
    const t = ticker.toUpperCase();
    if (excludedSet.has(t)) return;
    setExclMsg(null);
    setExcluded((prev) => Array.from(new Set([...prev, t])));
    setExclBusy(true);
    try {
      const res = await excludeFromScreener(t);
      if (res.ok) {
        await refetch();
      } else {
        setExcluded((prev) => prev.filter((x) => x.toUpperCase() !== t));
        setExclMsg(res.error || `Couldn’t remove ${t} — try again.`);
      }
    } catch {
      setExcluded((prev) => prev.filter((x) => x.toUpperCase() !== t));
      setExclMsg(`Couldn’t remove ${t} — are you signed in?`);
    } finally {
      setExclBusy(false);
    }
  }

  async function onRestore(ticker: string) {
    const t = ticker.toUpperCase();
    setExclMsg(null);
    setExcluded((prev) => prev.filter((x) => x.toUpperCase() !== t));
    setExclBusy(true);
    try {
      const res = await unexcludeFromScreener(t);
      if (res.ok) {
        await refetch();
      } else {
        setExcluded((prev) => Array.from(new Set([...prev, t])));
        setExclMsg(res.error || `Couldn’t restore ${t} — try again.`);
      }
    } catch {
      setExcluded((prev) => Array.from(new Set([...prev, t])));
      setExclMsg(`Couldn’t restore ${t} — try again.`);
    } finally {
      setExclBusy(false);
    }
  }

  function selectPreset(id: string) {
    setConfig(presetConfig(id));
    setSaveLink(null);
  }

  // Picking the Custom card restores the remembered custom recipe (filters +
  // weights), so it reappears exactly as the viewer left it.
  function selectCustom() {
    setConfig({ ...customConfig, preset: "custom" });
    setSaveLink(null);
  }

  // The editable filter bar only shows in custom mode; a house preset hides it.
  const customSelected = isCustomConfig(config);

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
      {/* How this works — a dismissible intro shown the first few visits; it
          explains that this page defines the universe the trader bots buy from.
          After that it collapses to a small re-openable link. */}
      {showIntro ? (
        <IntroPopout topN={config.topN} runHref={runHref} onDismiss={dismissIntro} />
      ) : (
        <button
          type="button"
          onClick={() => setShowIntro(true)}
          className="mb-4 inline-flex items-center gap-1.5 font-mono text-[10.5px] text-text-muted hover:text-text"
        >
          <span aria-hidden>ⓘ</span> How this works
        </button>
      )}

      {/* Presets — the prominent way in. Custom is one of the cards. */}
      <PresetCards
        activePreset={config.preset}
        customActive={customSelected}
        onSelect={selectPreset}
        onSelectCustom={selectCustom}
      />

      {/* Screen bar: friendly filter chips + collapsed weighting on the right.
          Only shown in Custom mode — house presets define their own filters. */}
      {customSelected && (
      <div className="flex items-start gap-2 flex-wrap mt-3.5 mb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted mt-2">
          Filters
        </span>

        {config.filters.map((f, i) => (
          <FilterChip
            key={`${f.field}-${i}`}
            filter={f}
            sectors={sectors}
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
            {/* Numeric metrics dedupe (one P/S filter is enough); Sector stays
                addable so you can exclude several sectors at once. */}
            {NAMED_FILTERS.filter(
              (nf) => nf.field === "sector" || !usedFields.has(nf.field),
            ).map((nf) => (
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
      )}

      {/* Read-only preset filters — so picking a house preset still shows what
          it actually screens on (the editable bar is Custom-only). "Edit →"
          forks the preset into Custom carrying these filters. */}
      {!customSelected && (
        <div className="flex items-center gap-2 flex-wrap mt-3.5 mb-2">
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
            Filters
          </span>
          {config.filters.length > 0 ? (
            config.filters.map((f, i) => (
              <span
                key={`${f.field}-${i}`}
                className="font-mono text-[11px] text-text border border-white/10 bg-white/[0.03] rounded-md px-2.5 py-1.5"
              >
                {filterChipLabel(f)}
              </span>
            ))
          ) : (
            <span className="font-mono text-[11px] text-text-muted">
              None — ranks the entire universe, scored by the weighting below.
            </span>
          )}
          <button
            type="button"
            onClick={() => patch({})}
            title="Switch to Custom with these filters so you can edit them"
            className="ml-1 font-mono text-[10.5px] text-[var(--color-cyan)] hover:underline"
          >
            Edit →
          </button>
        </div>
      )}

      {/* Advanced raw add row */}
      {customSelected && advancedOpen && (
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

      {/* Hidden names — the owner's manual 1-year blocklist. Removed names
          drop from the screener AND the agents' candidate pool until they
          expire (or are restored here). */}
      {signedIn && excluded.length > 0 && (
        <details className={`mb-2 ${card}`}>
          <summary className="list-none cursor-pointer font-mono text-[11px] text-text-muted px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden flex items-center justify-between">
            <span>
              🚫 Hidden ({excluded.length}) — removed from screener &amp; agents
              for 1 year
            </span>
            <span className="text-text-muted/60">manage ▾</span>
          </summary>
          <div className="px-3 pb-3 flex flex-wrap gap-1.5">
            {[...excludedSet].sort().map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text border border-white/10 bg-white/[0.03] rounded-md px-2 py-1"
              >
                {t}
                <button
                  type="button"
                  disabled={exclBusy}
                  onClick={() => onRestore(t)}
                  title={`Restore ${t} to the screener now`}
                  aria-label={`Restore ${t}`}
                  className="text-[var(--color-cyan)] hover:underline disabled:opacity-40"
                >
                  restore
                </button>
              </span>
            ))}
          </div>
        </details>
      )}

      {/* Surfaced error from a remove/restore (e.g. not signed in, or the
          screener_exclusions table isn't there yet) — never fail silently. */}
      {exclMsg && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3 py-2 font-mono text-[11px] text-[var(--color-red,#FF3333)]"
        >
          <span>{exclMsg}</span>
          <button
            type="button"
            onClick={() => setExclMsg(null)}
            aria-label="Dismiss"
            className="text-text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      )}

      {/* Results */}
      <div className={`${card} overflow-hidden`}>
        <table className="w-full border-collapse" aria-label="Screened equities ranked by your composite">
          <thead>
            <tr className="bg-white/[0.02]">
              <Th className="text-left w-7">#</Th>
              <Th className="text-left">Ticker</Th>
              <Th help={RANKING_HELP}>Score</Th>
              {cols.map((c) => (
                <Th key={c.key} help={c.help}>{c.label}</Th>
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
            {rows.slice(0, visible).map((r, i) => (
              <RowView
                key={r.ticker}
                r={r}
                cols={cols}
                cut={i === data.cut_index && data.cut_index < rows.length}
                dim={i >= data.cut_index}
                spanCols={metricColCount + 3}
                topN={config.topN}
                runHref={runHref}
                hasPage={linkable.has(r.ticker.toUpperCase())}
                canExclude={signedIn}
                exclBusy={exclBusy}
                onExclude={onExclude}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={metricColCount + 3} className="p-6 text-center text-sm text-text-muted">
                  No matches — loosen your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > visible && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="font-mono text-[11px] rounded-md border border-white/10 text-text-muted px-4 py-2 hover:text-text hover:border-white/25"
          >
            Load {Math.min(PAGE_SIZE, rows.length - visible)} more
          </button>
          <span className="font-mono text-[10.5px] text-text-muted">
            showing {visible} of {rows.length}
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
/**
 * First-visits intro: spells out that the screener defines the universe the
 * portfolio's trader bots pick from, with the compact Screen → Portfolio flow.
 */
function IntroPopout({
  topN,
  runHref,
  onDismiss,
}: {
  topN: number;
  runHref: string;
  onDismiss: () => void;
}) {
  return (
    <div className="relative mb-4 rounded-xl border border-[var(--color-cyan)]/40 bg-[var(--color-cyan)]/[0.05] p-4">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-2.5 text-text-muted hover:text-text text-sm"
      >
        ✕
      </button>
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-cyan)] mb-1">
        How this works
      </div>
      <p className="text-sm font-bold text-text">This is your trading universe.</p>
      <p className="text-[12.5px] text-text-dim mt-1 leading-relaxed max-w-prose">
        The screener ranks every US-listed stock by the filters and scoring you
        set. The top {topN} become the universe your portfolio&apos;s trader bots
        pick from — so what you choose here shapes what they&apos;re allowed to
        buy.
      </p>
      <div className="mt-3 flex items-center gap-2 flex-wrap font-mono text-[11px]">
        <span className="rounded-md border border-[var(--color-cyan)]/45 bg-[var(--color-cyan)]/[0.06] px-2.5 py-1 text-[var(--color-cyan)]">
          This screen
        </span>
        <span className="text-text-muted">→ top {topN} →</span>
        <span className="rounded-md border border-green/45 bg-green/[0.06] px-2.5 py-1 text-green">
          Your portfolio
        </span>
        <Link href={runHref} className="ml-1 text-green hover:underline">
          Run this screen as a portfolio →
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 font-mono text-[10.5px] text-text-muted hover:text-text"
      >
        Got it — don&apos;t show this again
      </button>
    </div>
  );
}

/** Prominent preset picker — cards, not pills. The primary way into a screen.
 *  "Custom" is one of the cards: picking it restores the viewer's own filters
 *  + weights and reveals the editable filter bar. */
function PresetCards({
  activePreset,
  customActive,
  onSelect,
  onSelectCustom,
}: {
  activePreset?: string;
  customActive: boolean;
  onSelect: (id: string) => void;
  onSelectCustom: () => void;
}) {
  const presets = Object.values(PRESETS);
  return (
    <div className="mb-4">
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
        Start from a preset
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {presets.map((p) => {
          const active = !customActive && activePreset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              aria-pressed={active}
              className={`text-left rounded-xl border p-3.5 transition-colors ${
                active
                  ? "border-[var(--color-cyan)]/60 bg-[var(--color-cyan)]/[0.08]"
                  : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/20"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`font-semibold text-[13.5px] ${active ? "text-[var(--color-cyan)]" : "text-text"}`}
                >
                  {p.label}
                </span>
                {active && (
                  <span className="text-[var(--color-cyan)] text-[11px]" aria-hidden>
                    ●
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-muted mt-1 leading-relaxed line-clamp-2">
                {p.description}
              </p>
            </button>
          );
        })}

        {/* Custom — restores the viewer's own filters/weights and opens the
            editable filter bar below. */}
        <button
          type="button"
          onClick={onSelectCustom}
          aria-pressed={customActive}
          className={`text-left rounded-xl border p-3.5 transition-colors ${
            customActive
              ? "border-[var(--color-cyan)]/60 bg-[var(--color-cyan)]/[0.08]"
              : "border-dashed border-white/15 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/25"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className={`font-semibold text-[13.5px] ${customActive ? "text-[var(--color-cyan)]" : "text-text"}`}
            >
              Custom
            </span>
            {customActive && (
              <span className="text-[var(--color-cyan)] text-[11px]" aria-hidden>
                ●
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-muted mt-1 leading-relaxed line-clamp-2">
            Your own filters &amp; weights — build a screen from scratch.
          </p>
        </button>
      </div>
    </div>
  );
}

function FilterChip({
  filter,
  sectors,
  onChange,
  onRemove,
}: {
  filter: Filter;
  sectors: string[];
  onChange: (p: Partial<Filter>) => void;
  onRemove: () => void;
}) {
  const isText = TEXT_FIELDS.has(filter.field);
  const isSector = filter.field === "sector";
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
            {isSector
              ? "Sector"
              : `${m?.label ?? filter.field} ${m?.op === "<=" ? "below" : "above"}`}
          </span>
          <span className="text-[var(--color-cyan)]">
            {isSector
              ? filter.op === "!="
                ? "exclude"
                : "only"
              : `${filter.value}${m?.unit ?? ""}`}
          </span>
        </div>
        {isSector && sectors.length > 0 ? (
          <>
            {/* Include (only) vs exclude (not) this sector. */}
            <div className="flex gap-1 mb-2 font-mono text-[10px]">
              <button
                type="button"
                onClick={() => onChange({ op: "==" })}
                className={`flex-1 rounded px-2 py-1 border transition-colors ${
                  filter.op !== "!="
                    ? "border-[var(--color-cyan)]/50 text-[var(--color-cyan)] bg-[var(--color-cyan)]/10"
                    : "border-white/10 text-text-muted hover:text-text"
                }`}
              >
                Only
              </button>
              <button
                type="button"
                onClick={() => onChange({ op: "!=" })}
                className={`flex-1 rounded px-2 py-1 border transition-colors ${
                  filter.op === "!="
                    ? "border-[var(--color-red)]/50 text-[var(--color-red)] bg-[var(--color-red)]/10"
                    : "border-white/10 text-text-muted hover:text-text"
                }`}
              >
                Exclude
              </button>
            </div>
            <select
              aria-label="Sector"
              value={String(filter.value ?? "")}
              onChange={(e) => onChange({ value: e.target.value })}
              className="w-full bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-text"
            >
              <option value="">Any sector…</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        ) : isText ? (
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

function Th({
  children,
  className = "",
  help,
}: {
  children: React.ReactNode;
  className?: string;
  help?: string;
}) {
  return (
    <th className={`font-mono text-[10px] tracking-[0.04em] text-text-muted font-normal px-2 py-2.5 text-right ${className}`}>
      {help ? (
        <span
          title={help}
          className="cursor-help underline decoration-dotted decoration-white/25 underline-offset-2"
        >
          {children}
        </span>
      ) : (
        children
      )}
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
  hasPage,
  canExclude,
  exclBusy,
  onExclude,
}: {
  r: Row;
  cols: Col[];
  cut: boolean;
  dim: boolean;
  spanCols: number;
  topN: number;
  runHref: string;
  hasPage: boolean;
  /** Owner-only: show the ✕ "remove from screener for a year" control. */
  canExclude: boolean;
  exclBusy: boolean;
  onExclude: (ticker: string) => void;
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
          {hasPage ? (
            <Link href={`/company/${r.ticker}`} className="hover:text-[var(--color-cyan)]">
              <span className="font-mono text-text text-[12.5px]">{r.ticker}</span>{" "}
              <span className="text-[11px] text-text-muted">{r.name}</span>
            </Link>
          ) : (
            <span title="No analysis page for this name yet">
              <span className="font-mono text-text text-[12.5px]">{r.ticker}</span>{" "}
              <span className="text-[11px] text-text-muted">{r.name}</span>
            </span>
          )}
        </td>
        <td className="px-2 py-2.5 text-right text-[12.5px] font-mono border-t border-white/10 text-[var(--color-cyan)]">
          {fmt(r.score, { dp: 1 })}
        </td>
        {cols.map((c) => {
          const sv = c.signed ? c.signed(r) : null;
          const tone = c.signed
            ? sv == null
              ? "text-text-muted"
              : sv >= 0
                ? "text-green"
                : "text-[var(--color-red,#FF3333)]"
            : c.green
              ? "text-green"
              : "text-text";
          return (
            <td
              key={c.key}
              className={`px-2 py-2.5 text-right text-[12.5px] font-mono border-t border-white/10 ${tone}`}
            >
              {c.render(r)}
            </td>
          );
        })}
        <td className="border-t border-white/10 text-right pr-2">
          {canExclude && (
            <button
              type="button"
              disabled={exclBusy}
              onClick={() => onExclude(r.ticker)}
              title={`Remove ${r.ticker} from the screener for 1 year — also blocks the agents from buying it`}
              aria-label={`Remove ${r.ticker} for a year`}
              className="font-mono text-[12px] text-text-muted/50 hover:text-[var(--color-red,#FF3333)] disabled:opacity-40"
            >
              ✕
            </button>
          )}
        </td>
      </tr>
    </>
  );
}
