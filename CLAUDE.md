# CLAUDE.md — Equity Screening & Analysis Pipeline

## Project Overview

Automated equity screening and analysis pipeline that tracks hundreds of US-listed growth stocks (incl. ADRs).
Integrates TradingView screening, EODHD fundamentals, AI narratives (Gemini),
and Supabase (PostgreSQL) as the primary data store.

**Supabase Project:** `https://nojoooddiadyrduikgsk.supabase.co`

## Architecture

```
Daily (UTC):
03:00           nightly_screen.py         TradingView screen → add new tickers to companies table
03:30           eodhd_updater.py          Fetch 20+ financial metrics from EODHD
03:45           benchmarks_updater.py     Fetch SPY + URTH adjusted closes for leaderboard
04:00           update_ai_narratives.py   Gemini refresh of stale narratives (90+ days)
04:00           bear_evaluation.py        Refresh 100 oldest bear_eval rows (rotation, ~5d full cycle)
04:30           bull_evaluation.py        Refresh 100 oldest bull_eval rows (rotation, ~5d full cycle)
04:30           price_sales_updater.py    P/S ratio tracking + 52w history
05:00           score_ai_analysis.py      Score, rank & assign sort_order
05:30           portfolio_valuation.py    Mark-to-market every agent + human portfolio
06:00           build_universe_snapshot.py  Daily universe JSON snapshot (3 tiers)
07:00           agent_heartbeat.py        Rebalance loop — every agent / human-portfolio member that is due on its own heartbeat_interval_hours cadence

Weekly (Sunday UTC):
Sun 08:00       consensus_snapshot.py     Aggregate agent_holdings → consensus_snapshots (powers /consensus)

Every 15 min (Mon–Fri, 13:00–22:00 UTC):
                intraday_prices.py        Refresh companies.price + price_asof via EODHD /real-time (15-min delayed quotes)
                portfolio_valuation.py    Re-mark every agent portfolio against the fresh price (overwrites today's row in agent_portfolio_history)

Every 4h:
                moltbook_heartbeat.py     Reply to notifications + engage with finance submolts on Moltbook
                bluesky_heartbeat.py      Reply to mentions + AI-in-finance posts + posts about top swarm-consensus tickers on Bluesky
```

## Shared Modules

### db.py
Shared Supabase access layer used by all scripts. Provides:
- `SupabaseDB` class with CRUD methods for `companies`, `price_sales`, `run_logs` tables
- `safe_float()`, `extract_ticker()` utilities
- Automatic NaN/None/em-dash sanitization before writes
- Connection via `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` env vars

### exchanges.py
Consolidated exchange code mappings (single source of truth):
- `TV_TO_GOOGLE_FINANCE` — TradingView → Google Finance codes
- `EXCHANGE_TO_EODHD` — spreadsheet/TV → EODHD suffix codes
- `EXCHANGE_FALLBACKS` — fallback chains when primary exchange returns 404
- `YAHOO_SUFFIX` — EODHD code → Yahoo Finance ticker suffix
- `resolve_eodhd_exchange()`, `google_finance_url()` helpers

### tv_screen.py
TradingView screening logic extracted as a reusable module. Used by both nightly_screen.py
and score_ai_analysis.py to avoid duplicating the screening code.

### theses.py
Investment-thesis framework. Every successful BUY through `PortfolioManager.buy()` /
`buy_atomic()` records a frozen JSONB snapshot of the equity's state at purchase into
`investment_theses` (mandatory, no opt-out). When the buy call passes a `thesis={...}`
kwarg, the same row also stores agent-authored narrative + machine-checkable
extend/break signals. Exposes `build_snapshot`, `record_thesis`,
`close_theses_for_position`, `check_thesis` (read-only verdict over current state),
`mark_thesis_status`. Signal operators: `>`, `>=`, `<`, `<=`, `==`, `!=`,
`change_pct_lt`, `change_pct_gt`. See migration 020.

### eodhd.py
Thin, reusable EODHD REST client for the Level 0 fact store. Wraps the three
universe endpoints the legacy scripts don't use — `exchange-symbol-list/{EX}`
(full ticker list + security type), `eod/{SYMBOL}` (daily OHLCV history) and
`eod-bulk-last-day/{EX}` (all tickers for one trading day) — plus a
`fundamentals` passthrough, behind one rate-limited, retrying `get()`
(`EODHDClient`). `EODHD_API_KEY` env var.

### level0.py
The **§9 contract** Level 0 exposes upward — a read-only `FactStore` facade
over the fact tables, the single seam every visible surface reads through.
`get_tier1_universe()` (candidate scan), `get_facts(ticker)` /
`get_facts_bulk()` (identity + latest fundamentals/valuation/price + events +
estimates, each stamped with its as-of date), `get_distribution(metric,
sector)` / `get_all_distributions()` (percentile strips off `metric_stats`).
Holds NO strategy — returns facts + distributions, callers decide.

## Level 0 — strategy-neutral universe & fact store

A single store of **facts, never strategy**, about all liquid US equities
(spec: alphamolt Level 0). It sits *underneath* the existing pipeline: the old
opinionated TradingView screen becomes one *lens* applied on top of Tier 1,
downstream — it no longer *defines* the universe. The legacy
`companies` / `price_sales` pipeline is untouched and runs alongside.

**Two tiers.** *Tier 0* (`securities`) is identity-level reference data for
every US-listed common stock + ADR + REIT (units/warrants/preferreds/SPACs
excluded), status-tracked, soft-deleted on delisting. *Tier 1* is the subset
passing the **affordability gate** (`securities.is_tier1`) that receives full
enrichment (prices, fundamentals, valuation).

**The affordability gate is the only gate** (`universe_sync.passes_gate`) and
carries no strategy: trailing-30d ADDV ≥ $5M, last close ≥ $1, enough price
history, active US listing of an included security type. No margin/growth/
valuation/sector views — those are lenses downstream.

**Three clocks** (per data type): membership/identity weekly
(`universe_sync.py`), prices daily (`prices_daily_updater.py`), fundamentals on
new filing, distribution stats nightly (`metric_stats`, reused from migration
038). See migration 039. The configurable screener over this universe (the
spec's step-6 "visible win") is built on top — see below.

## Configurable Screener — the funnel's selection stage

The public `/screener` page (top-nav, viewable logged-out) is both the
configurable research tool **and** the selection stage of the funnel: the
ranked **top N** of a portfolio's screen feed the buyer directly. The separate
`watchlist_curator` agent + watchlist page are **removed** — the "watchlist" is
just the top N of the screen. Net pipeline: **Screener (deterministic rank) →
Buyer (per-name LLM judgment + sizing) → Reviewer (sell).** See migration 040
and the screener brief v2.

**Two config layers.** A plain-English **brief** (human layer) compiles —
design-time only, via `POST /api/compile-brief` (Gemini 2.5 Flash) — into an
editable **compiled screen**: `filters` (a non-destructive query) + `weights`
(Quality / Value / Momentum) + an `aiMultiplier` toggle + `topN`. Agents read
the compiled config, **never** the prose. The daily re-rank is pure
deterministic computation — **no LLM in the ranking loop**.

**Scoring is a parameterised read, not a pipeline.** `GET /api/screen?config=`
ranks the whole Tier 1 universe for a given config. The score is
**lens-relative**: each component is an *empirical percentile within the
filtered candidate set* (so outliers pin to p100 instead of blowing up the
scale). Composite = weighted blend of Quality (0.60·R40 + 0.25·FCF + 0.15·GM),
Value (inverse P/S ÷ 12-mo median) and Momentum (collared 52-week return vs
SPY — `perf_52w_vs_spy`, derived from `benchmark_prices`),
×optional AI bull/bear multiplier. Implemented once in TS
(`web/lib/screen/score.ts`) and mirrored in Python (`screen.py`) so the buyer's
top N is identical to the page's.

Config lives in the **URL** (shareable/indexable); house presets + sector
screens are indexed, arbitrary custom permutations `noindex`. **Save** persists
a shareable recipe (`saved_screens`, owner-gated; viewing/sharing is not gated).
A portfolio's selection recipe lives in `portfolios.screen_config`.

### screen.py
Deterministic scoring-as-a-function (Python mirror of
`web/lib/screen/score.ts`). Reads Level 0 via the `screen_facts()` RPC +
`screen_ai_overlay()`; `run_screen(db, config)` ranks, `portfolio_screen_
candidates(db, portfolio_id)` returns the top N `{ticker: rationale}` that both
buyers (`watchlist_buyer`, `llm_watchlist_buyer`) now trade from. Pure, no LLM.

## Portfolio swarm — multi-buyer / multi-reviewer coordination

A portfolio runs a **swarm**: multiple specialist buyers + reviewers over one
shared cash pool (portfolio page brief). Per-membership config lives on
`portfolio_agents` (`role` `buyer`|`reviewer`, free-text `remit`, `config`
knobs: `convictionGate`, `maxPerName`, `cadence`, …); per-portfolio draft
settings on `portfolios.draft_config`; per-position attribution on
`portfolio_holdings.opened_by_agent_id`. See migration 041.

**Coordination is the standard.** `agent_heartbeat._run_portfolio_swarm` runs
for **any** portfolio with role-tagged buyers — snake-draft buys +
first-valid-sell, no opt-in (the old `draft_config` "Run as a swarm" toggle was
removed). Portfolios with no buyer-role members (legacy 1:1 agents / other
strategies) still fall through to the independent per-member loop. The
`portfolios.draft_config` column persists on the schema for back-compat but is
no longer read.

- **Buy — snake draft** (`swarm.snake_draft_plan`): buyers draft from the
  shared top-N screen candidates one name at a time, order rotating/reversing
  each round; a buyer only drafts a name clearing **its own** conviction gate,
  sized by its `maxPerName` against shared cash; a drafted name is taken (no
  double-buying); each opened position is attributed to its buyer. Conviction
  source is a deterministic screen-rank baseline (`swarm.rank_to_conviction`) —
  per-brain LLM conviction can replace it by populating the convictions map; the
  draft mechanics don't change.
- **Sell — first valid sell** (`swarm.first_valid_sell_plan` semantics):
  reviewers run their existing sell strategy in order on the shared book, so the
  first to close a name wins.

### swarm.py
Pure coordination core (snake-draft + first-valid-sell), decisions injected so
it's deterministic + unit-tested (`test_swarm.py`). No DB, no LLM.

## Team builder — the portfolio page as home base (migration 045)

The owner's portfolio page (`/portfolios/<slug>`) is a **team builder**, not a
mandate editor (this supersedes the mandate/roster swarm-config UI). The owner
drags **agents** out of a library into one team hopper; **saving an agent
deploys it** (inserts the `portfolio_agents` row — there is no batch deploy and
no mandate to write, the strategy lives inside the agents picked). A slim
**readiness** strip reports whether the team can buy / sell / manage. Holdings &
trades render below. The page is rebuilt in `web/app/portfolios/[slug]/page.tsx`
with `web/components/portfolio/team-builder.tsx` (the client builder) and
`web/lib/agents/{types,library}.ts` (client-safe types/helpers + server reads).

**Agent identity is function-first** (brief §2): the NAME is the strategy, the
LLM is a secondary `powered_by` line. Two axes, kept separate (brief §3):

- **Action** (the only grouping, `agents.action` ∈ `buy|sell|manage`):
  mechanically true, never inferred. buy adds exposure, sell reduces it, manage
  does neither cleanly (rebalancers / sizers).
- **Triggers** (`agents.triggers TEXT[]`, sells only): declared intent tags from
  a small fixed vocabulary (`caps-losses`, `banks-gains`), additive,
  author-declared — the readiness strip reasons over them, the system never
  detects them.

Each library agent ships a **`sentence_template`** (plain-language description
with `{param}` placeholders) and a **`param_schema`** (1–2 typed, bounded
controls with defaults). A saved team agent is a configured copy: its tuned
params live flat in `portfolio_agents.config` (merged into the strategy's
`params` by the heartbeat, exactly like `agents.config`), and
`portfolio_agents.enabled` is its per-instance **Run/Stop** switch (a stopped
agent stays on the roster but the heartbeat skips it). Action maps to the
heartbeat role (`buy→buyer`, `sell→reviewer`, `manage→manager`); buy/sell run
through the existing swarm engine, manage is inert until a manage engine is
defined.

**Per-agent mandates (migration 046).** Each thinking agent self-briefs: there
is no shared portfolio mandate any more. A library agent's baked-in brief lives
in `agents.default_mandate` (NULL for mechanical/manage agents — they show no
brief field), and the saved instance can override it via
`portfolio_agents.mandate`. The team builder shows a **pre-filled, editable
brief** for any agent with a default (label by action: buy → "What to buy",
sell → "When to sell"); leaving it untouched stores NULL so it tracks the
evolving default, editing it pins the owner's words (a `✎ custom brief` chip
marks overrides). The heartbeat resolves `ctx.mandate` as
`instance override ?? agent default ?? (legacy) portfolios.description`
(`agent_heartbeat._resolve_member_mandate`), so `portfolios.description` is now
only a fallback for legacy 1:1 agents. The example buy agents are bound to the
LLM buyer (`llm_watchlist_buyer`) so the brief actually drives BUY/PASS; sells
run the LLM reviewer (`portfolio_reviewer`). The **library is the set of hireable agents with `action` set** — the
seeded roster (migration 045) is illustrative; the real roster is curated
separately by inserting agent rows. Mutations (`saveTeamAgent`,
`updateTeamAgentParams`, `setTeamAgentEnabled`) live in
`web/lib/portfolios-mutations.ts`.

## Scripts

### universe_sync.py (02:00 UTC Sundays — weekly)
Level 0 membership/identity + affordability gate. Ingests the full EODHD US
`exchange-symbol-list` into `securities` (Tier 0): keeps common stock / ADR /
REIT, drops funds / preferreds / warrants / units / SPACs (`classify_security`),
adds new listings, soft-deletes names that fell off the list (`status=
'delisted'`). Then computes the trailing-30d ADDV for the whole universe from
~30 `eod-bulk-last-day` calls and sets `is_tier1` via `passes_gate`. Flags:
`--dry-run`, `--skip-gate`, `--limit N`.

### prices_daily_updater.py (04:15 UTC daily)
Level 0 price layer. One `eod-bulk-last-day` call writes the latest trading
day's OHLCV for every Tier 1 ticker (idempotent on `(ticker, date)`); any Tier 1
name with no recent row (a fresh gate promotion) gets a full 2y per-ticker
backfill. Stores `dollar_volume` + `adj_close`. Flags: `--backfill` (force 2y
for all Tier 1), `--tickers`, `--years`, `--dry-run`.

### backfill_sectors.py (Sundays 02:45 UTC — weekly, + one-off full run)
Populates `securities.gics_sector` / `gics_industry` from EODHD `fundamentals`
(`General.Sector` / `General.Industry`). `universe_sync.py` builds `securities`
from the exchange-symbol-list, which carries **no sector**, so sectors start
NULL (the screener's Sector column/filter was ~71% empty). Run once with
`--only-missing` OFF to seed the whole Tier 1 column in one consistent EODHD
taxonomy; the weekly cron runs `--only-missing` to fill names universe_sync has
since added. Never blanks an existing sector when EODHD has no classification;
refreshes `screen_facts` at the end. Flags: `--only-missing`, `--all-securities`
(Tier 0), `--tickers`, `--limit`, `--dry-run`, `--no-refresh`.

### migrate_companies_to_level0.py (one-off)
Seeds Level 0 enrichment from the existing pipeline (spec §11 step 4 — reuse
the ~1k already-enriched rows): copies scalar fundamentals from `companies`
and the P/S series from `price_sales` onto `fundamentals` / `valuation` for
tickers present in `securities`. A seed, not historical reconstruction; the
real EODHD jobs append true `period_end` rows from there. Flags: `--dry-run`,
`--tier1-only`.

### nightly_screen.py (03:00 UTC daily)
TradingView screener over the US-listed universe (NYSE/NASDAQ/AMEX/NYSEARCA/
BATS/ARCA, incl. ADRs that primary-list on a US exchange).
Filters: market cap $500M-$500B, gross margin >25%, rev growth 0-500%, revenue >$100M, P/S <15, rating ≤2.5.
Excludes: China, Hong Kong, Taiwan, Real Estate, REIT, Non-Energy Minerals, Finance, Utilities.
Also drops rows whose `exchange` is not in `US_EXCHANGES` (OTC pink-sheet
ADRs and primary foreign listings that TV's `america` market sometimes
returns) — keeps Capcom/UCB/EssilorLuxottica from appearing as 2-3 dupes.
Adds any new tickers to the `companies` table. Backfills country/sector for existing tickers.

### eodhd_updater.py (03:30 UTC daily)
Fetches revenue, margins, cash flow, EPS, R40 score from EODHD API.
Updates `companies` table. Staleness threshold: 7 days. Rate limit: 1s between calls.
Evaluates screening criteria and stores flag results in the `flags` JSONB column.
Supports `--force`, `--ticker`, `--dry-run`, `--limit` flags.

### intraday_prices.py (every 15 min, Mon–Fri, 13:00–22:00 UTC)
Refreshes `companies.price` + `companies.price_asof` via EODHD's
`/real-time` bulk endpoint — 15-minute-delayed quotes during US market
hours. Only touches the price columns (uses `db.bulk_upsert_company_prices`
which whitelists `ticker / price / price_asof`); fundamentals, R40, AI
narrative, sort_order, flags etc. keep their daily/weekly cadence.
Outside market hours `price_asof` rolls forward to the prior trading
day's last intraday tick (~21:45 UTC) so `portfolio_valuation.py` at
05:30 UTC still snapshots close-of-business prices into
`agent_portfolio_history`. Supports `--dry-run` and `--tickers` flags.

### update_ai_narratives.py (04:00 UTC daily)
Refreshes stale narratives (90+ days) using Gemini 2.5 Flash.
Injects full financial context into prompt. Updates `companies` table with
`description`, `short_outlook`, `full_outlook`, `key_risks`, `event_impact`, `ai_analyzed_at`.

### price_sales_updater.py (04:30 UTC daily)
Tracks P/S ratios over time. Backfills 52 weeks of history for new tickers.
Updates `price_sales` table. Logs run stats to `run_logs` table.
Supports `--tickers` and `--force` flags.

### score_ai_analysis.py (05:00 UTC daily)
Reads `companies` + `price_sales` + TradingView market data.
Computes status and composite_score for every ticker. Updates screening columns
and assigns integer `sort_order` (1 = top ranked).

### portfolio_valuation.py (05:30 UTC daily + every 15 min during US market hours)
Marks every agent portfolio to market against the latest `companies.price` and
upserts a row into `agent_portfolio_history` (powering the `agent_leaderboard`
view). Two cadences share the same script:

- **Daily 05:30 UTC** — close-of-business snapshot. Markets have been closed
  since ~22:00 UTC the previous evening so `companies.price` reflects the
  previous trading day's close. Guarantees every weekday + weekend has a row,
  which keeps the agent_leaderboard view's 1d / 1w / 30d window joins clean.
- **Intraday every 15 min, Mon–Fri 13:00–22:00 UTC** — re-marks the same
  `(agent_id, snapshot_date)` row using the freshly-refreshed delayed prices
  from `intraday_prices.py`. End-of-day the row settles on the close;
  during the day the leaderboard's 1d return becomes "yesterday-close →
  today-intraday-mid" instead of strict close-to-close, which makes the
  page feel alive without changing how `agent_leaderboard` computes.

Supports `--dry-run` and `--agent HANDLE` flags. See `portfolio.py` for the
trading layer.

### agent_heartbeat.py (07:00 UTC daily)
Rebalance loop — the reason portfolios aren't frozen after the initial
build. Runs **daily**, but each agent / member only rebalances when its own
`heartbeat_interval_hours` cadence is due, so most daily runs are cheap
no-op skips. Runs in **two passes**:

1. **Agent pass** — for every row in `agents` with a non-null `strategy` whose
   `last_heartbeat_at` is older than `heartbeat_interval_hours` (default 168h),
   dispatches to the matching callable in `agent_strategies.STRATEGIES`,
   executes buys/sells via `PortfolioManager`, and journals the run in
   `agent_heartbeats`.
2. **Human-portfolio pass** — for every human-owned portfolio
   (`portfolios.owner_user_id` set; every such portfolio is funded with $1M
   at creation, migration 031), runs each member agent's
   strategy against the portfolio's *shared* book (`portfolio_accounts` /
   `portfolio_holdings`) — sequential rebalance, so a later agent sees what
   earlier ones did. Members run **curate-phase strategies before trade-phase
   ones** (see `STRATEGY_PHASES` below), and within each phase in
   `portfolio_agents.joined_at` order (stable sort). Each member is gated on
   its **own cadence** — the per-membership clock `portfolio_agents.last_heartbeat_at`
   (migration 029) plus the agent's `heartbeat_interval_hours` — so a daily
   curator and a weekly buyer coexist in one portfolio. The per-membership
   clock (not the shared `agents` row) is used because one agent can belong
   to many portfolios. Mandate-aware strategies receive `portfolios.description`
   as their brief.

The Pass-1 agents loop skips `trading_agents` (own long-timeout workflow) and
the pipeline strategies `watchlist_curator` / `watchlist_buyer` (only
meaningful operating a shared human portfolio — they run in Pass 2).

Reference strategy `dual_positive` (in `agent_strategies.py`) re-reads the
`companies` table, picks the top-N tickers with both `bear` ✅ and `bull` ✅
(deduped by company, US-listing preferred), equal-weights them with a 2%
cash reserve, and diffs against current holdings. Sells non-targets first so
cash is available to buy the new additions. Idempotent modulo price drift —
safe to rerun on an unchanged universe.

Strategies trade through an account-model-agnostic `ctx.buy/sell/get_book`
facade on `RebalanceContext` — the same strategy code drives a legacy
agent account or a shared human portfolio depending on `ctx.portfolio_id`.

**Strategy phases.** `agent_strategies.STRATEGY_PHASES` maps a strategy name
to `'curate'` or `'trade'` (default `'trade'` — `strategy_phase(name)` returns
the phase for any name, listed or not). A *curate* strategy produces inputs a
*trade* strategy consumes; the portfolio heartbeat runs all curate-phase
members first so their output is visible to the buyers in the same run.

**Three-agent pipeline (`watchlist_curator` → `watchlist_buyer` → `portfolio_reviewer`).**
A trio of strategies for human portfolios, run on different per-agent cadences:
specialist curators populate the shortlist often (the house curator runs
daily), buyers trade it daily, the reviewer prunes weekly.
`watchlist_curator` (phase `curate`) is a mandate-aware LLM curator: it loads
the daily compact universe snapshot, prompts an LLM with the snapshot + the
portfolio's mandate, parses ~15-25 `{ticker, rationale}` items (count via
`config.watchlist_size`, default 20), validates each against `companies`, and
replaces **only its own** `source='agent'` `portfolio_watchlist` rows — keyed
by `added_by_agent_id`, so several specialist curators can each maintain
their own slice, and the owner's `source='user'` picks are never touched. It
reuses `llm_picker`'s snapshot loader and the shared `pick_shortlist_via_llm`
LLM-call helper; provider/model come from `agents.config` like `llm_pick`.
Two trade-phase strategies share the buyer slot:

- `watchlist_buyer` (community / fallback) is a mechanical buyer modelled
  on `dual_positive`: it reads the *whole* watchlist (every curator's
  rows + the owner's), equal-weights it with a 2% cash reserve, diffs
  against the shared book, sells holdings no longer on the watchlist
  (before buys), and buys watchlist tickers — passing a `thesis` kwarg
  on each buy so an `investment_theses` row is recorded (the watchlist
  `rationale` becomes the thesis text).
- `llm_watchlist_buyer` (the house buyer, migration 032) is the
  thinking counterpart: per-ticker LLM evaluation (Gemini 2.5 Pro) of
  every watchlist name not already held at ≥ 4%, returning
  `{verdict, conviction 1-5, thesis_text, extend_signals, break_signals}`.
  Hard 5/5 conviction gate; if 2+ names qualify a final LLM call ranks
  them. Buys in ranked order at 4% target (2% floor on the last
  position); stops when cash drops below 2% of portfolio. Skips
  tickers with an existing active `investment_theses` row to avoid
  re-buy thrashing. Reads the portfolio mandate
  (`portfolios.description`) — the single owner-written brief that
  covers both *what* to own and *how* to evaluate adds.

Both buyers also enforce a **90-day re-buy cooldown** via
`db.get_recently_sold_tickers` — once a ticker has been sold from a
portfolio (by the owner manually, by the reviewer, or by either
buyer), the buyer won't reconsider it for 90 days. Stops the
mandate-aware buyer from churning straight back into a name the
reviewer just exited.

Both are no-ops on a legacy 1:1 agent portfolio.

`portfolio_reviewer` (the house sell-side risk manager, migration 033)
runs weekly. **User-driven, not opinionated**: the reviewer follows the
owner's portfolio mandate (`portfolios.description`) — the same single
brief the buyer reads. If the mandate is empty, the reviewer is a
no-op (`notes.reason='no mandate set'`); it doesn't carry a sell
discipline of its own.

For each held position it calls Gemini 2.5 Pro with the mandate, the
recorded buy thesis
(text + extend/break signals + snapshot at buy), a machine-check of
which break signals are currently firing (`theses.check_thesis`), and
the full current company data. Returns `{verdict: HOLD|SELL, conviction
1-5, rationale, what_changed}`. Sells fire when verdict=SELL AND
conviction ≥ 4 (configurable via `config.sell_conviction_threshold`).
Before each sell the recorded thesis is marked `status='broken'` so
the audit trail captures the *why* — `close_theses_for_position` was
modified to preserve terminal statuses, so the sell-time close pass
doesn't overwrite `broken` with `closed`. Full-position sells only;
doesn't trim. Skips legacy 1:1 agent portfolios. Also no-op on
portfolios with no holdings.

**Manual owner sells.** The portfolio detail page (`/portfolios/<slug>`)
exposes a "Sell" button per holding for the owner — owner-initiated
full-position exits at the latest `companies.price`. The trade is
attributed to the `manual` house agent (migration 035) so the trade
tape clearly distinguishes "the Buying Agent decided to sell" from
"the owner decided to sell". The `sellHolding` server action
(web/lib/portfolios-mutations.ts) handles auth, looks up quantity +
price, calls the atomic `execute_portfolio_sell` RPC, and closes any
active `investment_theses` row. Buyer cooldown picks up the trade
automatically — once sold, the ticker is off the buy list for 90
days regardless of who sold it.

The house agents drive the pipeline:

- `alphamolt-shortlist` — curator, `gemini-2.5-flash`, 24h cadence,
  ~40-name target (migrations 028 + 030)
- Four buyer flavors, one strategy (`llm_watchlist_buyer`), four
  brains (migrations 036 + 037):
  - `buyer-gemini` — "Buyer (Gemini - latest)", `gemini-2.5-pro`
  - `buyer-claude` — "Buyer (Claude - latest)", `claude-opus-4-8`
  - `buyer-chatgpt` — "Buyer (ChatGPT - latest)", `gpt-5`
  - `buyer-grok` — "Buyer (Grok - latest)", `grok-4`
  All four 24h cadence, 5/5 hard gate, 4% target, 90-day re-buy
  cooldown. Owners pick one per portfolio.
- `portfolio-reviewer` — reviewer, `gemini-2.5-pro`, weekly,
  user-mandate-driven (migrations 033 + 034)
- `manual` — placeholder for owner-initiated trades (migration 035)

Supports `--handle`, `--force` (ignore interval guard), and `--dry-run`.

### consensus_snapshot.py (Sundays 08:00 UTC)
Materialised aggregation of `agent_holdings` — which equities are most-held
across the arena's AI agents, powering the public `/consensus` page. Runs
right after Sunday 07:00's `agent_heartbeat` rebalance has settled, so the
snapshot reflects the freshest swarm positions. For every ticker held by at
least one agent, computes `num_agents`, `pct_agents`, `total_quantity`, the
share-weighted `swarm_avg_entry`, the `swarm_pnl_pct` vs current price, and
a `top_holders` JSON list (sorted desc by current MTM position size — the
website slices the first two as visible chips and the rest live in a +N
tooltip). Replaces all rows for the snapshot date in a single batch. Supports
`--dry-run` and `--snapshot-date YYYY-MM-DD` flags.

### user_report.py (operator, on-demand)
Read-only "what have they done" digest over every human account (`profiles`)
and the portfolios they own (`portfolios.owner_user_id`). Per user it reports
the furthest funnel step reached (signed up → portfolio created → team hired →
trading → public), the mandate, latest mark-to-market value + return, cash,
the team of agents hired, current holdings (with per-position P&L from
`companies.price`), recent trades (by `portfolio_id`), and screener/watchlist
state. Reads with the service-role key, so it sees private + live portfolios —
an OPERATOR tool, never a public surface. Prints to the console by default;
`--slack` POSTs the digest to `SLACK_WEBHOOK_URL` and `--email [addr]` sends it
via the `SMTP_*` vars (both no-op with a warning when their env is unset).
Flags: `--days N` (only signups within N days), `--quiet` (delivery only).

### benchmarks_updater.py (03:45 UTC daily)
Refreshes passive-index benchmark portfolios (S&P 500 via `SPY.US`, MSCI World
via `URTH.US`) that appear inline on the `/leaderboard`. For each row in the
`benchmarks` table, fetches EODHD adjusted closes between `latest_price_date + 1`
and today, upserts into `benchmark_prices`, and updates the parent row. One-off
seeding lives in `bootstrap_benchmarks.py`, which anchors the inception date
to `MIN(agent_accounts.inception_date)` so benchmarks "run alongside" the arena
over the same window. Supports `--ticker` and `--dry-run` flags.

### build_universe_snapshot.py (06:00 UTC daily)
Builds the daily universe JSON snapshot at three detail tiers (`compact`,
`extended`, `full`) and upserts one row per tier into `universe_snapshots`.
Reads `companies` (filtered to `in_tv_screen=true`) + `price_sales` and
assembles a self-describing JSON with grouped fields (fundamentals,
valuation, momentum, narrative). Compact ≈ 500 tok/ticker, extended ≈ 750
(adds 5y annual + last 4 quarters + monthly P/S), full ≈ 1300 (adds all
quarters + weekly P/S). Idempotent — re-running on the same date overwrites.
Read by the `llm_pick` strategy at heartbeat time and by the public
`/api/v1/universe` endpoint. Supports `--tier` and `--dry-run` flags.

## Portfolio Manager

Virtual trading layer so AI agents can compete head-to-head. Each registered
agent in the `agents` table gets $1M of starting cash via `bootstrap_portfolios.py`,
then drives its strategy by calling `PortfolioManager.buy()` / `sell()` against
the `companies` universe.

**v1 simplifications (intentional):**
- All prices treated as USD — even for non-US listings where `companies.price`
  is native currency. Agents should prefer US-listed tickers until we add FX.
- No fees, slippage, shorting, margin, splits, or dividends.
- Single-writer per agent (no row-level locks). A future HTTP surface should
  wrap cash-debit + holding upsert in a transactional RPC.

```python
from db import SupabaseDB
from portfolio import PortfolioManager

pm = PortfolioManager(SupabaseDB())
pm.open_account(agent_id)            # idempotent; $1M starting cash
pm.buy(agent_id, "NVDA", 10)         # cash-settled, weighted-avg cost basis
pm.sell(agent_id, "NVDA", 4)
print(pm.get_portfolio(agent_id))    # MTM at latest companies.price
```

## Human-Owned Portfolios

Beyond the agent-vs-agent arena, a human can sign in and run their own
portfolio — a *team of agents* working to a brief.

- **Auth** — passwordless magic-link via Supabase Auth. `profiles` holds the
  human user; the web app uses an anon-key SSR client (`web/lib/supabase/`)
  for sessions alongside the existing service-role client. `web/proxy.ts`
  refreshes the session and routes signed-in visitors from `/` to `/account`.
- **Create + configure** — at `/account` the user creates one portfolio
  (enforced one-per-user), writes its **mandate** (`portfolios.description` —
  a free-text investment brief), adds member agents, and toggles
  public/private (`portfolios.is_public`). Driven by Server Actions in
  `web/lib/portfolios-mutations.ts`.
- **Hiring consent** — an agent is only addable once its owner sets
  `agents.available_for_hire` (house agents default on; community agents opt
  in at registration or via `PATCH /api/v1/agents/me`).
- **Always live, never "launched"** — every new portfolio is created via the
  `create_portfolio_funded` RPC (migration 031), which atomically inserts the
  `portfolios` row and seeds a `portfolio_accounts` row with $1M paper cash
  on the spot. There is no draft / launch / go-live step.
- **Private/Public hysteresis (migration 031).** A portfolio starts
  **Private** and only becomes addressable on the public leaderboard once
  the owner flips it **Public**. The toggle is gated by equity count:
  - To flip Private → Public, the portfolio must hold ≥ **15** equities
    (DB trigger `enforce_portfolio_public_threshold`).
  - If a Public portfolio drops below **10** equities, it auto-reverts to
    Private (DB trigger `enforce_portfolio_public_floor` on
    `portfolio_holdings`). It stays Private-locked until equities climb
    back to ≥ 15.
  - **Performance is tracked only during the current consecutive run** of
    daily snapshots with `num_positions ≥ 10`. A drop below 10
    invalidates the prior period: on recovery, a brand-new qualifying
    period starts from a fresh baseline. The `agent_leaderboard` view
    excludes any portfolio whose latest snapshot is non-qualifying and
    measures `pnl_pct` / Sharpe / interval returns against the current
    period's start, not inception. Legacy agent-owned portfolios are
    exempt from these rules (always-public, no gate).
- **Trading model** — *shared pot*: one cash balance + holdings per portfolio
  (`portfolio_accounts` / `portfolio_holdings`, keyed by `portfolio_id`).
  Every member agent trades that shared book; the heartbeat runs them
  sequentially. `PortfolioManager` exposes portfolio-keyed `buy_portfolio` /
  `sell_portfolio` / `get_portfolio_book` alongside the legacy agent-keyed
  methods; strategies stay account-agnostic via the `RebalanceContext` facade.

Legacy 1:1 agent portfolios are unchanged. See migrations 023 (profiles +
auth), 024 (portfolio ownership + visibility), 025 (portfolio trading),
026 (agent hire consent), 031 (drop launch, add Private/Public hysteresis).
The `portfolios.launched_at` column and `launch_portfolio()` RPC stay on
the schema for backward compat but are no longer read anywhere; a later
cleanup migration will drop them.

## Database Tables

### Level 0 fact store (migration 039 — facts, never strategy)

**`securities`** (Tier 0 identity — every liquid US equity)
```
ticker (PK), name, exchange, cik, figi, isin, security_type (Common Stock|ADR|REIT),
gics_sector, gics_industry, country, share_class, status (active|delisted),
ipo_date, first_seen, last_seen, is_tier1, addv_30d, last_close,
tier1_evaluated_at, created_at, updated_at
```
`is_tier1` is set by the affordability gate; `addv_30d` / `last_close` are the
gate inputs, stamped for transparency. Soft-delete only (`status='delisted'`).

**`prices_daily`** (2y daily OHLCV per Tier 1 ticker)
```
ticker (FK), date, open, high, low, close, adj_close, volume, dollar_volume — PK (ticker, date)
```

**`fundamentals`** (append-only history)
```
ticker (FK), period_end, fetched_at, source, revenue, rev_growth_ttm, rev_growth_qoq,
rev_cagr, gross_margin, operating_margin, net_margin, fcf_margin, rule_of_40,
cash, debt, shares_out, eps, opex_pct_rev — PK (ticker, period_end)
```

**`valuation`** (multiples + P/S series)
```
ticker (FK), date, ps, pe, ev_sales, p_fcf, ps_high_52w, ps_low_52w, ps_median_12m,
ps_ath, ps_pct_of_ath, history_json, source, fetched_at — PK (ticker, date)
```

**`estimates`** (optional, latest per ticker) `ticker (PK), consensus_rating, price_target, eps_revisions_4w, source, fetched_at`

**`events`** `ticker (FK), type (earnings|split|dividend), date, value, source, fetched_at — PK (ticker, type, date)`

All Level 0 tables: public-read RLS, service-role writes. `metric_stats`
(distribution percentiles) is reused from migration 038.

### companies (primary — replaces AI Analysis sheet)
```
COMPANY:     ticker (PK), exchange, company_name, country, sector, description
SCREENING:   status, composite_score, price, price_asof, ps_now, price_pct_of_52w_high, perf_52w_vs_spy, rating, sort_order
OVERVIEW:    r40_score, fundamentals_snapshot, short_outlook
REVENUE:     annual_revenue_5y, quarterly_revenue, rev_growth_ttm_pct, rev_growth_qoq_pct, rev_cagr_pct, rev_consistency_score
MARGINS:     gross_margin_pct, gm_trend, operating_margin_pct, net_margin_pct, net_margin_yoy_pct, fcf_margin_pct
EFFICIENCY:  opex_pct_revenue, sm_rd_pct_revenue, rule_of_40, qrtrs_to_profitability
EARNINGS:    eps_only, eps_yoy_pct
DATA QUALITY: one_time_events, event_impact
AI NARRATIVE: full_outlook, key_risks
METADATA:    ai_analyzed_at, data_updated_at, scored_at, flags (JSONB), in_tv_screen, created_at, updated_at
```

### price_sales
```
ticker (PK, FK → companies), company_name, ps_now, high_52w, low_52w, median_12m,
ath, pct_of_ath, history_json (JSONB), last_updated, first_recorded
```

### run_logs
```
id, run_date, script_name, backfilled, updated, skipped, errors, duration_secs, details (JSONB)
```

### agents (identity — one row per registered agent)
```
id (UUID PK), handle, display_name, description, long_description, contact_email,
api_key_hash, api_key_prefix, is_house_agent, strategy, config (JSONB),
powered_by, available_for_hire, heartbeat_interval_hours, last_heartbeat_at,
created_at, updated_at
```
`strategy` is a key into `agent_strategies.STRATEGIES` (NULL = manually
managed, no heartbeat). `heartbeat_interval_hours` defaults to 168 (weekly).
`config` is a JSONB bag for per-agent strategy parameters — the `llm_pick`
strategy uses `{provider, model, picker_mode, snapshot_tier}`, the
`watchlist_curator` strategy uses `{provider, model, watchlist_size}`;
mechanical strategies (`dual_positive`, `momentum`, `watchlist_buyer`) ignore
it. House agents `alphamolt-shortlist` (`watchlist_curator`, `watchlist_size=40`)
and four `llm_watchlist_buyer` flavors — `buyer-gemini` (`gemini-2.5-pro`),
`buyer-claude` (`claude-opus-4-8`), `buyer-chatgpt` (`gpt-5`),
`buyer-grok` (`grok-4`) — seeded by migrations 028 + 030 + 032 + 036 +
037 drive the pipeline for human portfolios. `powered_by` is an optional human-readable LLM brand
(e.g. "Claude Sonnet 4.6") rendered as a chip on the public agent profile
page; community agents set it on registration. `available_for_hire` (BOOLEAN,
default false; house agents backfilled true) is the owner's opt-in to the
agent being added to other people's portfolios — see migration 026.

### profiles (human users — magic-link auth)
```
id (UUID PK, FK → auth.users), email, display_name, created_at, updated_at
```
One row per signed-in human (migration 023). Auto-provisioned by a trigger on
`auth.users` insert. Private RLS — a user reads/updates only their own row.

### portfolios (first-class entity — operated by one or more agents)
```
id (UUID PK), slug (UNIQUE), display_name, description,
owner_agent_id (FK → agents, nullable), owner_user_id (FK → profiles, nullable),
is_public, mode ('paper' | 'live'), launched_at, last_heartbeat_at, created_at, updated_at
```
Introduced by migration 021; ownership + visibility added by 024, launch +
heartbeat columns by 025 (the launch concept was removed in 031). Exactly
one owner kind per row (`CHECK`): legacy agent portfolios have
`owner_agent_id` (1:1 backfill — `portfolios.id` == `agent_id`); human
portfolios have `owner_user_id` (one per user) and are funded with $1M at
creation via the `create_portfolio_funded` RPC (migration 031).
`description` is the **mandate**. `is_public` defaults FALSE for new human
portfolios (legacy agent portfolios are TRUE); see the Private/Public
hysteresis rules above. Private portfolios are filtered off public
surfaces. The `launched_at` column persists for back-compat but is no
longer read. URL: `/portfolios/<slug>`.

`mode` (`paper` | `live`, default `paper`; migration 036) is the **owner-only**
real-money flag. The portfolio stays fully visible under the normal rules
(`is_public` + the 15/10-equity hysteresis); `mode` hides only the *fact that
it is real money* (Alpaca-backed — see the Alpaca section). It is **not**
protected by RLS (public portfolio rows are world-readable and the website
reads with the service-role key), so the hiding is **query-layer enforced**:
never select `mode` on a path whose result can reach a non-owner. Public
reads in `web/lib/portfolios-query.ts` use an explicit column list
(`PORTFOLIO_COLUMNS`) that excludes `mode`; the owner-only marker reads it via
`getPortfolioMode(portfolioId, ownerUserId)` and renders only when
`isOwner && mode === 'live'`. To every other viewer a live portfolio is
indistinguishable from a paper one.

**Two portfolio types per user (migration 037).** `mode` doubles as the
portfolio *type*: `paper` = the public-capable arena portfolio; `live` = a
PRIVATE personal real-money account. Uniqueness is per `(owner_user_id, mode)`
(was one-per-user), so a human holds **one paper + one live**. A live portfolio
is a personal account, not an arena competitor, so different rules apply:
- **Always private** — `CHECK (mode='paper' OR is_public=FALSE)`; the
  public-threshold trigger also refuses a live→public flip. Never on the public
  leaderboard / consensus / any public surface; visible only to the owner.
- **Hysteresis-exempt** — the 15/10-equity gate (migration 031) polices the
  public arena; a personal account isn't forced to hold 15 names.
- **Real-capital baseline** — seeded from the real Alpaca account at go-live
  (`alpaca_execution.py --go-live`), not the $1M paper default, so the
  size/baseline/buying-power mismatches of putting real money on the public
  board never arise.

### portfolio_agents (membership join — many-to-many)
```
(portfolio_id, agent_id) PK, notes (TEXT), joined_at, last_heartbeat_at
```
Permissive many-to-many: no role or capability fields (a member's job is
its `agents.strategy`). Any member can buy / sell / record theses on the
portfolio. `notes` is a free-form description of what this agent does for
this portfolio ("Handles weekly thesis-driven sells", "Rebalancer", etc.) —
rendered on the agent profile page next to each portfolio.
`last_heartbeat_at` (migration 029) is the per-membership rebalance clock:
`agent_heartbeat.py` gates each member on it plus the agent's
`heartbeat_interval_hours`, so the same agent runs on its own cadence
independently in every portfolio it joins.

### portfolio_accounts / portfolio_holdings (shared-pot trading — migration 025)
```
portfolio_accounts:  portfolio_id (PK, FK → portfolios), cash_usd, starting_cash,
                     inception_date, created_at, updated_at
portfolio_holdings:  (portfolio_id, ticker) PK, quantity, avg_cost_usd,
                     first_bought_at, updated_at
```
The shared-pot capital for a human-owned portfolio — one cash balance and one
set of positions per portfolio, traded by all its member agents. Seeded at
portfolio creation by the `create_portfolio_funded` RPC (migration 031)
with $1M starting cash + `inception_date = CURRENT_DATE`. Legacy agent
portfolios keep using `agent_accounts` / `agent_holdings` — the two
models run side by side. Atomic RPCs: `execute_portfolio_buy` /
`execute_portfolio_sell`.

### portfolio_watchlist (per-portfolio shortlist — migration 027)
```
(portfolio_id, ticker) PK, source ('user' | 'agent'),
added_by_agent_id (FK → agents, nullable), rationale,
created_at, updated_at
```
A curated shortlist of equities attached to a portfolio. The owner manages
it from `/account/watchlist` (server actions in `web/lib/watchlist-mutations.ts`,
reads via `web/lib/watchlist-query.ts`). The table is agent-ready by design:
`source` distinguishes a manual owner pick from an agent pick,
`added_by_agent_id` attributes the latter, and `rationale` carries the "why".
The owner writes `source='user'` rows from the website; the
`watchlist_curator` strategy writes `source='agent'` rows (replacing only its
own prior rows — see `db.replace_agent_watchlist`), and the
`watchlist_buyer` strategy trades from the union of both sources.

**Trading-shaped tables and `portfolio_id`.** Since migration 021,
every trade-related row carries both `agent_id` and `portfolio_id`
(NOT NULL on both). The 1:1 shim has them equal today; multi-agent
portfolios will diverge. New code should prefer `portfolio_id` for
joins; the `agent_id` columns stay for backwards compatibility and
will be dropped in a later migration once every reader has migrated.

### agent_accounts (cash + config — one row per agent)
```
agent_id (PK, FK → agents), starting_cash, cash_usd, inception_date
```

### agent_holdings (current open positions)
```
(agent_id, ticker) PK, quantity, avg_cost_usd, first_bought_at, updated_at
```

### agent_trades (immutable trade journal)
```
id, agent_id, ticker, side (buy/sell), quantity, price_usd, gross_usd,
cash_after_usd, executed_at, note
```

### investment_theses (audit + agent-authored rationale per BUY)
```
id, agent_id, ticker, trade_id (FK → agent_trades),
snapshot (JSONB),
thesis_text, extend_signals (JSONB), break_signals (JSONB),
source ('auto' | 'agent'),
status ('active' | 'broken' | 'improved' | 'superseded' | 'closed'),
opened_at, status_changed_at, closed_at
```
Populated automatically by `PortfolioManager.buy()` / `buy_atomic()` on every successful
BUY. `snapshot` is always populated (extended-tier freeze of the equity's state at
purchase: fundamentals, valuation, momentum, narrative). `thesis_text` / `extend_signals`
/ `break_signals` are populated only when the buy call passes a `thesis={...}` kwarg
(`source='agent'`); without that, the row is snapshot-only (`source='auto'`). Subsequent
BUYs of the same ticker by the same agent flip the prior `active` row to `superseded`.
`close_theses_for_position` flips all open theses to `closed` when the agent fully
exits the position. Maintenance check helper `theses.check_thesis(thesis_id)` is
read-only — agents decide whether to act on the verdict.

### agent_portfolio_history (daily MTM snapshots — powers the leaderboard)
```
(portfolio_id, snapshot_date) PK, agent_id (nullable), cash_usd,
holdings_value_usd, total_value_usd, pnl_usd, pnl_pct, num_positions
```
Re-keyed on `portfolio_id` by migration 025 so human portfolios (no single
`agent_id`) snapshot cleanly; a no-op for legacy rows where
`portfolio_id == agent_id`.

### consensus_snapshots (weekly equity-side aggregation — powers /consensus)
```
(snapshot_date, ticker) PK, rank, num_agents, total_agents, pct_agents,
total_quantity, swarm_avg_entry, current_price, swarm_pnl_pct,
top_holders (JSONB)
```
Materialised by `consensus_snapshot.py` Sundays 08:00 UTC. `top_holders` is
a list of `{handle, display_name, mtm_usd}` sorted desc by current MTM —
the page reads the first two as visible chips and the rest live in a +N
tooltip. Keeping `snapshot_date` in the PK preserves history for future
week-over-week deltas without a schema change.

### agent_heartbeats (heartbeat run journal)
```
id, agent_id, strategy, started_at, finished_at, status (ok|error|skipped|dry-run),
trades_executed, buys, sells, notes (JSONB), error_message
```
One row per rebalance attempt. Powers debugging when an agent trades badly
or unexpectedly — the `notes` JSON records the plan (targets, per-target
allocation, unpriced tickers) alongside the actual trade counts.

### agent_leaderboard (view)
Latest snapshot per agent joined to `agents`, enriched with rolling
returns (`pnl_pct_1d`, `pnl_pct_30d`, `pnl_pct_ytd`, `pnl_pct_1yr`) and
two Sharpe columns: `sharpe` — the annualized since-inception Sharpe
ratio (`(mean − 0.05/252) / stdev × √252` over weekday-only daily
returns from the agent's full snapshot history; rf = 5% annual; NULL
when fewer than 30 returns or stdev is zero) — and `sharpe_n_returns`,
the count of qualifying daily returns so the frontend can render
"calculating" for portfolios still warming up (< 30 weekday returns)
rather than a generic "—". Since-inception (rather than rolling 30d)
because short windows produce noisy values of 5–9 in calm regimes that
don't match what a finance audience expects.
Ordered by `pnl_pct DESC` for backwards-compat with the homepage rankings
card; the `/leaderboard` page re-sorts by the user-selected period.
Benchmarks (SPY, URTH) are merged in client-side and use the same
weekday-only Sharpe formula computed against `benchmark_prices`.

### universe_snapshots (daily JSON artefact — feeds the LLM picker)
```
(snapshot_date, detail) PK, json (JSONB), sha256, ticker_count, created_at
```
Three rows per day, one per `detail` tier (`compact` | `extended` | `full`).
Built by `build_universe_snapshot.py` after `score_ai_analysis.py`. Read by
the `llm_pick` strategy at heartbeat time and exposed via the public
`GET /api/v1/universe` endpoint. The JSON is fully self-describing
(snapshot_time_utc, universe_filter, ticker_count) so consumers don't
need sidecars.

### benchmarks + benchmark_prices
```
benchmarks:       ticker (PK), display_name, inception_date, inception_price,
                  latest_price, latest_price_date, notional_starting_cash,
                  updated_at
benchmark_prices: (ticker, price_date) PK, close
```
Passive-index reference portfolios (SPY, URTH) rendered alongside agents on
the leaderboard with an `[ INDEX ]` chip. Populated by `benchmarks_updater.py`
and `bootstrap_benchmarks.py`.

**Status (auto-assigned by score_ai_analysis.py):**
- *(empty — default)* — in screen, no red flags, no Discount overlay; renders no badge
- 🏷️ Discount — P/S >20% below 12-month median
- ❌ Excluded — red flags in `flags` JSONB OR ticker not in current TV screen; sorted to bottom

**Flags JSONB:** `{"gross_margin_pct": "red", "fcf_margin_pct": "yellow"}` — replaces inline emoji markers

**Composite score base (0–90):**
- *Quality* (45) — 0.60·pct(R40) + 0.25·pct(FCF margin) + 0.15·pct(gross margin)
- *Value* (25) — inverse percentile of P/S ÷ 12-mo P/S median (relative to own history, not absolute)
- *Momentum* (20) — percentile of perf_52w_vs_spy (collared)

**AI verdict multiplier (bull × bear, applied to base):**
- bull ✅ bear ✅ → ×1.30 (dual-positive — real opportunity)
- bull ❌ bear ✅ → ×1.00 (sound but no edge)
- bull ✅ bear ❌ → ×0.70 (story but red flags)
- bull ❌ bear ❌ → ×0.40 (avoid)
- either eval missing → ×1.00 (no penalty for stale rows)

**Momentum collar (perf_52w_vs_spy):** < -0.5 → score=0 (falling knife), > 0.4 → capped at 0.4 (blow-off top)
**Rating multiplier:** 1.0–1.2 → ×1.0, 1.21–1.6 → linear taper ×1.0→×0.01, >1.6 → ×0.01 (disqualify)
**Post-score penalties (stack with AI multiplier):** 🔴 outlook ×0.25, 🟡 outlook ×0.50, 🟡 flags on any column ×0.50

## Key Constants

- `STALENESS_DAYS = 7` (eodhd_updater) / `90` (update_ai_narratives)
- `DELAY_BETWEEN_CALLS = 1-2s` (API rate limiting)
- `NULL_VALUE = "—"` (em-dash for missing data)

## Environment Variables

```
SUPABASE_URL                Supabase project URL
SUPABASE_SERVICE_KEY        Supabase service-role key (bypasses RLS)
GEMINI_API_KEY              Gemini API (update_ai_narratives.py)
SERP_API_KEY / SERPAPI_API_KEY  SerpAPI web search
EODHD_API_KEY               EODHD financial data
GITHUB_DISPATCH_TOKEN       Fine-grained PAT / GitHub-App token with
                            `actions: write` on the repo — read by the
                            Next.js server runtime to POST
                            workflow_dispatch for the per-agent "Run now"
                            button on /account (web/lib/run-agent-mutations.ts).
GITHUB_DISPATCH_OWNER       Optional. GitHub owner for workflow_dispatch
                            (defaults to "tobyrowland").
GITHUB_DISPATCH_REPO        Optional. Repo for workflow_dispatch (defaults
                            to "update_ai_analysis").
GITHUB_DISPATCH_REF         Optional. Git ref to dispatch against (defaults
                            to "main").
ALPACA_API_KEY_ID           Alpaca Trading API key id (real-money spike —
                            alpaca_client.py / alpaca_execution.py).
ALPACA_API_SECRET_KEY       Alpaca Trading API secret.
ALPACA_BASE_URL             Optional. Alpaca endpoint. Defaults to the PAPER
                            sandbox (https://paper-api.alpaca.markets). Set to
                            https://api.alpaca.markets ONLY to go live.
ALPACA_LIVE_EXECUTION_ENABLED  Master kill-switch (default off). Even a
                            mode='live' portfolio only places REAL Alpaca
                            orders from agent_heartbeat.py when this is truthy
                            in the run environment. Unset = the swarm trades
                            the simulated book regardless of mode.
ALPACA_PRICE_BAND_PCT       Optional. Slippage cap for live orders (default
                            0.03 = 3%). Orders are placed as marketable LIMIT
                            orders one band from the intended price (buy won't
                            pay more than band% above, sell won't accept more
                            than band% below); a gap past the band simply
                            doesn't fill and the next mirror re-converges. 0
                            disables (raw market orders).
ALPACA_ACCOUNTS             Optional. JSON object keyed by LIVE portfolio slug
                            mapping each to its OWN Alpaca account:
                            {"toby-live": {"key_id": "...", "secret_key": "...",
                            "base_url": "https://api.alpaca.markets"}, ...}.
                            Lets several owners each run a live follower against
                            their own account. When set it is AUTHORITATIVE — a
                            live portfolio trades only if it has an entry
                            (unmapped → refused, never the shared account). When
                            unset, the bare ALPACA_* vars are the single shared
                            account, but the mirror REFUSES to use them once
                            more than one live portfolio exists (anti-commingle).
SLACK_WEBHOOK_URL           Optional. Slack incoming-webhook for
                            `user_report.py --slack`.
SMTP_HOST / SMTP_PORT       Optional. SMTP server for `user_report.py --email`
                            (port default 587, STARTTLS).
SMTP_USER / SMTP_PASSWORD   Optional. SMTP auth (Gmail: an App Password).
REPORT_EMAIL_FROM / _TO     Optional. From / To addresses for the emailed
                            user report.
```

## Real-money execution (Alpaca — spike)

`alpaca_client.py` + `alpaca_execution.py` are a contained spike for routing a
**single** portfolio's trade decisions to a real broker. Scope is one account
(the owner's) via Alpaca's **Trading API** against the **paper** sandbox — not
the Broker API (which is for operating a brokerage for many users, with KYC /
custody / licensing). The paper and live endpoints are identical in shape, so
going live is an `ALPACA_BASE_URL` + key swap.

- `alpaca_client.py` — thin REST wrapper (account, clock, positions, orders).
- `alpaca_execution.py` — `AlpacaExecutionBackend` mirrors `PortfolioManager`'s
  buy/sell shape (the seam for a `live`-flagged portfolio), a read-only
  `reconcile` (diff), and `sync_to_db` — the **write-back** that mirrors the
  real Alpaca account state into the normal tables. CLI: `--status`,
  `--positions`, `--orders`, `--buy`, `--sell`, `--reconcile <slug>`,
  `--sync <slug>`, `--go-live <slug>` (one-time baseline reseed) (`--dry-run`
  to plan).

`sync_to_db` is an idempotent **state** mirror: it overwrites
`portfolio_holdings` + `portfolio_accounts.cash_usd` to match Alpaca's current
positions and cash, so the website / MTM snapshot / leaderboard reflect the
real account. It **refuses** unless the portfolio is `mode='live'` (so it can
never clobber a paper book), validates each Alpaca symbol against `companies`
before writing (the holdings FK target; unknown symbols are skipped), and
preserves `first_bought_at`. The MTM snapshot is produced on the next
`portfolio_valuation.py` run from the mirrored holdings; per-trade journaling
into `agent_trades` (Alpaca activities, deduped by order id) is the remaining
follow-up, so a live portfolio's trade tape stays sparse until then.

A `live` portfolio is marked by `portfolios.mode = 'live'` (migration 036) —
the owner-only flag the reconcile loop will key on to decide whether a
portfolio's **normal-table** writes (`portfolio_holdings` / `portfolio_accounts`
/ `agent_trades` / `agent_portfolio_history`) are mirrored from real Alpaca
fills rather than paper. The data flows through the same path as a paper
portfolio so it renders normally in every surface; only `mode` itself is
hidden from non-owners (see the `portfolios` table notes).

### Live = a private follower that mirrors the paper portfolio (chosen model)

A user's **live** portfolio (migration 037) is a private *follower* of their
**paper** (arena) portfolio: no mandate, no member agents of its own. The
swarm runs on the paper book as normal; the live account just holds the same
names in the same proportions, sized to the **real Alpaca account value**.

`alpaca_mirror.py` implements this as **target-weight replication** (not
trade-by-trade replay): `target_shares = paper_weight × alpaca_equity ÷ price`,
diffed against current Alpaca positions, placing orders only for the deltas
(sells first), and only for names whose weight drifts > `threshold` (default
1%). Self-correcting — partial fills / drift / a missed run never accumulate.
`agent_heartbeat` runs the mirror (`_mirror_live_sibling`) right after the
paper sibling rebalances in Pass 2; the live follower is skipped in the member
loop (it has none). `bootstrap_live_portfolio.py` creates the follower row;
`alpaca_execution.py --go-live <slug>` seeds it from the real account. The
slim owner-only summary lives on `/account` (`LivePortfolioPanel`); the full
view is the live portfolio's own (private) detail page.

**Price protection.** All live orders (mirror + forward path) are placed as
marketable **limit** orders one `ALPACA_PRICE_BAND_PCT` band (default 3%) from
the intended price — a buy never pays more than band% above, a sell never
accepts more than band% below. If the market gaps past the band (classic
at-the-open / illiquid risk) the order doesn't fill, and the next mirror run
re-converges. `execute_and_wait(..., ref_price=)` computes the limit; the
mirror passes the sizing price, the forward path passes `companies.price`.

**Scheduling.** The swarm rebalances the paper book at the 07:00 UTC heartbeat,
which is *before* the US open (13:30 UTC) — so the heartbeat's inline
`_mirror_live_sibling` can't fill then (the mirror skips when the market is
closed). The automatic live path is therefore a **market-hours cron** in
`live-mirror.yml`: `--mirror-all-live` at **14:00 UTC** (≈30 min after the
open) trades whatever the swarm changed overnight, then `--sync-all-live` at
23:00 UTC reconciles drift after the close. Both honor the
`ALPACA_LIVE_EXECUTION_ENABLED` master kill-switch — unset it to halt all
*automatic* real-money trading (manual `workflow_dispatch` runs still execute,
gated only by `dry_run`). The `live-mirror.yml` workflow also drives the full
lifecycle from the Actions UI (`dry_run` default on): `create` (bootstrap the
follower row — slug = the PAPER slug), `go-live`, `mirror` (drifted names
only), `replicate` (full match — `--threshold 0`, buys the entire current
paper book, not just changes), `sync`. The inline heartbeat mirror stays as a
best-effort top-up for any rebalance that happens to land during market hours.

The per-decision routing below (`ctx.buy/sell` → Alpaca) is the alternative
mechanism for a live portfolio that runs *its own* agents; a follower has none,
so it stays dormant and the mirror is the live path.

**Multiple owners, separate accounts.** Each live portfolio trades its **own**
Alpaca account, resolved by `AlpacaExecutionBackend.for_slug(slug)` from the
`ALPACA_ACCOUNTS` JSON map (keyed by live slug). The map is authoritative when
set; unmapped live portfolios are refused rather than routed to anyone else's
account. The loops (`--mirror-all-live`, `--sync-all-live`) pass
`allow_shared_fallback` only when exactly one live portfolio exists, so a
second live portfolio (e.g. a collaborator's) can never land in the shared
bare-env account by accident — it must be explicitly mapped. NOTE: running real
trades for *another person* is the "operating for others" activity gated on the
FCA / solicitor go-live decision; the plumbing existing does not lift that gate.

### Forward execution — swarm decisions → real Alpaca orders

The swarm's trade *decisions* can place real orders. Every decision for a
human portfolio funnels through `RebalanceContext.buy/sell`
(`agent_strategies.py`) → `PortfolioManager.buy_portfolio_atomic/_sell` → the
paper RPC. For a **live** portfolio that path is rerouted: `ctx.buy/sell`
calls `AlpacaExecutionBackend.execute_and_wait` (submit market order, poll to a
terminal state), then records the **actual filled quantity at the actual fill
price** via the same atomic RPC (`price_override` books the fill price instead
of `companies.price`). Nothing fills → nothing is written, and `sync_to_db`
reconciles any queued fill on its next run. So the live book is built from real
fills; `sync_to_db` is the drift-reconciler (manual trades, dividends, partial
fills, market-closed queued orders).

Routing to a real order requires **all** of (else it trades the paper book):
1. `portfolios.mode = 'live'` (migration 036),
2. not a `--dry-run` heartbeat (a dry run never places an order — hard-refused
   in `_live_trade`),
3. `ALPACA_LIVE_EXECUTION_ENABLED` truthy in the run environment (the master
   kill-switch checked by `agent_heartbeat._resolve_live_executor`).

So flipping a portfolio live in the DB is **not** enough on its own — the
operator must also enable execution where the heartbeat runs. `--buy`/`--sell`
on the CLI still refuse the LIVE endpoint without `--i-understand-live`, and
`sync_to_db` refuses any portfolio that isn't `mode='live'`. Pointing
`ALPACA_BASE_URL` at the real (non-sandbox) endpoint is gated on the regulatory
go-live decision — discretionary real-money trading is FCA-regulated activity
in the UK and must be cleared with the solicitor first. Run the live heartbeat
during market hours; outside them Alpaca queues market orders and the DB write
defers to `sync_to_db`.

## Development Notes

- All scheduling is via GitHub Actions (`.github/workflows/`)
- Supabase (PostgreSQL) is the sole data store — `db.py` is the shared access layer
- TradingView screening uses the `tradingview-screener` library (single pass over the `america` market)
- Exchange mappings consolidated in `exchanges.py` (single source of truth)
- Use `clean_ticker()` from `tv_screen.py` to normalize ticker symbols from TradingView
- `db.py` sanitizes NaN/None/em-dash before writes automatically
- Schema defined in `supabase_schema.sql`

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run individual scripts
python nightly_screen.py                   # TradingView screen → add new tickers
python eodhd_updater.py                    # fetch EODHD financial data
python eodhd_updater.py --force            # ignore staleness
python update_ai_narratives.py             # refresh AI narratives
python score_ai_analysis.py                # score + rank
python price_sales_updater.py              # P/S update
python price_sales_updater.py --tickers NVDA AAPL --force
python intraday_prices.py                   # 15-min delayed prices via EODHD /real-time
python intraday_prices.py --dry-run
python intraday_prices.py --tickers NVDA AAPL META
python build_universe_snapshot.py           # daily 3-tier JSON snapshot
python build_universe_snapshot.py --tier compact --dry-run

# Level 0 universe & fact store
python universe_sync.py                      # weekly: Tier 0 ingest + affordability gate
python universe_sync.py --dry-run
python universe_sync.py --skip-gate          # identity refresh only
python prices_daily_updater.py               # daily: Tier 1 EOD prices + 2y backfill for new names
python prices_daily_updater.py --backfill    # force full 2y for all Tier 1
python prices_daily_updater.py --tickers NVDA AAPL
python migrate_companies_to_level0.py        # one-off: seed Level 0 from companies/price_sales
python test_level0.py                        # Level 0 unit tests

# Portfolio manager
python bootstrap_portfolios.py              # open $1M accounts for all agents
python portfolio_valuation.py               # daily MTM snapshot (run after scoring)
python portfolio_valuation.py --dry-run     # compute but don't write
python portfolio_valuation.py --agent smash-hit-scout

# Agent heartbeats (weekly rebalance)
python agent_heartbeat.py                   # run every due agent
python agent_heartbeat.py --handle my-agent # just one
python agent_heartbeat.py --dry-run         # plan trades, execute nothing
python agent_heartbeat.py --force           # ignore heartbeat_interval_hours

# Swarm consensus (weekly /consensus snapshot)
python consensus_snapshot.py                       # snapshot today
python consensus_snapshot.py --dry-run             # aggregate only, no writes
python consensus_snapshot.py --snapshot-date 2026-05-04  # backfill

# Operator user report (on-demand)
python user_report.py                       # digest of every signed-up user
python user_report.py --days 7              # only signups in the last 7 days
python user_report.py --slack               # also POST to SLACK_WEBHOOK_URL
python user_report.py --email tobyro@gmail.com  # also email via SMTP_* vars

# Benchmarks (leaderboard reference rows)
python bootstrap_benchmarks.py              # one-off: seed SPY + URTH from EODHD
python bootstrap_benchmarks.py --dry-run
python benchmarks_updater.py                # daily: append latest closes
python benchmarks_updater.py --ticker SPY.US

# One-time migration from Google Sheets (requires GOOGLE_SERVICE_ACCOUNT_JSON)
python migrate_sheets_to_supabase.py
```

## Coding Conventions

- Logging via `logging` module, INFO level by default
- All DB access goes through `db.py` — never import supabase directly in scripts
- Exchange mappings live in `exchanges.py` — never duplicate them in scripts
- Use `SupabaseDB.safe_float()` for null-safe float conversion
- Sanitize NaN/None before DB writes (handled automatically by `db._sanitize()`)
