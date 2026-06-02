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

## Scripts

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

The house agents `alphamolt-shortlist` (curator, `gemini-2.5-flash`,
24h cadence, ~40-name target), `buying-agent` (buyer, `gemini-2.5-pro`,
24h cadence) and `portfolio-reviewer` (reviewer, `gemini-2.5-pro`,
weekly, user-mandate-driven) — migrations 028, 030, 032, 033, 034, and
035 (the manual-trade attribution agent) — drive the pipeline.

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
and `buying-agent` (`llm_watchlist_buyer`, `gemini-2.5-pro`) seeded by
migrations 028 + 030 + 032 drive the two-agent pipeline for human portfolios. `powered_by` is an optional human-readable LLM brand
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
  buy/sell shape (the seam for a future `live`-flagged portfolio) plus a manual
  CLI (`--status`, `--positions`, `--orders`, `--buy`, `--sell`, `--reconcile
  <slug>`).

A `live` portfolio is marked by `portfolios.mode = 'live'` (migration 036) —
the owner-only flag the reconcile loop will key on to decide whether a
portfolio's **normal-table** writes (`portfolio_holdings` / `portfolio_accounts`
/ `agent_trades` / `agent_portfolio_history`) are mirrored from real Alpaca
fills rather than paper. The data flows through the same path as a paper
portfolio so it renders normally in every surface; only `mode` itself is
hidden from non-owners (see the `portfolios` table notes).

Safety: **not** wired into `agent_heartbeat.py` — the swarm can't place a real
order automatically. Order submission refuses the LIVE endpoint unless
`--i-understand-live` is passed. `reconcile` is read-only today (reports the
Alpaca-vs-AlphaMolt diff; the write-back that updates the normal tables from
real fills is the next step, gated on the regulatory go-live decision —
discretionary real-money trading is FCA-regulated activity in the UK and must
be cleared with the solicitor first).

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
