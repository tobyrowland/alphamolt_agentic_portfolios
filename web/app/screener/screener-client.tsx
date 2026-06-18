"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveScreen } from "@/lib/screen/saved-mutations";
import {
  excludeFromScreener,
  unexcludeFromScreener,
} from "@/lib/screen/exclusions-mutations";
import { restoreRejection } from "@/lib/screen/rejections-mutations";
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
import { BUDGET, type ResearchCard } from "@/lib/screen/score";
import type { ScreenHolding } from "@/lib/screen/holdings-query";

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
  ps_median_12m: number | null;
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
  // Single-score fields (migration 057).
  base_z: number;
  adj_z: number;
  moat_z: number;
  earn_z: number;
  break_z: number;
  base_pct: number;
  final_pct: number;
  capped: boolean;
  floored: boolean;
  quality_score: number | null;
  moat_score: number | null;
  earnings_score: number | null;
  growth_score: number | null;
  break_count: number | null;
  has_card: boolean;
  research_card: ResearchCard | null;
  industry_ps_median: number | null;
  sector_ps_median: number | null;
  peer_ps_median: number | null;
  peer_basis: string | null;
}
interface ScreenData {
  rows: Row[];
  match_count: number;
  total_universe: number;
  cut_index: number;
  data_asof: string | null;
  /** Viewer's active per-portfolio rejections (migration 051); only the
   *  /api/screen route populates this (SSR is anonymous). */
  rejected?: RejectedName[];
}

interface RejectedName {
  ticker: string;
  rejected_at: string;
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
// Default portfolio for the read-only holdings overlay (brief §4).
const DEFAULT_PORTFOLIO = "test-portfolio-toby";
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
  "Each name's Score is a single number: a cross-sectional z-score blend of Quality, Value and Momentum (the 'base'), adjusted by the AI's read of durability, shown as a universe percentile. A research tool, not a recommendation.";
const AI_HELP =
  "AI authority is the maximum the research card can move a name, in standard deviations: a strong, unbroken card lifts up to +0.7σ; a weak moat or break signals cut it (floored at −1.5σ). Fixed server-side so the ranking stays canonical — growth durability is never scored (already in R40).";
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
  rejections = [],
}: {
  initialConfig: ScreenConfig;
  initialData: ScreenData;
  /** Distinct sectors for the sector filter dropdown. */
  sectors?: string[];
  /** Tickers that have a /company/<ticker> page (others render unlinked). */
  companyTickers?: string[];
  /** Tickers on the manual 1-year blocklist (owner-managed). */
  exclusions?: string[];
  /** Names this portfolio's buyer evaluated and passed on (migration 051). */
  rejections?: RejectedName[];
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
  // Per-portfolio agent rejections (migration 051) — folded into the Hidden
  // panel, each tagged with its rejection date.
  const [rejected, setRejected] = useState<RejectedName[]>(rejections);
  const [rejBusy, setRejBusy] = useState(false);
  const [rejMsg, setRejMsg] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [saveLink, setSaveLink] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [extraCols, setExtraCols] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  // View filters (redesign brief §3/§4) — purely client-side, never bust cache.
  const [view, setView] = useState<"all" | "researched">("all");
  const [moatOnly, setMoatOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  // Read-only holdings overlay, per selected portfolio (brief §4). Default to
  // the house test portfolio; resolved client-side after paint so the cached
  // page is identical for everyone.
  const [portfolioSlug, setPortfolioSlug] = useState(DEFAULT_PORTFOLIO);
  const [holdings, setHoldings] = useState<Record<string, ScreenHolding>>({});
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
        if (res.ok) {
          const json = (await res.json()) as ScreenData;
          setData(json);
          if (json.rejected) setRejected(json.rejected);
        }
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

  // Re-fetch the current screen — used after an exclusion/rejection changes the
  // universe, and once on sign-in (so /api/screen applies the viewer's
  // per-portfolio rejection hide and returns the restore list).
  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/screen?config=${encodeConfig(config)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as ScreenData;
        setData(json);
        if (json.rejected) setRejected(json.rejected);
      }
    } finally {
      setLoading(false);
    }
  }, [config]);

  // Once we learn the viewer is signed in, refetch so rejections (migration
  // 051) are applied + loaded. SSR is anonymous, so this is the logged-in
  // owner's first filtered view. Fires once.
  const signinRefetched = useRef(false);
  useEffect(() => {
    if (signedIn && !signinRefetched.current) {
      signinRefetched.current = true;
      void refetch();
    }
  }, [signedIn, refetch]);

  // Holdings overlay: fetch per selected portfolio AFTER the cached page paints
  // (brief §4). Never via the matview/ISR cache — holdings are portfolio-
  // specific and live. Tag held names with break signals as "review".
  useEffect(() => {
    let cancelled = false;
    if (!portfolioSlug) {
      setHoldings({});
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `/api/screen/holdings?portfolio=${encodeURIComponent(portfolioSlug)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const json = (await res.json()) as {
          holdings?: Record<string, ScreenHolding>;
        };
        if (cancelled) return;
        const h = json.holdings ?? {};
        // Mark held names whose card has break signals as "review" (amber).
        const breakSet = new Set(
          data.rows
            .filter((r) => (r.break_count ?? 0) > 0)
            .map((r) => r.ticker.toUpperCase()),
        );
        for (const k of Object.keys(h)) {
          if (h[k].state === "held" && breakSet.has(k)) h[k].has_break_signals = true;
        }
        setHoldings(h);
      } catch {
        /* overlay is best-effort — leave it empty on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [portfolioSlug, data.rows]);

  const excludedSet = useMemo(
    () => new Set(excluded.map((t) => t.toUpperCase())),
    [excluded],
  );

  // One unified "Hidden" list: manual exclusions (reason "manual", global,
  // 1-year) + this portfolio's agent rejections (reason = the rejection date),
  // each restorable via the matching action. Agent rejections only count as
  // "hidden" while the toggle is on (off → they show in the table, so they
  // aren't hidden). Manual takes precedence if a ticker is both.
  const hiddenEntries = useMemo(() => {
    const manual = [...excludedSet].map((t) => ({
      ticker: t,
      source: "manual" as const,
      reason: "manual",
    }));
    const manualSet = new Set(manual.map((m) => m.ticker));
    const agent =
      config.hideRejected !== false
        ? rejected
            .filter((r) => !manualSet.has(r.ticker.toUpperCase()))
            .map((r) => ({
              ticker: r.ticker.toUpperCase(),
              source: "agent" as const,
              reason: `rejected ${
                Number.isNaN(Date.parse(r.rejected_at))
                  ? ""
                  : new Date(r.rejected_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
              }`.trim(),
            }))
        : [];
    return [...manual, ...agent].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [excludedSet, rejected, config.hideRejected]);

  // Rows actually shown: drop optimistically-excluded tickers, then apply the
  // client-side view filters (researched-only, moat ≥ 4 with null=pass,
  // new-candidates hides held names). The moat filter NEVER hides an uncarded
  // name — a null card passes (brief §2/§10).
  const rows = useMemo(() => {
    let list = excludedSet.size
      ? data.rows.filter((r) => !excludedSet.has(r.ticker.toUpperCase()))
      : data.rows;
    if (view === "researched") list = list.filter((r) => r.has_card);
    if (moatOnly) list = list.filter((r) => !r.has_card || (r.moat_score ?? 0) >= 4);
    if (newOnly) {
      list = list.filter((r) => holdings[r.ticker.toUpperCase()]?.state !== "held");
    }
    return list;
  }, [data.rows, excludedSet, view, moatOnly, newOnly, holdings]);

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

  // Restore a name the portfolio's buyer passed on (migration 051): clears the
  // 90-day hide so it shows again and the buyer reconsiders it next run.
  async function onRestoreRejection(ticker: string) {
    const t = ticker.toUpperCase();
    const prior = rejected.find((x) => x.ticker.toUpperCase() === t);
    setRejMsg(null);
    setRejected((prev) => prev.filter((x) => x.ticker.toUpperCase() !== t));
    setRejBusy(true);
    const restore = () =>
      setRejected((prev) =>
        prev.some((x) => x.ticker.toUpperCase() === t)
          ? prev
          : [...prev, prior ?? { ticker: t, rejected_at: new Date().toISOString() }],
      );
    try {
      const res = await restoreRejection(t);
      if (res.ok) {
        await refetch();
      } else {
        restore();
        setRejMsg(res.error || `Couldn’t restore ${t} — try again.`);
      }
    } catch {
      restore();
      setRejMsg(`Couldn’t restore ${t} — are you signed in?`);
    } finally {
      setRejBusy(false);
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
            {" · "}AI ±{BUDGET}σ · top {config.topN} ▾
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
            <span
              title={AI_HELP}
              className="font-mono text-[10px] text-text-muted/70 cursor-help shrink-0"
            >
              AI authority ±{BUDGET}σ (fixed)
            </span>
          </div>
          <div className="flex items-center justify-end mt-2">
            <label
              title="Hide names your portfolio's buyer evaluated and passed on, for 90 days. Restore any of them in the panel below."
              className="font-mono text-[10.5px] text-[var(--color-cyan)] inline-flex items-center gap-1.5 cursor-help shrink-0"
            >
              <input
                type="checkbox"
                checked={config.hideRejected !== false}
                onChange={(e) => patch({ hideRejected: e.target.checked })}
                className="accent-[var(--color-cyan)]"
              />
              Hide agent-rejected (90d)
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

      {/* Hidden names — one list, two sources. Manual exclusions (reason
          "manual") are the owner's global 1-year blocklist; agent rejections
          (reason = the rejection date) are names this portfolio's buyer
          evaluated and passed on, hidden for 90 days while the toggle is on.
          Restore sends each to its matching action. */}
      {signedIn && hiddenEntries.length > 0 && (
        <details className={`mb-2 ${card}`}>
          <summary className="list-none cursor-pointer font-mono text-[11px] text-text-muted px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden flex items-center justify-between">
            <span>🚫 Hidden ({hiddenEntries.length}) — removed from the screener</span>
            <span className="text-text-muted/60">manage ▾</span>
          </summary>
          <div className="px-3 pb-3 flex flex-wrap gap-1.5">
            {hiddenEntries.map((h) => (
              <span
                key={h.ticker}
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-text border border-white/10 bg-white/[0.03] rounded-md px-2 py-1"
              >
                {h.ticker}
                <span
                  className="text-[10px] text-text-muted/70"
                  title={
                    h.source === "manual"
                      ? "Manually removed (global, 1 year)"
                      : "Your buyer evaluated and passed on this name (90-day hide)"
                  }
                >
                  {h.reason}
                </span>
                <button
                  type="button"
                  disabled={h.source === "manual" ? exclBusy : rejBusy}
                  onClick={() =>
                    h.source === "manual"
                      ? onRestore(h.ticker)
                      : onRestoreRejection(h.ticker)
                  }
                  title={`Restore ${h.ticker} to the screener now`}
                  aria-label={`Restore ${h.ticker}`}
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
          table isn't there yet) — never fail silently. */}
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

      {rejMsg && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-[var(--color-red,#FF3333)]/40 bg-[var(--color-red,#FF3333)]/[0.06] px-3 py-2 font-mono text-[11px] text-[var(--color-red,#FF3333)]"
        >
          <span>{rejMsg}</span>
          <button
            type="button"
            onClick={() => setRejMsg(null)}
            aria-label="Dismiss"
            className="text-text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      )}

      {/* View controls (client-side; never bust the cache) — researched-only,
          moat ≥ 4 (null passes), holdings portfolio + new-candidates. */}
      <div className="flex items-center gap-2 flex-wrap mb-2 font-mono text-[10.5px]">
        <div className="inline-flex rounded-md border border-white/10 overflow-hidden">
          {(["all", "researched"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`px-2.5 py-1 ${
                view === v
                  ? "bg-[var(--color-cyan)]/15 text-[var(--color-cyan)]"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {v === "all" ? "All names" : "Researched"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setMoatOnly((v) => !v)}
          aria-pressed={moatOnly}
          title="Keep names with an AI moat score of 4+ — un-researched names pass through (never hidden)."
          className={`rounded-md border px-2.5 py-1 ${
            moatOnly
              ? "border-[var(--color-cyan)]/50 text-[var(--color-cyan)] bg-[var(--color-cyan)]/10"
              : "border-white/10 text-text-muted hover:text-text"
          }`}
        >
          moat ≥ 4
        </button>
        <span className="ml-auto flex items-center gap-2">
          <label className="text-text-muted">
            Holdings:{" "}
            <input
              value={portfolioSlug}
              onChange={(e) => setPortfolioSlug(e.target.value.trim())}
              aria-label="Portfolio slug for the holdings overlay"
              className="w-[150px] bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-text"
            />
          </label>
          <button
            type="button"
            onClick={() => setNewOnly((v) => !v)}
            aria-pressed={newOnly}
            title="Hide names this portfolio already holds — show only new candidates."
            className={`rounded-md border px-2.5 py-1 ${
              newOnly
                ? "border-green/50 text-green bg-green/10"
                : "border-white/10 text-text-muted hover:text-text"
            }`}
          >
            new candidates
          </button>
        </span>
      </div>

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
              <Th
                className="text-left"
                help="AI durability — moat (scored), growth (read-only, in R40), earnings (scored), balance-sheet (gated). Compiled from the research card, never generated at render."
              >
                AI durability
              </Th>
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
                spanCols={metricColCount + 4}
                topN={config.topN}
                runHref={runHref}
                hasPage={linkable.has(r.ticker.toUpperCase())}
                canExclude={signedIn}
                exclBusy={exclBusy}
                onExclude={onExclude}
                holding={holdings[r.ticker.toUpperCase()] ?? null}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={metricColCount + 4} className="p-6 text-center text-sm text-text-muted">
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

// ---- single-score display helpers (mirror the v8 mockup) ------------------
const sgn = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

/** The signal chip text/tone for a carded row (brief §3). */
function sigOf(r: Row): [tone: string, label: string] | null {
  if (!r.has_card) return null;
  if ((r.break_count ?? 0) > 0) return ["flags", "AI flags"];
  if (r.base_pct < 60 && r.adj_z > 0) return ["turn", "turnaround"];
  if (r.capped || r.adj_z >= BUDGET * 0.8) return ["backs", "AI backs"];
  if (r.adj_z > 0) return ["lifts", "AI lifts"];
  return ["agrees", "AI agrees"];
}

const SIG_TONE: Record<string, string> = {
  flags: "text-[var(--color-red,#FF3333)] border-[var(--color-red,#FF3333)]/40",
  turn: "text-[var(--color-cyan)] border-[var(--color-cyan)]/40",
  backs: "text-green border-green/40",
  lifts: "text-green border-green/40",
  agrees: "text-text-muted border-white/15",
};

/** One scored dim's evidence/rationale → a compiled thesis line (brief §3:
 *  compile from stored evidence, never generate at render). */
function compileThesis(r: Row): string {
  if (r.has_card && r.research_card) {
    const c = r.research_card;
    const best = [c.moat, c.earnings_quality]
      .filter((d): d is NonNullable<typeof d> => !!d && !!d.rationale)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (best?.rationale) return best.rationale;
  }
  const sec = r.sector ?? "—";
  const ind = r.industry ?? "—";
  return `${sec} · ${ind} — ranked on quant only`;
}

/** Four micro-bars: moat (scored), growth (read-only), earnings (scored),
 *  balance-sheet (gated). Plus a break-signal pip + the signal chip. */
function DurabilityBadge({ r }: { r: Row }) {
  if (!r.has_card || !r.research_card) {
    return <span className="font-mono text-[10px] text-text-muted/50">—</span>;
  }
  const c = r.research_card;
  const bar = (score: number | null | undefined, kind: "scored" | "read" | "gated", tip: string) => {
    const h = score ? Math.max(2, Math.round((score / 5) * 14)) : 3;
    const cls =
      kind === "gated"
        ? "border border-dashed border-white/25 bg-transparent"
        : kind === "read"
          ? "bg-white/25"
          : "bg-[var(--color-cyan)]";
    return (
      <span title={tip} className="inline-flex items-end" style={{ height: 14 }}>
        <span className={`inline-block w-[5px] rounded-[1px] ${cls}`} style={{ height: h }} />
      </span>
    );
  };
  const sig = sigOf(r);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-end gap-[2px]">
        {bar(c.moat?.score, "scored", `Moat ${c.moat?.score ?? "—"}/5 · scored · ${sgn(r.moat_z)}σ`)}
        {bar(c.growth_durability?.score, "read", `Growth ${c.growth_durability?.score ?? "—"}/5 · read-only — already in R40, not scored`)}
        {bar(c.earnings_quality?.score, "scored", `Earnings ${c.earnings_quality?.score ?? "—"}/5 · scored · ${sgn(r.earn_z)}σ`)}
        {bar(null, "gated", "Balance-sheet risk · gated, awaiting cash/debt/shares")}
      </span>
      {(r.break_count ?? 0) > 0 && (
        <span
          title={`${r.break_count} break signal${(r.break_count ?? 0) > 1 ? "s" : ""}`}
          className="text-[10px] text-[var(--color-red,#FF3333)]"
        >
          ⚑
        </span>
      )}
      {sig && (
        <span
          className={`font-mono text-[9px] rounded px-1 py-[1px] border ${SIG_TONE[sig[0]]}`}
        >
          {sig[1]}
        </span>
      )}
    </span>
  );
}

/** "How this score is built" ledger — base_z + adj_z → final, in z/σ. */
function ScoreLedger({ r }: { r: Row }) {
  const Line = ({ label, v, tone }: { label: string; v: string; tone?: string }) => (
    <div className={`flex justify-between font-mono text-[11px] ${tone ?? "text-text-dim"}`}>
      <span>{label}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted mb-1">
        How this score is built
      </div>
      <Line label="Base (Quality · Value · Momentum)" v={`${sgn(r.base_z)}σ → ${r.base_pct}th`} />
      {r.has_card && (
        <>
          <Line
            label={`Moat ${r.moat_score ?? "—"}/5`}
            v={`${sgn(r.moat_z)}σ`}
            tone={r.moat_z >= 0 ? "text-green" : "text-[var(--color-red,#FF3333)]"}
          />
          <Line
            label={`Earnings quality ${r.earnings_score ?? "—"}/5`}
            v={`${sgn(r.earn_z)}σ`}
            tone={r.earn_z >= 0 ? "text-green" : "text-[var(--color-red,#FF3333)]"}
          />
          {(r.break_count ?? 0) > 0 && (
            <Line
              label={`Break signals ×${r.break_count}`}
              v={`${sgn(r.break_z)}σ`}
              tone="text-[var(--color-red,#FF3333)]"
            />
          )}
          {r.capped && <Line label="at +budget ceiling" v={`+${BUDGET}σ`} tone="text-text-muted" />}
          {r.floored && <Line label="at floor" v="−1.50σ" tone="text-text-muted" />}
          <Line label={`AI adjustment (budget ${BUDGET}σ)`} v={`${sgn(r.adj_z)}σ`} />
        </>
      )}
      <div className="flex justify-between font-mono text-[11px] text-text border-t border-white/10 pt-1 mt-1">
        <span>Final</span>
        <span>
          {sgn(r.base_z + r.adj_z)}σ → {r.final_pct}th percentile
        </span>
      </div>
    </div>
  );
}

/** Value block: P/S vs own 12-mo median + vs peer (sector/industry) median —
 *  display only (brief §5). */
function ValueBlock({ r }: { r: Row }) {
  const cheapVs = (median: number | null) =>
    r.ps != null && median != null && median > 0
      ? r.ps < median
        ? "cheap"
        : "rich"
      : null;
  const ownTone = cheapVs(r.ps_median_12m);
  const peerTone = cheapVs(r.peer_ps_median);
  const tone = (v: string | null) =>
    v === "cheap" ? "text-green" : v === "rich" ? "text-[var(--color-red,#FF3333)]" : "text-text-muted";
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 space-y-1 font-mono text-[11px]">
      <div className="uppercase tracking-[0.1em] text-text-muted mb-1 text-[10px]">Value</div>
      <div className="flex justify-between">
        <span className="text-text-muted">P/S</span>
        <span className="text-text">{fmt(r.ps, { mult: true })}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-text-muted">vs own 12-mo median ({fmt(r.ps_median_12m, { mult: true })})</span>
        <span className={tone(ownTone)}>{ownTone ?? "—"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-text-muted">
          vs {r.peer_basis ?? "sector"} median ({fmt(r.peer_ps_median, { mult: true })})
        </span>
        <span className={tone(peerTone)}>{peerTone ?? "—"}</span>
      </div>
    </div>
  );
}

/** Quant detail block — the universe-wide facts behind the base score. */
function QuantBlock({ r }: { r: Row }) {
  const Row2 = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
    <div className="flex justify-between">
      <span className="text-text-muted">{k}</span>
      <span className={tone ?? "text-text"}>{v}</span>
    </div>
  );
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 space-y-1 font-mono text-[11px]">
      <div className="uppercase tracking-[0.1em] text-text-muted mb-1 text-[10px]">Quant</div>
      <Row2 k="Rule of 40" v={fmt(r.rule_of_40, { dp: 0 })} tone="text-green" />
      <Row2 k="Rev growth (TTM)" v={fmt(r.rev_growth_ttm, { pct: true })} tone="text-green" />
      <Row2 k="Gross margin" v={fmt(r.gross_margin, { pct: true })} tone="text-green" />
      <Row2 k="FCF margin" v={fmt(r.fcf_margin, { pct: true })} tone="text-green" />
      <Row2
        k="52-wk vs SPY"
        v={fmtSigned(r.perf_52w_vs_spy)}
        tone={
          (r.perf_52w_vs_spy ?? 0) >= 0 ? "text-green" : "text-[var(--color-red,#FF3333)]"
        }
      />
    </div>
  );
}

/** A scored / read-only / gated dimension card. */
function DimCard({
  label,
  dim,
  readOnly,
  gated,
}: {
  label: string;
  dim?: { score?: number; rationale?: string; evidence?: string } | null;
  readOnly?: boolean;
  gated?: boolean;
}) {
  if (gated) {
    return (
      <div className="rounded-lg border border-dashed border-white/20 bg-black/10 p-2.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] text-text-muted">{label}</span>
          <span className="font-mono text-[9px] text-text-muted/70">gated · awaiting cash/debt/shares</span>
        </div>
        <p className="text-[11px] text-text-muted/70 mt-1 leading-relaxed">
          Not scored — verified inputs absent. Never inferred from missing data.
        </p>
      </div>
    );
  }
  if (!dim) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-text">{label}</span>
        <span className="font-mono text-[11px] text-text-muted">
          {dim.score ?? "—"}/5
          {readOnly && <span className="ml-1.5 text-[9px] text-text-muted/70">read-only · in R40</span>}
        </span>
      </div>
      {dim.rationale && <p className="text-[11px] text-text-dim mt-1 leading-relaxed">{dim.rationale}</p>}
      {dim.evidence && (
        <p className="text-[10.5px] text-text-muted mt-1 leading-relaxed">{dim.evidence}</p>
      )}
    </div>
  );
}

/** The position block on a held/sold row's expand (holdings overlay, brief §4). */
function PositionBlock({ h }: { h: ScreenHolding }) {
  const money = (n: number | null) =>
    n == null ? "—" : `$${Math.round(n).toLocaleString()}`;
  if (h.state === "sold") {
    return (
      <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 font-mono text-[11px] space-y-1">
        <div className="uppercase tracking-[0.1em] text-text-muted mb-1 text-[10px]">Position · sold</div>
        <div className="flex justify-between">
          <span className="text-text-muted">Exit date</span>
          <span className="text-text">
            {h.exit_date
              ? new Date(h.exit_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Thesis</span>
          <span className="text-text-muted">closed</span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 font-mono text-[11px] space-y-1">
      <div className="uppercase tracking-[0.1em] text-text-muted mb-1 text-[10px]">
        Position {h.has_break_signals ? "· review" : "· held"}
      </div>
      <div className="flex justify-between"><span className="text-text-muted">Shares</span><span className="text-text">{h.quantity?.toLocaleString() ?? "—"}</span></div>
      <div className="flex justify-between"><span className="text-text-muted">Avg cost</span><span className="text-text">{h.avg_cost_usd != null ? `$${h.avg_cost_usd.toFixed(2)}` : "—"}</span></div>
      <div className="flex justify-between"><span className="text-text-muted">Last</span><span className="text-text">{h.last_price_usd != null ? `$${h.last_price_usd.toFixed(2)}` : "—"}</span></div>
      <div className="flex justify-between"><span className="text-text-muted">Market value</span><span className="text-text">{money(h.market_value_usd)}</span></div>
      <div className="flex justify-between">
        <span className="text-text-muted">Unrealized P&L</span>
        <span className={(h.unrealized_pnl_usd ?? 0) >= 0 ? "text-green" : "text-[var(--color-red,#FF3333)]"}>
          {h.unrealized_pnl_usd != null ? `${h.unrealized_pnl_usd >= 0 ? "+" : ""}${money(h.unrealized_pnl_usd)}` : "—"}
        </span>
      </div>
      <div className="flex justify-between"><span className="text-text-muted">Thesis</span><span className="text-text-muted">{h.thesis_status ?? "—"}</span></div>
    </div>
  );
}

/** Holdings pill for the ticker cell. */
function HoldingPill({ h }: { h: ScreenHolding | null }) {
  if (!h) return null;
  const map = {
    held: ["held", "text-[var(--color-cyan)] border-[var(--color-cyan)]/40"],
    review: ["review", "text-[#f5a623] border-[#f5a623]/45"],
    sold: ["sold", "text-text-muted border-white/15"],
  } as const;
  const key = h.state === "held" && h.has_break_signals ? "review" : h.state;
  const [label, cls] = map[key];
  return (
    <span className={`ml-1.5 font-mono text-[9px] rounded px-1 py-[1px] border align-middle ${cls}`}>
      {label}
    </span>
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
  holding,
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
  /** Holdings overlay entry for this name (null = not in the portfolio). */
  holding: ScreenHolding | null;
}) {
  const [open, setOpen] = useState(false);
  // AI direction stripe (teal lift / red cut / none uncarded).
  const edge = !r.has_card
    ? "border-l-2 border-l-transparent"
    : r.adj_z > 0
      ? "border-l-2 border-l-[var(--color-cyan)]"
      : r.adj_z < 0
        ? "border-l-2 border-l-[var(--color-red,#FF3333)]"
        : "border-l-2 border-l-white/15";
  const adjTone =
    !r.has_card
      ? "text-text-muted/50"
      : r.adj_z > 0
        ? "text-green"
        : r.adj_z < 0
          ? "text-[var(--color-red,#FF3333)]"
          : "text-text-muted";
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
        <td className={`px-2 py-2.5 text-left font-mono text-text-muted text-xs border-t border-white/10 ${edge}`}>
          {r.rank}
        </td>
        <td className="px-2 py-2.5 text-left border-t border-white/10 max-w-[280px]">
          <div className="flex items-center">
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
            <HoldingPill h={holding} />
          </div>
          <p className="text-[10.5px] text-text-muted/80 mt-0.5 truncate" title={compileThesis(r)}>
            {compileThesis(r)}
          </p>
        </td>
        <td className="px-2 py-2.5 text-right font-mono border-t border-white/10">
          <div className="text-[var(--color-cyan)] text-[13px] leading-none">
            {r.final_pct}
            <span className="text-[8.5px] align-top">th</span>
          </div>
          {r.has_card ? (
            <div className={`text-[9px] mt-0.5 ${adjTone}`}>
              AI {sgn(r.adj_z)}σ
              {r.capped && <sup className="ml-0.5">cap</sup>}
              {r.floored && <sup className="ml-0.5">flr</sup>}
            </div>
          ) : (
            <div className="text-[9px] mt-0.5 text-text-muted/40">quant</div>
          )}
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
        <td className="px-2 py-2.5 text-left border-t border-white/10">
          <DurabilityBadge r={r} />
        </td>
        <td className="border-t border-white/10 text-right pr-2 whitespace-nowrap">
          {canExclude && (
            <button
              type="button"
              disabled={exclBusy}
              onClick={() => onExclude(r.ticker)}
              title={`Remove ${r.ticker} from the screener for 1 year — also blocks the agents from buying it`}
              aria-label={`Remove ${r.ticker} for a year`}
              className="font-mono text-[12px] text-text-muted/50 hover:text-[var(--color-red,#FF3333)] disabled:opacity-40 mr-1.5"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${r.ticker}` : `Expand ${r.ticker}`}
            className="font-mono text-[12px] text-text-muted hover:text-text"
          >
            {open ? "▾" : "▸"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={spanCols} className="border-t border-white/10 bg-black/20 px-3 py-3">
            {r.has_card && r.research_card ? (
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <DimCard label="Moat" dim={r.research_card.moat} />
                  <DimCard label="Growth durability" dim={r.research_card.growth_durability} readOnly />
                  <DimCard label="Earnings quality" dim={r.research_card.earnings_quality} />
                </div>
                <DimCard label="Balance-sheet risk" gated />
                {(r.research_card.break_signals?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-[var(--color-red,#FF3333)]/30 bg-[var(--color-red,#FF3333)]/[0.04] p-2.5">
                    <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-[#f5a623] mb-1.5">
                      Break signals
                    </div>
                    <ul className="space-y-1">
                      {r.research_card.break_signals!.map((b, i) => (
                        <li key={i} className="text-[11px] text-text-dim flex gap-2">
                          <span className="text-[var(--color-red,#FF3333)]">⚑</span>
                          {b.description ?? `${b.field ?? ""} ${b.op ?? ""} ${b.value ?? ""}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-3">
                  <ScoreLedger r={r} />
                  <ValueBlock r={r} />
                  <QuantBlock r={r} />
                </div>
                {holding && <PositionBlock h={holding} />}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-[11.5px] text-text-muted leading-relaxed max-w-prose">
                  No research card yet — ranked on quant alone. A full AI durability
                  read (moat, earnings quality, break signals) is added when the
                  rotating analysis reaches this name. The quant facts below are
                  universe-wide.
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <ScoreLedger r={r} />
                  <ValueBlock r={r} />
                  <QuantBlock r={r} />
                </div>
                {holding && <PositionBlock h={holding} />}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
