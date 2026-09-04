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
04:30           price_sales_updater.py    P/S ratio tracking + 52w history
04:45           earnings_updater.py       Ingest Tier-1 earnings dates from the EODHD earnings calendar → events table (next ~90d + last 14d). Gives the arena visibility on when each name next reports
05:00           verdict_evaluation.py     Consolidated bull (Claude) + bear (Gemini) over ONE shared batch/clock — 300 stalest Tier-1 by min(bull_at,bear_at). Models stay distinct (adversarial); only batch+clock shared so bull_at==bear_at. Runs after the Level 0 data block settles, before the 07:00 heartbeat
05:15           research_evaluation.py    Shared per-equity research card (moat/durability/earnings-quality/balance-sheet, 1-5 + break signals) PLUS the page narrative (short/full outlook + key risks) — 300 stalest Tier-1, one per-ticker Gemini call
05:30           portfolio_valuation.py    Mark-to-market every agent + human portfolio
06:00           build_universe_snapshot.py  Daily universe JSON snapshot (3 tiers)
06:30           congress_trades.py        Ingest Nancy Pelosi's House PTR disclosures → congress_trades (feeds the Pelosi-mirror agent). Runs before the heartbeat so a fresh filing mirrors the same morning
07:00           agent_heartbeat.py        Rebalance loop — every agent / human-portfolio member that is due on its own heartbeat_interval_hours cadence
08:30           award_badges.py           Badge sweep — grants earned badges (alpha/process/honesty/swarm) + closed-period Champions. Runs after the heartbeat + MTM snapshot settle. Idempotent (also the backfill)

Weekly (Sunday UTC):
Sun 08:00       consensus_snapshot.py     Aggregate agent_holdings → consensus_snapshots (powers /consensus)

Every 15 min (Mon–Fri, 13:00–22:00 UTC):
                intraday_prices.py        Refresh companies.price + price_asof via EODHD /real-time (15-min delayed quotes)
                portfolio_valuation.py    Re-mark every agent portfolio against the fresh price (overwrites today's row in agent_portfolio_history)

Every 4h:
                moltbook_heartbeat.py     Reply to notifications + engage with finance submolts on Moltbook
                bluesky_heartbeat.py      Reply to mentions + AI-in-finance posts + posts about top swarm-consensus tickers on Bluesky

Every 30 min:
                lifecycle_emails.py       Lifecycle emails: A1 welcome to new signups + A2 setup nudge to users stuck pre-portfolio (send-once ledger)
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
`investment_theses` (mandatory, no opt-out). The snapshot carries the equity's
metrics **plus their data vintage** (`fundamentals_asof` = latest fundamentals
period_end, `valuation_asof` = latest valuation date, `ai_analyzed_at`) so a
reader can see how old the frozen numbers were at buy time — surfaced in the
portfolio page's thesis dropdown. `_SNAPSHOT_FIELDS` is kept in lock-step with
`web/lib/theses.ts`. When the buy call passes a `thesis={...}`
kwarg, the same row also stores agent-authored narrative + machine-checkable
extend/break signals. Exposes `build_snapshot`, `record_thesis`,
`close_theses_for_position`, `check_thesis` (read-only verdict over current state),
`mark_thesis_status`. Signal operators: `>`, `>=`, `<`, `<=`, `==`, `!=`,
`change_pct_lt`, `change_pct_gt`. See migration 020.

### llm_providers.py — reasoning depth (`thinking_level`)
The single dispatch surface every agent's LLM call goes through
(`call_llm(provider=…, model=…)`). Two parameters matter for the Gemini
agents (migration 087):

- **`thinking_level`** ∈ `minimal | low | medium | high` — how much
  deliberation to buy per call, WITHOUT changing brain. Gemini 3 replaced
  2.5's numeric `thinking_budget` with this; sending both in one request is a
  hard 400, so the adapter only ever sends the level, and only to a Gemini 3
  model (`_is_gemini_3`, a family-PREFIX match so a new point release can't
  silently drop back onto the 2.5 path). Other providers ignore the key, so it
  is safe to set on any `agents.config`. Thinking tokens bill at the OUTPUT
  rate, so this is the knob that decides the daily bill — see the per-agent
  depth split under the house agents.
- **`fallback_model`** — used ONLY when the primary model id turns out not to
  exist (`LLMModelUnavailableError`, matched off the provider error text), never
  for a transient failure. It exists because `gemini-3.1-pro-preview` is a
  PREVIEW id: when Google retires one, a plain retry loop turns the buyer and
  reviewer into permanent no-ops that report "no candidates met the conviction
  threshold" — indistinguishable from a quiet market. The fallback logs at
  ERROR (a human must repoint `agents.config`) and inherits the requested
  depth, so it is a cheaper brain, not a shallower question.

Two Gemini-3 behaviours are enforced in the adapter rather than trusted to
each config row:
- **Temperature floor.** Gemini 3 is documented to degrade below its 1.0
  default ("looping or degraded performance, particularly in complex …
  reasoning tasks"); every `agents.config` in this repo carries the
  Gemini-2.5-era `0.2`, so `_gemini_temperature` clamps up to 1.0 for 3.x
  only. A higher value is never lowered.
- **Cost accounting.** Google reports thinking tokens in a SEPARATE
  `thoughts_token_count` but bills them as output, so `_gemini_output_tokens`
  sums both — reporting only `candidates_token_count` under-states a
  deep-thinking run by an order of magnitude.

**Anthropic and `temperature`.** The adapter asks the installed SDK's
`messages.stream` whether it takes a `temperature` kwarg and only sends it if
so (`_accepts_temperature`). anthropic **1.0.0 removed `temperature` and
`top_p` outright** — no `**kwargs`, so passing it is a `TypeError` raised
*before* any HTTP request, which is not an `APIError` and so slipped past the
existing drop-and-retry path. `requirements.txt` pins `anthropic>=0.40.0`, so
the day a runner resolved 1.0.0 every SDK-based Claude call died with
"Messages.stream() got an unexpected keyword argument 'temperature'":
`double_down` evaluated 0 of 16 held names and `buyer-claude` would have done
the same. (`bull_evaluation` was untouched — it calls the REST API over curl,
not the SDK, which is why bull verdicts kept landing throughout.) The probe
reads the bound method rather than a version string or an import path, so it
survives upgrades in both directions, and treats an unreadable signature or one
with `**kwargs` as accepting — the API-level fallback still covers a model that
rejects the parameter at request time. Pinned by
`tests/test_llm_providers_anthropic.py`, whose stub now carries the real 1.0.0
`__signature__`: the previous stub took `**kwargs` and so was more permissive
than the SDK it stood in for, which is exactly how the failure reached
production through a green suite.

SDK: **`google-genai`** (`from google import genai`). The legacy
`google-generativeai` was deprecated Nov 2025 and cannot reach the Gemini 3
family or `thinking_level` at all; it survives as a fallback for pinned 2.5
configs only, and a 3.x model without the new SDK fails loudly rather than
quietly answering a different question. Pinned by
`tests/test_llm_providers_gemini.py`.

**Why not the literal Deep Research models.** Google also ships
`deep-research-preview-04-2026` / `-max-`, which are genuinely deeper. They run
only through the Interactions API as background jobs, take 5-20 minutes, and
cost $1-3 (max: $3-7) *per task*. The buyer evaluates up to 40 candidates per
portfolio per day, so that is $40-120/day for one portfolio inside a 60-minute
Actions job. The amortised slot — `research_evaluation.py`, one card per equity
shared by every portfolio — is where that model would earn its cost.

### returns.py
Time-weighted return — the only return that survives a deposit (migration 090).
Pure: no DB, no clock (`tests/test_returns.py`, `tests/test_twr_wiring.py`).

**Why it exists.** Every percentage the system reported was computed from raw
portfolio VALUE, which is only a return when no money moves. That held while
every portfolio was a paper book funded once with $1M at creation; it broke the
day live **sleeves** arrived (migration 083), which are funded in tranches. On
2026-09-02 the Scrappy Fightback live sleeve reported **+0.80%** against its
paper twin's **+6.28%** — read literally, catastrophic execution. It was
arithmetic: different windows (the paper book earned +2.46% before the sleeve
existed), and $29,600 of the sleeve's $39,600 baseline had arrived six days
earlier. The same flaw sat in the leaderboard, worse: its value-based
`pnl_pct` reported the sleeve at **+305%**, nearly all of it deposits, and
`pnl_pct_1d` read ~+43% on the day $12,149 was credited — a number that then
entered the Sharpe stdev as if it were a market move.

**The rule.** `r_t = (V_t − F_t) / V_{t−1} − 1`, chained into a cumulative
`twr_index` (base 1.0 at a portfolio's first snapshot). The return between any
two dates is the ratio of their indices. Removing the flows gives the sleeve
+3.12% against the paper book's +3.74% over the same window — a real but
ordinary 0.6pp of cash drag plus one day of marking lag.

**Two questions, two numbers.** This does not replace the dollar figure: "you
contributed $39,600.61 and hold $39,916.27" is unchanged, and `starting_cash`
stays the sum of contributions. What changes is that the PERCENTAGE stops
sharing that denominator — "how much have I made" and "how good is this
strategy" are different questions, and only the first is answerable from a
cost basis.

**Why it is safe to ship.** A paper portfolio has no `portfolio_cash_ledger`
rows at all, so `flow_usd` is always 0 and the index is mathematically
identical to the value ratio it replaces — not one public leaderboard number
moves. Every new expression in the view also COALESCEs to the old value-based
one when `twr_index` is NULL, so the view is correct between the migration and
the backfill and for any row the writer misses.

Conventions worth knowing, each pinned by a test:
- **Flows are end-of-day** (`V_t − F_t`). Snapshots are daily closes and flows
  land intraday, so nothing stored can say whether a deposit preceded the day's
  move; crediting the day to capital already there understates the deposit day
  slightly and washes out. Dividing by `V_{t−1} + F_t` instead would assume a
  16:00 deposit worked all day.
- **A portfolio's first snapshot is always 1.0.** The funding that created it
  is not a return, however far the first mark sits from the money paid in (the
  sleeve was marked $145 below its $9,999.97 in-kind funding on day one).
- **`baseline-reset` is not a flow** (`db.NON_FLOW_LEDGER_REASONS`): it
  corrects a number, nothing moves, and counting it would delete a real return.
- **A sleeve emptied by a transfer records no loss** — the withdrawal is added
  back, so draining Alphamolt (House) to $0 is not −100%.
- **A genuine wipeout stays wiped out**, and `advance_index` (the daily writer's
  one step) must agree with `twr_index` (the backfill's whole series) through
  it: both write the same column, so a disagreement would make a portfolio's
  reported history depend on which process last touched it.

Writer: `portfolio.snapshot_all` reads the day's flows and each portfolio's
prior snapshot in two bulk queries, then writes `flow_usd` + `twr_index` per
row. It chains off the row STRICTLY BEFORE today, because the 15-minute
intraday job rewrites today's row repeatedly and chaining off a value it is
about to replace would compound a partial day against itself. Both reads fail
soft — losing a day's index is recoverable by backfill, losing the snapshot is
not. Backfill/repair: `python backfill_twr.py [--dry-run] [--portfolio ID]`,
which shares the same pure module.

### thesis_policy.py
The owner-configured **sell discipline** (migration 086) — the rules a thesis's
signals live under, stored on `portfolios.thesis_policy`. Pure: no DB, no LLM,
no clock of its own (callers pass `now`), unit-tested in
`tests/test_thesis_policy.py` against the real production decisions it
prevents.

**Why it exists.** A buyer, when it opens a position, also authors the
`break_signals` that will later justify selling it — the optimist writes its own
falsification test and a different agent enforces it. Nothing constrained what
could be written, and three failure modes followed (documented with evidence in
`docs/case-studies/scrappy-fightback-trading-record.md`): a break signal
identical to the screen's own entry filter (`perf_52w_vs_spy < -20` on a screen
that filters `perf_52w_vs_spy < -20` — every candidate arrived pre-broken); an
*extend* signal read as a break (sold while the reviewer's own note said no
break signal had fired); and no holding period at all (three positions bought
and sold inside 90 seconds, because the swarm runs buyers before reviewers over
the shared book).

**Why portfolio-level, not an agent knob.** Per-agent settings live in
`portfolio_agents.config` and reach exactly one member. The buyer WRITES break
signals and the reviewer ACTS on them, so a policy on either alone cannot bind
the other.

Three keys, each enforced at one site (`resolve_policy` fills every missing key
from `DEFAULTS`, so `{}` is a complete policy and pre-086 rows behave
identically):
- `grace_period_days` (default **30**, 0 disables) — `portfolio_reviewer` skips
  positions younger than this entirely, journalling them as
  `skipped_in_grace_period`. The owner's manual Sell button stays the escape
  hatch for a genuine blow-up.
- `require_fired_break_signal` (default **on**) — the reviewer refuses a SELL
  unless a recorded break signal is actually firing per `theses.check_thesis`.
  Self-disabling where there is nothing to check (no thesis, no signals, failed
  oracle), so a position can never become unsellable; suppressed sells are
  journalled under `verdicts.sell_blocked_by_policy` rather than folded into the
  HOLD list.
- `relative_fields_change_only` (default **on**) — price-relative fields
  (`RELATIVE_FIELDS`: `perf_52w_vs_spy`, `price_pct_of_52w_high`, `ps_now`,
  `composite_score` — `price` is deliberately EXCLUDED: `change_pct_*` compares
  an absolute difference, so on a raw share price the same number means a 9.6%
  stop on a $52 name and 0.28% on an $1,800 one; banning the static form would
  outlaw the only sane price stop and permit one that silently misbehaves) may not
  carry a static DOWNSIDE threshold (`<`, `<=`). Such a threshold says where the
  stock IS, which on a screen selecting beaten-down names is usually already true
  at purchase; the change-since-buy form (`change_pct_lt` / `change_pct_gt`) is
  structurally immune because at buy the delta is zero. Applied in
  `llm_watchlist_buyer` AFTER the research-card merge so inherited signals are
  policed too, and to extend signals as well.
  **The rule is kind-specific** (`signal_permitted(signal, policy, *, kind=)` —
  `kind` is a REQUIRED keyword, because either default would be silently wrong
  for the other kind), since break and extend signals fail in opposite
  directions. A static UPSIDE threshold (`TAKE_PROFIT_OPS`: `>`, `>=`) is
  permitted on a **break** signal: `ps_now > 15` is a take-profit, and on a
  screen selecting cheap beaten-down names it sits far above where the stock is,
  so it cannot be the born-broken failure (and `theses._drop_already_true` still
  rejects it against the real buy snapshot if it somehow is). The SAME threshold
  on an **extend** signal is the unreachable wish the reviewer reached for when
  nothing had fired — `perf_52w_vs_spy > 0` on a name the screen guarantees is
  below -20 — so extends keep change-ops-only. `==` / `!=` stay banned on both.
  The buyer's prompt teaches all of this; `tests/test_buyer_signal_policy.py`
  pins the WIRING (that each call site passes the right `kind`, and that the
  prompt and `RELATIVE_FIELDS` agree), which no test of the pure function can.

- `rebuy_cooldown_ignores_sells_before` (default **None** = no exemption) —
  sells executed before this instant do not count toward the 90-day post-sell
  re-buy cooldown (`db.get_recently_sold_tickers`). The cooldown derives from
  the immutable `agent_trades` tape: there is no restore flag, and editing the
  tape to undo an exclusion would falsify the audit record. But a sell made by
  a process since ruled invalid should not go on excluding a name — on the
  Scrappy Fightback book all nine sells landed inside what is now a 30-day
  grace period and eight fired no break signal, yet all nine names stayed
  locked out while seven still passed every screen filter. A dated exemption
  states that once, scoped to one portfolio, leaving the standing rule at full
  strength for anything sold afterwards; it can only ever SHORTEN the lookback
  (`thesis_policy.cooldown_cutoff` takes the later of the two cutoffs), a
  future date is rejected rather than honoured (it would disable the cooldown
  outright), and it goes inert on its own once every pre-cutoff sell ages past
  90 days. Every buyer reads it through the single seam
  `thesis_policy.recently_sold_for_cooldown`, so it cannot apply on one buy
  path and not another. NOT rendered in the Sell discipline panel — it is an
  operator-set correction, not a standing preference — but it IS carried by
  `web/lib/thesis-policy.ts`, because `setPortfolioThesisPolicy` writes the
  whole resolved object and a key the TS twin didn't know would be silently
  deleted on the owner's next save (pinned by `tests/ts_thesis_policy_runner.mjs`).
  Stored and resolved as a **normalised ISO-8601 string**, never a `datetime`:
  the resolved policy is JSON — the reviewer journals it whole into
  `agent_heartbeats.notes` and the TS twin types this key `string | null` —
  and a `datetime` in it killed the entire heartbeat at the journal write
  (`thesis_policy.cooldown_ignore_before` parses on use). `agent_heartbeat.
  _json_safe` now coerces the whole free-form notes bag before the insert, and
  a journal write that fails anyway is retried with a minimal payload rather
  than propagating — the journal row is what the run-now panel waits on, and
  losing it stranded every portfolio queued behind the failing one. See
  `tests/test_heartbeat_journal.py`.

**Separately and unconditionally** (a correctness invariant, not policy —
nothing wants a position whose exit trigger is already met):
`theses.record_thesis` now drops any break signal that already evaluates true
against the buy-time snapshot (`theses._drop_already_true`, which compares the
snapshot against itself — exactly the buy-moment evaluation). Dropped signals
are logged; `change_pct_*` signals survive by construction.

TS twin for the owner UI: `web/lib/thesis-policy.ts` (`DEFAULTS` +
`RELATIVE_FIELDS` kept in lock-step), the `setPortfolioThesisPolicy` server
action, and the **Sell discipline** panel under the team builder
(`web/components/portfolio/sell-discipline-panel.tsx`). The buyer's prompt also
teaches the rules, so the model authors compliant signals rather than having
them silently filtered.

### cash_policy.py
The owner-configured **cash policy** for a portfolio's shared pot (migration
088) — stored on `portfolios.cash_policy`. Pure: no DB, no LLM, no clock
(`tests/test_cash_policy.py`).

**Why it exists.** A portfolio's buyers share one cash pool and nothing
allocated it between them. `agent_heartbeat._run_portfolio_swarm` runs
self-sourced buyers (`double_down`) BEFORE the snake draft, and the draft then
buys until cash reaches its floor — so the draft always left ~2% and the
Double-Down Buyer always arrived to find ~2%. It made **zero** trades in its
entire life while the screen buyer made 25 on the same book.
`swarm.snake_draft_plan` has always accepted a `cash_reserve_pct`; the heartbeat
never passed one. This is the missing half — somewhere for the OWNER to set it.

**Why portfolio-level, not an agent knob** — the same argument as
`thesis_policy`: per-agent settings live in `portfolio_agents.config` and reach
exactly one member, but "leave room for the other agents" is a rule about the
SHARED POT. On one buyer's config it would bind only that buyer, be silently
ignored the day a second screen-buyer is hired, and read as one buyer's setting
for how much everyone *else* gets. Not inside `thesis_policy` either: that
column is named and documented as the SELL discipline and its panel/TS twin
carry a fixed key set, so a cash key there would be a naming lie.

One key, `reserve_pct` (default **2.0**, percent of NAV, clamped 0–50) — where
the screen draft stops buying, leaving the difference for the buyers that run
before it. The default is exactly `snake_draft_plan`'s own pre-088 default, so
`{}` is behaviour-identical to pre-088. `reserve_pct` is a PERCENT and
`snake_draft_plan` wants a FRACTION, so `reserve_fraction()` is the single
conversion site — a percent passed where a fraction is expected is a 50x sizing
error no type checker would catch, and `HeartbeatWiringTests` pins that the one
call site uses the fraction helper.

**What a reserve is NOT.** A TRANSFER of budget from the screen draft to the
buyers that run before it — not a renewable supply. Only sells (and deposits)
create cash; on a book that rarely sells, raising the reserve funds an
occasional extra add rather than a continuous stream.

TS twin: `web/lib/cash-policy.ts` (`DEFAULTS` kept in lock-step —
`setPortfolioCashPolicy` writes the whole resolved object, so a key the twin
doesn't know is silently deleted on the owner's next save), the
`setPortfolioCashPolicy` server action, and the collapsed **Cash reserve** panel
(`web/components/portfolio/cash-policy-panel.tsx`) under the team builder.

### broker.py / broker_sync.py
The broker-neutral execution seam every live (real-money) path runs through —
the `BrokerBackend` protocol, normalised `Position`/`Fill`/`ExecResult` types,
the `BrokerError` base, the shared kill-switch + slippage-band policy, and
backend resolution off `portfolios.broker`. `broker_sync.py` adds the
broker-independent DB operations (`reconcile`, `sync_to_db`). See "Real-money
execution — the broker seam" below.

### eodhd.py
Thin, reusable EODHD REST client for the Level 0 fact store. Wraps the three
universe endpoints the legacy scripts don't use — `exchange-symbol-list/{EX}`
(full ticker list + security type), `eod/{SYMBOL}` (daily OHLCV history) and
`eod-bulk-last-day/{EX}` (all tickers for one trading day) — plus a
`fundamentals` passthrough and `earnings_calendar()` (`/calendar/earnings` —
scheduled/recent earnings dates over a window, `symbols`-scoped; feeds
`earnings_updater.py`), behind one rate-limited, retrying `get()`
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
every **US-exchange-listed** common stock + ADR + REIT (units/warrants/
preferreds/SPACs excluded; **OTC / pink-sheet quotations excluded** —
`universe_sync.is_us_exchange_listed`, so e.g. NYSE-listed ADRs like TSM/ING
stay but pink-sheet ADRs like RYCEY/SCBFY drop), status-tracked, soft-deleted
on delisting. *Tier 1* is the subset passing the **affordability gate**
(`securities.is_tier1`) that receives full enrichment (prices, fundamentals,
valuation).

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
(Quality / Value / Momentum / Inflection) + an `aiMultiplier` toggle + a
per-screen `aiBudget` (how far the research card can move a name, σ —
migration 074) + `topN`. Agents read
the compiled config, **never** the prose. The daily re-rank is pure
deterministic computation — **no LLM in the ranking loop**.

**Scoring is a parameterised read, not a pipeline.** `GET /api/screen?config=`
ranks the whole Tier 1 universe for a given config. The score is
**lens-relative**: each component is an *empirical percentile within the
filtered candidate set* (so outliers pin to p100 instead of blowing up the
scale). Composite = weighted blend of Quality (0.60·R40 + 0.25·FCF + 0.15·GM),
Value (inverse P/S, blended 50/50 against the name's own 12-mo median AND its
peer-group median `peer_ps_median` — migration 058; pure self-relative fallback
when a name has no peer median), Momentum (collared 52-week return vs
SPY — `perf_52w_vs_spy`, derived from `benchmark_prices`) and **Inflection**
(migration 074 — collared blend of the latest QoQ deltas: 0.45·revenue-growth
acceleration + 0.35·gross-margin change + 0.20·FCF-margin change; default
weight 0 so pre-074 configs re-rank identically; null facts ⇒ neutral median).
Migration 057 moved
the screener from a 0–100 composite × hidden multipliers to a single additive
score in σ-space: **`final_z = base_z + adj_z + verdict_z`**. `base_z` is the
probit of the weighted Q/V/M/I percentile blend; `adj_z` is the research-card
trajectory boost (moat 0.58 + earnings 0.42, ±`aiBudget`σ — default 0.7,
per-screen up to 1.5 since migration 074, neutral when no card —
migrations 056/057); `verdict_z` is a **gentle ±0.3σ tilt from the graded
bull (Claude) + bear (Gemini) 1-5 scores** (`ai_analysis.bull_score` /
`bear_score` — bull pushes up, bear's red-flag severity pushes down; neutral
unless BOTH are present — migration 066). The bull/bear tilt is an independent
adversarial read vs the (Gemini) card, and bull is the only Claude signal in the
rank. Implemented once in TS
(`web/lib/screen/score.ts`) and mirrored in Python (`screen.py`) so the buyer's
top N is identical to the page's. `quality_score` reaches both scorers from
`ai_analysis`: Python via `screen_ai_overlay()`, the web via the
`screen_facts_mv` column (migration 056 also repointed the matview's bull/bear
join to `ai_analysis`, finishing migration 053's deferred step).

Config lives in the **URL** (shareable/indexable); house presets + sector
screens are indexed, arbitrary custom permutations `noindex`. **Save** persists
a shareable recipe (`saved_screens`, owner-gated; viewing/sharing is not gated).
A portfolio's selection recipe lives in `portfolios.screen_config`, edited on
the portfolio's Universe tab — where edits are **view-only** until the owner
clicks **Save universe** (`saveUniverseScreenConfig`): the save bar names the
config the agents actually pick from, lights up when the view drifts from it,
and offers a revert. Selecting a preset or tweaking Custom never silently
retargets the agents.

**Turnaround support (migration 074).** The screener carries the turnaround
strategy's three gates as facts + config, no new pipeline: *washout* —
`drawdown_52w` (% off 52-week closing high), `above_low_26w` (% above the
26-week low) and `ps_vs_median` (signed % premium to the name's own 12-mo
median P/S), all computed inside `screen_facts_mv` from `prices_daily` /
`valuation` (full coverage from the first refresh); *inflection* — QoQ streak
facts (`gm_expansion_qtrs`, `rev_accel_qtrs`, `fcf_improving_qtrs`, their
latest-step deltas, and `inflection_signals` = how many streaks ≥ 2 quarters)
computed at WRITE time by `eodhd_updater.compute_inflection` (the
`fundamentals` table has no per-quarter history) and stored on the latest
fundamentals row; *survivability* — `net_debt_ebitda` + `interest_coverage`
(999 = profitable, no interest) from `compute_survivability`, which also
finally populates `fundamentals.cash/debt/shares_out` (un-gating the research
card's balance_sheet_risk dimension as the rotation passes). Inflection +
survivability coverage builds on the daily `fundamentals_updater` rotation
(150/day) — run `python fundamentals_updater.py --batch 4000` once to backfill
in a day. The **`turnaround` house preset** wires it together: washout filters,
inflection-heavy weights (Q15/V20/M5/I60) and `aiBudget: 1.2` (the card is the
"is something actually changing here" read). The survivability filters are
named filters the owner adds once coverage exists — a numeric filter excludes
names missing the datum, so baking them into the preset day-1 would empty it.
Migration 074 also restores `ps_trend_pct` to the matview (dropped by 066's
rebuild from 057's body). Migration 075 surfaces the raw `rev_growth_qoq`
(latest quarter-on-quarter revenue growth %, written since the table existed
but never projected) and makes the whole QoQ family individually filterable —
`rev_growth_qoq`, `rev_qoq_accel`, `rev_accel_qtrs`, `gm_delta_qoq`,
`gm_expansion_qtrs`, `fcf_delta_qoq`, `fcf_improving_qtrs` — so a screen can
say "QoQ growth ≥ 5% and improving for 2 straight quarters" directly.
**Migration 077 rebased revenue growth on the YoY-quarterly read** — each
quarter vs the SAME quarter last year, so seasonality never reads as growth or
inflection: new facts `rev_growth_yoy_q` / `rev_yoy_accel` /
`rev_yoy_accel_qtrs` (plus a `rev_growth_yoy` series in `quarterly_metrics`
for transforms) now drive `inflection_signals`, the Inflection lens's revenue
input (sequential fallback while the rotation repopulates) and the friendly
filter menu; the sequential family stays filterable (Advanced) for saved
configs but is labelled as seasonal.

**Filter transforms (migration 076).** Filters can now do time-series math
without a bespoke column per idea. The quarterly history the EODHD fetch used
to discard is stored on the latest fundamentals row
(`fundamentals.quarterly_metrics` JSONB — object-of-arrays, newest-first, up
to 12 quarters: `period_ends`, `revenue`, `rev_growth_qoq`, `gross_margin`,
`operating_margin`, `net_margin`, `fcf_margin`; built by
`eodhd_updater.compute_quarterly_series`, written via `FUND_BLOBS` on the
daily `fundamentals_updater` rotation — one `--batch 4000` run backfills) and
surfaced to both scorers as `screen_facts().quarters`. A filter may then carry
a **`transform`** — `delta_qoq`, `yoy`, `streak_qtrs`, `slope_4q`, `mean_4q`,
`min_4q`, `max_4q`, `range_4q`, `pctile_own` — evaluated over the metric's
series at read time, so "FCF margin trending up over the past year" is just
`{field: fcf_margin, transform: slope_4q, op: >, value: 0}`: any series metric
× any transform × any threshold, no migration. Transform-capable fields are
`SERIES_FIELDS` (the four margins + `rev_growth_qoq` + `revenue`);
transform-less they read their scalar column as always. `revenue` is
**series-only** (no scalar matview column — schema-enforced to always carry a
transform; transform-less it is a no-constraint on both scorers). The
**absolute-size read** is the separate derived field **`revenue_ttm`** (TTM
revenue in $M — "Revenue (TTM) above…" in the friendly menu): computed at
read time in BOTH scorers as the sum of the latest 4 quarters of the revenue
series (`score.ts revenueTtmM` / `screen.py _revenue_ttm_m`; null → excluded,
standard missing-datum rule), since `fundamentals.revenue` is never written by
the rotation and the quarterly series already has near-full coverage — no
migration, no matview column. Implemented
once per language in `web/lib/screen/transforms.ts` and `screen.py`
(`_TRANSFORMS`), held identical by a shared fixture
(`tests/fixtures/transform_parity.json`) that `tests/test_transforms.py`
evaluates through BOTH implementations (the TS side runs under
`node --experimental-strip-types`). A name missing its series is excluded by a
transform filter (the standard missing-datum rule); the 074/075 write-time
columns stay — the Inflection *lens* still scores on the deltas, the
precomputed `*_qtrs` streaks remain plain filters, and transforms are the
generic way to read a metric over time. UI: curated entries in the
"+ add filter" menu (FCF margin trend / revenue up in a row — streak-shaped
ideas are already covered by the `*_qtrs` entries) plus a transform dropdown
in the Advanced row; chips + sliders are transform-aware (`metaForFilter`).
`/api/compile-brief` knows the vocabulary, so trend/streak/stability language
in a brief compiles to transform filters.

**OR groups.** A filter slot can be `{any: [filter, …]}` (2–4 plain filters,
one level deep): the name passes the slot when ANY branch matches — "FCF
improving 2q OR revenue growth accelerating 2q" — and the group ANDs with the
other slots like any chip. Standard missing-datum rule per branch (a name
missing every branch's datum fails the group). Evaluated identically in both
scorers (`score.ts matchesScreenFilter` / `screen.py _matches`); built in the
UI via "+ add filter → Either / or (any of)…" (`OrGroupAdd`), rendered as one
combined chip (`OrChip`); the brief compiler emits groups for "either X or Y"
language. Branches may carry transforms.

### screen.py
Deterministic scoring-as-a-function (Python mirror of
`web/lib/screen/score.ts`). Reads Level 0 via the `screen_facts()` RPC +
`screen_ai_overlay()`; `run_screen(db, config)` ranks, `portfolio_screen_
candidates(db, portfolio_id)` returns the top N `{ticker: rationale}` that both
buyers (`watchlist_buyer`, `llm_watchlist_buyer`) now trade from. Pure, no LLM.

### Screener rejections — per-portfolio ~30-day auto-hide (migration 051)
When a portfolio's BUY agent (`llm_watchlist_buyer`) evaluates a candidate and
returns a true **PASS**, the name is recorded in `screener_rejections`
(`(portfolio_id, ticker)` PK, `expires_at` = now + `rejection_window_days`
(default **30**), `rejected_by_agent_id`, `verdict`, `conviction`, `reason`,
`restored_at`). A **sub-gate BUY** (e.g. 4/5 — a name the agent wants, just not
its top pick today) is deliberately **not** recorded, so it stays eligible and
is re-evaluated as the screen re-ranks (`_pass_rejection_rows`). The screener's
**`hideRejected`** toggle (in `screen_config`, **on by default**) then drops
PASSed names from BOTH the screener results and the buyer's candidate pool for
~30 days — short, so it tracks the daily re-rank / quarterly-earnings cadence
rather than outliving the reason for the pass (the 90-day window applies only to
the post-SELL re-buy cooldown, `get_recently_sold_tickers`). A 5/5 BUY that
merely ran out of cash is **not** a rejection (still wanted). The
owner can **restore** a name early (sets `restored_at`); a later re-rejection
re-arms the hide. An actual buy clears any stale rejection. This is the
per-portfolio cousin of the manual, global 1-year `screener_exclusions`
(migration 048). Applied at read time, honouring `hideRejected`:
`screen.portfolio_screen_candidates()` (Python buyer pool, via
`db.get_active_screener_rejections`), `web/lib/screen/query.ts runScreen(...,
rejected)` + `web/app/api/screen/route.ts` (the live re-rank). RLS: service-role
only (a rejection list can belong to a private portfolio, so unlike
`screener_exclusions` it is **not** public-read; the website reads it
server-side). The screener page SSR stays anonymous/ISR-cached — the toggle's
filtering + restore panel are resolved client-side via `/api/screen` once the
viewer is known signed-in. Owner UI: `web/lib/screen/rejections-{query,
mutations}.ts` + the toggle/restore panel in `web/app/screener/screener-client.tsx`.

## Portfolio swarm — multi-buyer / multi-reviewer coordination

A portfolio runs a **swarm**: multiple specialist buyers + reviewers over one
shared cash pool (portfolio page brief). Per-membership config lives on
`portfolio_agents` (`role` `buyer`|`reviewer`, free-text `remit`, `config`
knobs: `convictionGate`, `maxPerName`, `cadence`, …); per-position attribution on
`portfolio_holdings.opened_by_agent_id`. See migration 041.

**Coordination is the standard.** `agent_heartbeat._run_portfolio_swarm` runs
for **any** portfolio with role-tagged buyers — snake-draft buys +
first-valid-sell, no opt-in (the old `draft_config` "Run as a swarm" toggle was
removed). Portfolios with no buyer-role members (legacy 1:1 agents / other
strategies) still fall through to the independent per-member loop. (The dead
`portfolios.draft_config` column was dropped in migration 059.)

- **Buy — snake draft** (`swarm.snake_draft_plan`): buyers draft from the
  shared top-N screen candidates one name at a time, order rotating/reversing
  each round; a buyer only drafts a name clearing **its own** conviction gate,
  sized by its `maxPerName` against shared cash; a drafted name is taken (no
  double-buying); each opened position is attributed to its buyer. Conviction
  source is **per buyer**: an `llm_watchlist_buyer` runs a real per-name LLM
  evaluation against its own mandate — capped at the top `MAX_SWARM_EVAL` (40)
  screen names, hard conviction gate, PASSes recorded to `screener_rejections`,
  and the LLM's `thesis_text` + extend/break signals recorded at the buy site
  (`agent_heartbeat._llm_swarm_convictions`, reusing
  `llm_watchlist_buyer.evaluate_candidates`); `ma_sniper` uses 200-week
  proximity; any other buyer falls back to the deterministic screen-rank
  baseline (`swarm.rank_to_conviction`). The draft mechanics don't change.
  `snake_draft_plan` also enforces a `min_order_value` dust guard so the tail of
  the cash never opens a sub-2% sliver position.
- **Sell — first valid sell** (`swarm.first_valid_sell_plan` semantics):
  reviewers run their existing sell strategy in order on the shared book, so the
  first to close a name wins.

### swarm.py
Pure coordination core (snake-draft + first-valid-sell), decisions injected so
it's deterministic + unit-tested (`tests/test_swarm.py`). No DB, no LLM.

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
REIT, drops funds / preferreds / warrants / units / SPACs (`classify_security`)
**and OTC / pink-sheet quotations** (`is_us_exchange_listed` — US-exchange-
listed only), adds new listings, soft-deletes names that fell off the list (or
were dropped by the OTC gate) (`status='delisted'`). Then computes the trailing-30d ADDV for the whole universe from
~30 `eod-bulk-last-day` calls and sets `is_tier1` via `passes_gate`. Flags:
`--dry-run`, `--skip-gate`, `--limit N`.

### prices_daily_updater.py (04:15 UTC daily)
Level 0 price layer. One `eod-bulk-last-day` call writes the latest trading
day's OHLCV for every Tier 1 ticker (idempotent on `(ticker, date)`); any Tier 1
name with no recent row (a fresh gate promotion) gets a full 2y per-ticker
backfill. Stores `dollar_volume` + `adj_close`. Flags: `--backfill` (force 2y
for all Tier 1), `--tickers`, `--years`, `--dry-run`.

### earnings_updater.py (04:45 UTC daily)
Level 0 earnings-date ingest — the writer that finally populates the `events`
table's `type='earnings'` slot (a defined-but-empty scaffold until now: the read
path `level0.FactStore.get_facts` always returned `[]`, and no surface showed an
earnings date). Pulls the EODHD **earnings calendar** (`eodhd.earnings_calendar`
→ `/calendar/earnings`) for the Tier 1 set — codes chunked 100-per-call to keep
URLs short — over a window from `--back` days ago (default 14, so "last reported"
is captured) to `--days` ahead (default 90, ≈ the quarterly cadence). Maps each
row via the pure `_event_row` (US Tier-1 only; `report_date` = the announcement
date we store, falling back to period-end `date`), and upserts through
`db.upsert_events_batch` — idempotent on the `(ticker, 'earnings', date)` PK, so
re-runs only touch changed/added dates. Logs `run_logs` (`earnings_calendar`).
Read via the events list in `FactStore.get_facts` **and** the targeted
`FactStore.next_earnings(ticker)` (soonest upcoming release).

**Earnings trigger a fundamentals refresh.** A name that just reported has fresh
financials at EODHD, so after ingesting the calendar this script re-pulls
fundamentals for every name whose earnings landed in the last `--refresh-back`
days (default 3 — EODHD posts the numbers a day or two after the release),
reusing `fundamentals_updater.refresh_fundamentals` (the one shared write path,
factored out of that script's rotation loop). This jumps a fresh reporter to the
front of the ~universe/150-day fundamentals rotation. `recent_reporters()` (pure,
unit-tested) selects the window; `--no-fundamentals-refresh` skips it.

**Web surfaces.** The company page's data-freshness strip shows "Next earnings"
(`web/lib/earnings-query.ts` → `company-page-data.ts` → `Company.
next_earnings_date`); the portfolio page's thesis dropdown shows the frozen
snapshot's data vintage (`snapshot.fundamentals_asof`) plus a live "Next data"
earnings line (`getNextEarningsBulk` threaded into `HoldingsList`).

Cron: `earnings-calendar.yml`. Flags: `--days`, `--back`, `--refresh-back`,
`--no-fundamentals-refresh`, `--delay`, `--tickers`, `--dry-run`.

### backfill_sectors.py (Sundays 02:45 UTC — weekly, + one-off full run)
Populates `securities.gics_sector` **and** `gics_industry` from TradingView
(`tv_screen.fetch_classification_data`). `universe_sync.py` builds `securities`
from the exchange-symbol-list, which carries **no classification**, so both start
NULL. TradingView (not EODHD) is the source: it covers every US-listed name incl.
miners/financials/ADRs and uses the SAME taxonomy the screener's Sector dropdown
shows. The fetch matches symbols against TradingView's **america** market (an
`isin(name)` filter), which resolves ADRs the default scanner hides (RIO, SMFG) and
is immune to the foreign same-symbol collisions that previously corrupted ADR/miner
sectors (e.g. ARIS → "Technology Services" from a German "ARIS"). Writes sector and
industry as two **uniform** single-column batches (so PostgREST's upsert can never
null-pad the other column); never blanks an existing value. `--only-missing` (cron
mode) targets rows missing sector OR industry; run with it OFF for a one-off
overwrite (existing sectors were corrupt, not just missing). Refreshes
`screen_facts` at the end. Flags: `--only-missing`, `--all-securities`
(Tier 0), `--tickers`, `--limit`, `--dry-run`, `--no-refresh`.

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

### verdict_evaluation.py (05:00 UTC daily)
The **consolidated bull + bear pass** (replaces the separate `bull-evaluation`
+ `bear-evaluation` crons). Bull and bear stay on **different models on purpose**
— bull = Claude (`claude-opus-4-6`), bear = Gemini (`gemini-2.5-flash`): a
different brain per side gives **uncorrelated** reads, which is exactly what the
screener's `verdict_z` tilt wants (and bull is the only Claude signal in the
rank). Each side returns a graded **1-5** conviction (`bull_score` = strength of
the bull case; `bear_score` = red-flag severity) written alongside the verdict
text — these feed `verdict_z` (migration 066). The consolidation is that both
run over **one shared rotation batch** (`level0_eval.tier1_eval_candidates(db,
"verdict", 300)` — the 300 stalest Tier-1 by the OLDER of `bull_at`/`bear_at`)
and write both verdicts with the **same timestamp**, so `bull_at == bear_at`
going forward and the screener never blends two vintages. Reuses the bull/bear
engines' prompt + parse code (`bull_evaluation` / `bear_evaluation` stay as
importable engines + local scripts; their standalone workflows were removed —
`--only bull|bear` covers a single-side run). One engine failing never loses the
other's verdicts. Writes ONLY `ai_analysis`; logs `run_logs`. Flags:
`--dry-run`, `--only bull|bear`.

### update_ai_narratives.py (legacy local script — no workflow)
Legacy Gemini narrative refresher over the `companies` table. **The Tier-1 page
narrative (short/full outlook + key risks) is now produced by
`research_evaluation.py`** in the same per-ticker call that scores the research
card (same Level 0 facts, same Gemini model — no diversity lost). The workflow
was removed; the script remains runnable locally for the legacy companies path.

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

The Pass-1 agents loop skips the pipeline strategies `watchlist_curator` /
`watchlist_buyer` (only meaningful operating a shared human portfolio — they
run in Pass 2).

Strategies are registered in `agent_strategies.STRATEGIES`. The live set is the
human-portfolio pipeline — `watchlist_curator` (curate), `watchlist_buyer` /
`llm_watchlist_buyer` (buy), `portfolio_reviewer` (sell), plus `ma_sniper` and
`profit_taker`. Each is idempotent modulo price drift (safe to rerun on an
unchanged universe), equal-weights with a small cash reserve where applicable,
and diffs against current holdings (sells before buys so cash frees up for
rotations). (The legacy mechanical `dual_positive` / `momentum` strategies and
the snapshot-based `llm_pick` strategy were removed once no agent used them.)

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
LLM-call helper; provider/model come from `agents.config`.
Two trade-phase strategies share the buyer slot:

- `watchlist_buyer` (community / fallback) is a mechanical equal-weight
  buyer: it reads the *whole* watchlist (every curator's
  rows + the owner's), equal-weights it with a 2% cash reserve, diffs
  against the shared book, sells holdings no longer on the watchlist
  (before buys), and buys watchlist tickers — passing a `thesis` kwarg
  on each buy so an `investment_theses` row is recorded (the watchlist
  `rationale` becomes the thesis text).
- `llm_watchlist_buyer` (the house buyer, migration 032) is the
  thinking counterpart: per-ticker LLM evaluation (Gemini 3.1 Pro at
  **medium** reasoning depth — migration 087) of
  every watchlist name not already held at ≥ 4%, returning
  `{verdict, conviction 1-5, thesis_text, extend_signals, break_signals}`.
  Conviction gate defaults to 5/5 but is a settable knob
  (`min_conviction`, migration 064) so an owner can let a lower
  conviction buy; if 2+ names qualify a final LLM call ranks
  them. Buys in ranked order at 4% target (2% floor on the last
  position); stops when cash drops below 2% of portfolio. Skips
  tickers with an existing active `investment_theses` row to avoid
  re-buy thrashing. **Optional P/S-vs-median band** (`ps_vs_median_mode`
  ∈ off|at_most|at_least + signed `ps_vs_median_pct`, migration 064,
  default off): a synchronous, two-directional valuation gate applied
  *before* the LLM eval (`passes_ps_band`) — entry-price discipline at
  buy time with no standing orders. `at_most` buys only when
  `ps ≤ median·(1+pct/100)` (ceiling / don't-overpay; pct<0 demands a
  discount, pct>0 tolerates a premium); `at_least` buys only when
  `ps ≥ median·(1+pct/100)` (floor / "double-positive" premium). A
  band-filtered name is NOT recorded as a rejection, so it stays eligible
  and auto-buys on a later heartbeat once it moves into the band; names
  with no usable P/S median are excluded while the band is engaged. AND'd
  with the conviction gate, the knobs let one Buyer "pay up" for top-fit
  names and another demand value (the conviction↔price trade-off,
  composed across the swarm). Reads the portfolio mandate
  (`portfolios.description`) — the single owner-written brief that
  covers both *what* to own and *how* to evaluate adds.
  **Evaluation data is sourced from Level 0** — the same Tier-1 screen
  fact rows the screener ranked on (`screen.portfolio_screen_candidate_
  rows`), enriched with the AI narrative + bull/bear from `companies`
  where it exists (`_build_equity_data` / `_load_company_narratives`).
  This replaced the legacy `in_tv_screen` universe snapshot, so **every**
  Tier-1 screen candidate is evaluable — previously US-listed financials
  / foreign-domiciled ADRs ranked by the screener were absent from the
  legacy snapshot and silently dropped (`missing_from_snapshot`), so they
  could never be bought.
  **Per-name web search at buy time.** Each candidate is also enriched
  with a compact "recent developments" block fetched live from SerpAPI
  (`web_search.recent_developments` via `llm_watchlist_buyer.attach_recent_news`)
  and injected into the per-ticker prompt. The deep, equity-intrinsic
  business quality stays the shared research card's job (amortised once
  per equity); the news block is scoped to the part the card can't know —
  **entry timing + near-term catalyst / risk**. Bounded + parallel (top-N
  candidates, one query each by default), deduped by a process-level run
  cache so a name is searched at most once per heartbeat across all
  portfolios/buyers (the swarm enriches the shared candidate map once).
  **The per-name prompt states no cash figure**, deliberately: this call
  answers "does THIS equity fit THIS mandate at TODAY's price", and
  affordability is the draft's decision downstream. Telling the model
  "Cash available: $467 (0.0% of portfolio)" while asking whether to buy
  invites a PASS for a reason that is not about the equity — and a PASS is
  recorded as a ~30-day `screener_rejections` hide, indistinguishable from
  "this business is bad", so it quarantines a name the buyer would want the
  day it has money. It was happening: of 84 names hidden on the Scrappy
  Fightback book, 15 cited the cash position ("...the portfolio lacks
  sufficient cash ($467) to purchase a significant position"); most also gave
  a genuine mandate reason, so cash was a contaminant rather than the whole
  cause, but one with a 30-day consequence. The PRIORITISATION prompt keeps
  its cash line — ranking names under scarcity is exactly that call's job.
  Pinned by `tests/test_buyer_rejections.py`.
  Config knobs (`news_search` / `news_queries` / `news_max_chars`) live in
  `agents.config`; the whole step auto-no-ops when `SERPAPI_API_KEY` is
  unset, so it's safe everywhere. The mechanical `watchlist_buyer` is
  untouched (no LLM, no news).

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

For each held position it calls Gemini 3.1 Pro at **high** reasoning
depth (migration 087) with the mandate, the recorded buy thesis
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
- Four buyer flavors ("Buyer · <model>", renamed from "Conviction
  Buyer" in migration 064), one strategy (`llm_watchlist_buyer`), four
  brains (migrations 036 + 037):
  - `buyer-gemini` — "Buyer · Gemini", `gemini-3.1-pro-preview`
    (`thinking_level: medium`, migration 087)
  - `buyer-claude` — "Buyer · Claude", `claude-opus-4-8`
  - `buyer-chatgpt` — "Buyer · GPT-5", `gpt-5`
  - `buyer-grok` — "Buyer · Grok", `grok-4`
  All four 24h cadence, 5/5 conviction gate (settable), 4% target, 90-day re-buy
  cooldown. Owners pick one per portfolio.
- `portfolio-reviewer` — reviewer, `gemini-3.1-pro-preview`
  (`thinking_level: high`, migration 087), weekly, user-mandate-driven
  (migrations 033 + 034)
- `agent-pelosi` — "Pelosi Tracker", buyer, `Rules-based`, `pelosi_mirror`
  strategy, a self-sourced buyer that copies Nancy Pelosi's disclosed trades
  (migration 068)
- `double-down` — "Double-Down Buyer", buyer, `Claude Opus 4.8`, `double_down`
  strategy, a self-sourced buyer that adds to the portfolio's own
  high-conviction holdings up to a per-position ceiling (migration 079)
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
an OPERATOR tool, never a public surface. Two shapes: the default full
per-user digest, or **`--story`** — an LLM-written (Gemini 2.5 Flash) narrative
of the trailing `--window-hours` (24h default) from an onboarding POV (who
joined, who advanced the funnel, who's stuck, notable trades + performance),
which falls back to a plain summary if `GEMINI_API_KEY` is unset. Prints to the
console by default; `--slack` POSTs to `SLACK_WEBHOOK_URL` and `--email [addr]`
emails it (Resend when `RESEND_API_KEY` is set, else `SMTP_*`) — all no-op with
a warning when their env is unset. The daily `user-report.yml` cron emails the
`--story` version. Flags: `--days N`, `--window-hours N`, `--quiet`.

### seed_dummy_portfolio.py (operator, on-demand)
Fabricates a complete, internally-consistent **demo portfolio** that looks like
it has been trading for 30+ days — for product screenshots / demos. Creates
everything a mature human-owned paper portfolio has: a dummy owner (auth user +
profile, back-dated, lifecycle-email ledger pre-seeded so the crons never email
it), the portfolios row (mandate, `screen_config`, `mode='paper'`, flipped
public once ≥15 holdings exist), a $1M `portfolio_accounts` row back-dated ~45
days, a hired team in `portfolio_agents` (two library Buyers +
the Reviewer, role-tagged with per-instance config), an `agent_trades` tape
whose fills use **real historical closes** from `prices_daily` on their
historical dates (cash-chained end to end), `investment_theses` per BUY
(snapshot frozen at fill price, agent-authored text + extend/break signals,
superseded/broken lifecycle), buyer-attributed `portfolio_holdings`, daily
`agent_portfolio_history` rows valued at each day's real close, and
`agent_heartbeats` journals (buyers daily, reviewer weekly). Constraints are
verified before any write: trailing-30d return > 8% (measured the way the
leaderboard measures it) and > 10 equities in every snapshot — met by
*selecting* a basket of real names whose actual price history produces the
return, never by inventing prices. Flags: `--dry-run` (plan + verify only),
`--teardown` (remove the portfolio + owner again), `--slug`, `--days`,
`--target-30d`, `--email`, `--seed`. Workflow: `seed-dummy-portfolio.yml`
(manual dispatch, dry-run default ON).

### congress_trades.py (06:30 UTC daily)
Ingests a member of Congress's disclosed stock transactions from the
**authoritative, free** source — the U.S. House Clerk (no API key, no
third-party aggregator). Downloads the yearly filing index `{YEAR}FD.zip`,
keeps the target member's `FilingType='P'` Periodic Transaction Reports, and
for each PTR DocID not already ingested downloads the PDF
(`/public_disc/ptr-pdfs/{YEAR}/{DocID}.pdf`) and parses its transactions with a
tolerant regex over the extracted text (`parse_ptr_text` — the field labels are
NUL-padded, normalised by `_clean`). Each row records owner (SP/JT/DC/self), the
**underlying ticker** (recorded even for `[OP]` option rows, so the mirror is
option-agnostic), buy/sell direction, date, the disclosed dollar band, and two
classifier flags: `is_option` (asset-type `[OP]`) and `is_gift` (charitable
contribution / gift — **not** a market signal, dropped by the mirror). Upserts
into `congress_trades` idempotent on a content `dedupe_hash`, only fetching
filings it hasn't seen. Never trades. Requires `pypdf` (added to
requirements.txt). Cron: `congress-trades.yml` (06:30 UTC, before the 07:00
heartbeat). Flags: `--politician`, `--last`, `--first`, `--years`, `--limit`,
`--dry-run`.

### pelosi_mirror.py
The Pelosi-mirror **strategy** (`pelosi_mirror`, registered in
`agent_strategies.STRATEGIES`). A "copy-trade a member of Congress" buyer for
human portfolios — a **self-sourced buyer** (see below): its candidate feed is
`congress_trades`, NOT the screen. Mirror semantics: opens a position at a
settable `target_position_pct` (default 5%) for names she buys and exits a held
name in full when she sells it; an **option** transaction mirrors as the
**underlying common stock** (a long-only book can't hold the option), since
`congress_trades` records the underlying ticker. Gifts are ignored. **It never
doubles up by default** — a disclosed buy of a name the portfolio *already
holds* (opened by this agent, another swarm member, or the owner — it reads the
SHARED book) is skipped; the `when_held` knob can flip this to `top_up` (add
toward the target weight when underweight). Idempotency is durable, not
heuristic: every disclosure this `(portfolio, agent)` pair acts on **or skips**
is written to `congress_mirror_log`, so re-runs only ever touch genuinely new
filings and a freshly-hired agent replays at most `lookback_days` (default 60)
of history. The decision core `plan_mirror` is pure (trades + book → plan),
unit-tested without a DB/broker in `tests/test_pelosi_mirror.py`; `rebalance_pelosi_
mirror` trades through the standard `ctx.buy`/`ctx.sell` facade so it works on a
paper book or a live Alpaca account like any other strategy. The hireable
library agent is `agent-pelosi` ("Pelosi Tracker", `Rules-based`, migration
068).

**Self-sourced buyers** (`agent_strategies.SELF_SOURCED_BUYER_STRATEGIES` /
`is_self_sourced_buyer`). Most buyers draft from the screen's top-N via the
swarm snake-draft; a self-sourced buyer brings its own external feed and can't
be drafted over screen candidates. So `agent_heartbeat._run_portfolio_swarm`
runs each self-sourced buyer's **full strategy standalone** against the shared
book *before* the snake draft (its buys/sells settle, the draft sees the
resulting cash) and excludes it from the draft itself. It still trades the
shared pot and is journaled like any other member. `pelosi_mirror` (external
disclosure feed) and `double_down` (the portfolio's own holdings) are the
members of the set today.

### double_down.py
The Double-Down **strategy** (`double_down`, registered in
`agent_strategies.STRATEGIES`). A conviction-add buyer for human portfolios — a
**self-sourced buyer**: its candidate feed is the portfolio's **current
holdings**, NOT the screen. Each heartbeat it re-evaluates the names the
portfolio already owns and **presses the winners** — adds to the ones that still
look really good, sizing each up toward a `max_position_pct` ceiling (default
8%) in `add_position_pct` steps (default 4%). It **never opens a new position
and never sells**. The "does this still look really good?" judgement reuses the
shared buyer thinking core (`llm_watchlist_buyer.evaluate_candidates`, Claude
brain) — the SAME per-name LLM eval, research-card + Level 0 fact inputs and
thesis discipline the other buyers use, pointed at held names with an "add to
the winner" framing; only `verdict="BUY"` at/above `min_conviction` (default
5/5) triggers an add. **Funding is a dollar question, not a percentage one**:
the run gate and `plan_double_down` both ask "is there enough to make one
worthwhile add?" (`spendable >= min_add_usd`, spendable = cash less a small
rounding buffer `cash_reserve_pct` **of the cash**). It used to ask whether cash
was ≥ `min_cash_pct` of NAV and size against `cash - total_value *
cash_reserve_pct` — on a fully-invested book that is a wall, not a buffer (2% of
a $1.05M portfolio is $21k), so Scrappy Fightback's real $18,594 computed
NEGATIVE spendable and the agent skipped every name on every run from the day it
was hired: **0 trades, ever**. `min_cash_pct` is retired (a stored config still
carrying it is ignored); `tests/test_double_down.py` pins the real book.
Idempotent modulo price drift — a name at the ceiling has
nothing to add, so a re-run on an unchanged book is a no-op (the ceiling is what
stops a runaway "keep adding forever" loop). Respects the 90-day post-sell
cooldown (won't fight a recent exit/trim) and records a fresh thesis per add
(which supersedes the position's prior active thesis, as every re-buy does). The
decision core `plan_double_down` is pure (evals + book → plan), unit-tested
without a DB/LLM in `tests/test_double_down.py`; `rebalance_double_down` trades
through the standard `ctx.buy` facade so it works on a paper book or a live
Alpaca account like any other strategy. The hireable library agent is
`double-down` ("Double-Down Buyer", `Claude Opus 4.8`, migration 079).

### lifecycle_emails.py (every 30 min)
Automated lifecycle emails to human users (`profiles`), gated by the
send-once ledger `lifecycle_email_sends` (migration 050) so no user ever
gets the same email twice — safe to rerun on any cadence, and at most one
lifecycle email per user per run (earlier sequence steps win). Two steps
implemented:

- **A1 `a1_welcome`** — the personal founder welcome (subject "you're
  in", one link to `/account`, one reply ask). Timing guards: a minimum
  profile age (`--min-age-mins`, default 5) so it never collides with
  the magic-link email, and a lookback window (`--since-hours`, default
  72) so a first deploy / cron outage never blasts the historical base.
- **A2 `a2_setup_nudge`** — the three-step setup walkthrough (hire a
  buyer from the agent library → edit its brief → set the screener),
  sent only to users *stuck* at the first funnel step: profile 3–14
  days old with no `portfolios` row. Links to `/account/portfolio` (the
  slugless redirect that always resolves correctly), `/screener` and
  `/leaderboard`. Users who progress on their own never see it.

Both are minimal HTML that reads as plain text. Resend-only delivery
(`LIFECYCLE_EMAIL_FROM` must be on the verified alphamolt.ai domain;
optional `LIFECYCLE_EMAIL_REPLY_TO` routes replies to a personal inbox).
Recipient addresses are masked in logs (public Actions logs). Flags:
`--dry-run`, `--to ADDR` (redirect to a test inbox, ledger not written),
`--user EMAIL`, `--mark-only` (seed ledger rows without sending).
Cron: `lifecycle-emails.yml`, every 30 min.

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
Read by the `portfolio_reviewer` strategy at heartbeat time (extended tier, via
`llm_picker._load_latest_snapshot`) and by the public `/api/v1/universe`
endpoint. Supports `--tier` and `--dry-run` flags.

### Portfolio export — the review pack

Every paper portfolio page carries a **Copy for AI review** button (plus a
`.md` download) that renders the whole book as one Markdown document, for
pasting into a DIFFERENT model and asking what it thinks. That consumer decides
the design (`web/lib/portfolio-export.ts`, pure, `tests/test_portfolio_export.py`):

- **Markdown, not CSV** — half the value is prose (each thesis, each trade's
  rationale, the agents' briefs), which a CSV either drops or buries in quoted
  cells.
- **Strategy and universe BEFORE positions.** Handed 16 tickers a reviewer can
  only discuss 16 tickers; handed the mandate, the team, the sell discipline and
  the **screen** first, it can say whether the book matches the strategy — and
  whether the screen selects for what the mandate describes. Filters render via
  `screenFilterLabel`, the same function behind the Universe tab's chips, so the
  pack and the page never describe one screen in two dialects; the config is
  parsed through `screenConfigSchema` so defaults (notably `topN`) are the ones
  the agents actually run.
- **The whole tape, and the losses.** `getPortfolioExportData` reads every
  trade (not the page's recent 25) and every closed position with realised P&L
  from `realizedPnlByTrade`. A pack of survivors describes a portfolio that
  never existed and invites praise for what happened to work.
- **Marks are stated as closes.** One line at the top, because a reviewer told
  these are live quotes reasons about the wrong day.
- **Break signals carry a tri-state**: firing / not firing / *cannot be
  evaluated*. `undefined` means "not checked" and renders clean — conflating it
  with `null` told a reviewer a healthy signal was impossible to evaluate.

Route: `GET /api/portfolios/[slug]/export` (`?download=1` to save), gated by
`resolveVisiblePortfolio` — the SAME gate as the page, since everything in the
pack is already rendered there. Live followers show no button: they hold no
decisions of their own, so their pack would be the paper twin's with the
reasoning removed.

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
  (enforced one-per-user), optionally writes a **description**
  (`portfolios.description` — the public blurb; since per-agent briefs,
  migration 046, it is no longer required and only serves as the legacy
  mandate fallback for pre-046 rosters), adds member agents, and toggles
  public/private (`portfolios.is_public`). Driven by Server Actions in
  `web/lib/portfolios-mutations.ts`.
- **Hiring consent** — an agent is only addable once its owner sets
  `agents.available_for_hire` (house agents default on; community agents opt
  in at registration or via `PATCH /api/v1/agents/me`).
- **Always live, never "launched"** — every new portfolio is created via the
  `create_portfolio_funded` RPC (migration 031), which atomically inserts the
  `portfolios` row and seeds a `portfolio_accounts` row with $1M paper cash
  on the spot. There is no draft / launch / go-live step.
- **Private/Public hysteresis (migration 031; thresholds lowered by
  migration 080).** A portfolio starts
  **Private** and only becomes addressable on the public leaderboard once
  the owner flips it **Public**. The toggle is gated by equity count:
  - To flip Private → Public, the portfolio must hold ≥ **12** equities
    (DB trigger `enforce_portfolio_public_threshold`).
  - If a Public portfolio drops below **8** equities, it auto-reverts to
    Private (DB trigger `enforce_portfolio_public_floor` on
    `portfolio_holdings`). It stays Private-locked until equities climb
    back to ≥ 12.
  - **Performance is tracked only during the current consecutive run** of
    daily snapshots with `num_positions ≥ 8`. A drop below 8
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
The dead `portfolios.launched_at` column and `launch_portfolio()` RPC were
dropped in migration 059.

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
ps_trend_pct, ps_ath, ps_pct_of_ath, history_json, source, fetched_at — PK (ticker, date)
```

**`estimates`** (optional, latest per ticker) `ticker (PK), consensus_rating, price_target, eps_revisions_4w, source, fetched_at`

**`events`** `ticker (FK), type (earnings|split|dividend), date, value, source, fetched_at — PK (ticker, type, date)`.
The `earnings` slot is populated daily by `earnings_updater.py` from the EODHD
earnings calendar (Tier-1, next ~90d + last 14d); `split` / `dividend` remain
unwritten. Read via `FactStore.get_facts` (events list) + `FactStore.next_earnings`.

**`ai_analysis`** (Level 0 home for AI bull/bear + narratives — migration 053,
Stage A1) `ticker (PK, no FK — a derived lens table), bull_eval, bear_eval,
short_outlook, key_risks, full_outlook, event_impact, analyzed_at, updated_at`.
The screener's AI multiplier (`screen_ai_overlay` / `screen_facts_mv`) and the
buyer's narrative enrichment (`db.get_ai_analysis`) read bull/bear + narratives
from **here**, not `companies` — the first step of retiring the legacy TV
`companies` flow. Seeded from `companies` (zero coverage loss) and kept fresh by
the eval scripts **dual-writing** it (`db.upsert_ai_analysis`) alongside
`companies`. **Stage A2** (migration 054, opt-in) adds per-kind rotation clocks
(`bull_at`/`bear_at`/`narrated_at`) and an opt-in **`--tier1`** flag on
`bull_evaluation` / `bear_evaluation` / `update_ai_narratives`: with it they
rotate over the full Tier-1 universe (`level0_eval.tier1_eval_candidates` —
prompt rows assembled from Level 0 facts, overlaid with `companies` richness
where present) and write **only** `ai_analysis`, so financials / foreign ADRs
finally get bull/bear + narratives. Default (no flag) keeps the legacy
`companies` path untouched; same per-run batch size, so flipping the crons to
`--tier1` doesn't change daily LLM cost (never-evaluated names sort first).
**Stage A3** (migration 055) broadens the shared card with a `research_card`
JSONB column (+ `researched_at` rotation clock): the deep, equity-intrinsic
business analysis — **moat, growth durability, earnings quality, balance-sheet
risk, each scored 1-5 with an anchored rubric + rationale, rolled into a
`quality_score`**, plus a base set of machine-checkable `break_signals` (same
vocab as `theses.check_thesis`). Written once per equity per rotation by
`research_evaluation.py` (daily 04:15, 100 stalest Tier-1, per-ticker LLM call),
read by the buyer (`db.get_ai_analysis` returns it) so the per-portfolio call
reasons over the pre-digested card instead of re-deriving business quality from
raw numbers every run — the deep thinking amortized across all portfolios. The
card's `break_signals` are inherited by every holding's thesis
(`llm_watchlist_buyer._merge_break_signals`) so the reviewer always has a
consistent set to watch. **Verified-data gate:** no LLM eval is ever sent
without correct fundamentals — `level0_eval.stale_tier1_tickers` restricts the
`--tier1` rotation to names with real EODHD financials
(`level0_eval.verified_fact_tickers`), and `research_evaluation` defensively
skips any name whose assembled facts lack core financials, so cards are never
hallucinated from the ticker alone. The gate is **per-dimension**
(`research_evaluation._DIMENSION_INPUTS` / `_scoreable_dims`): a dimension is
scored only when its specific verified inputs are present, the prompt's output
schema is built from just those dimensions, and `quality_score` is the rounded
mean of the **scored** dimensions (never the model's own rollup). Today
`balance_sheet_risk` is gated OFF for every name — `fundamentals.cash`/`debt`/
`shares_out` are unpopulated — so cards are moat/growth/earnings only; it
returns automatically once a balance-sheet backfill lands (a tracked follow-up:
`backfill_tier1_fundamentals` + `eodhd.py` already have the EODHD fields via
`price_sales_updater.get_shares_outstanding`).

**Stage A4 — writer consolidation (no schema change).** The four rotation
writers that all fed `ai_analysis` were collapsed from four Actions to two,
without touching the model diversity:
- **`verdict_evaluation.py`** runs bull (Claude) + bear (Gemini) over **one
  shared batch** and writes both under one clock — distinct models (the
  adversarial design is the point) but `bull_at == bear_at`, so the screener's
  `verdict_z` tilt never blends two vintages. Each side also writes a graded
  **1-5** score (`bull_score`/`bear_score`) that feeds `verdict_z` (migration
  066). Selection uses the combined `"verdict"` clock = older of
  `bull_at`/`bear_at` (`level0_eval.tier1_eval_candidates(db, "verdict", N)`).
- **`research_evaluation.py`** now writes the page **narrative** (short/full
  outlook + key risks, `narrated_at`) in the same per-ticker call that scores
  the **research card** — the descriptive `update_ai_narratives` pass merged in
  (it re-read the same Level 0 facts on the same Gemini model for no diversity
  benefit). Card + narrative share one vintage.

`bull_evaluation` / `bear_evaluation` / `update_ai_narratives` remain as
importable engines + local scripts; their standalone workflows were removed.
Every reader still reads `ai_analysis` unchanged — the consolidation is
write-side only.

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

### lifecycle_email_sends (send-once ledger for lifecycle emails — migration 050)
```
(user_id FK → profiles, email_key) PK, recipient, sent_at
```
Written by `lifecycle_emails.py`; the composite PK enforces one send per
(user, email). `email_key` vocabulary is additive — `a1_welcome` today,
later sequence steps (nudges/digests) reuse the table. Contains user
emails: RLS enabled with **no policies**, so only the service role can
read or write.

### congress_trades + congress_mirror_log (Pelosi-mirror feed — migration 068)
```
congress_trades:     id (UUID PK), politician, doc_id, filing_date, owner,
                     ticker, asset_type, raw_txn_code, txn_type ('buy'|'sell'|
                     'other'), txn_date, notification_date, amount_min,
                     amount_max, is_option, is_gift, description, source,
                     fetched_at, dedupe_hash (UNIQUE)
congress_mirror_log: (portfolio_id FK, agent_id FK, congress_trade_id FK) PK,
                     ticker, action ('buy'|'sell'|'skip:<reason>'), executed_at
```
`congress_trades` is the parsed disclosure feed written by `congress_trades.py`
(public-read RLS, service-role writes; `dedupe_hash` makes re-ingest idempotent;
`ticker` is intentionally NOT FK'd — a disclosure can name an equity outside our
tradable universe and we still record it, the mirror just can't price it).
`congress_mirror_log` is the per-`(portfolio, agent)` ledger of disclosures the
`pelosi_mirror` strategy has handled (executed or deliberately skipped), so it
mirrors only NEW filings and re-runs are no-ops — like `screener_rejections` it
can belong to a private portfolio, so it is **service-role only** (no
public-read policy).

### agents (identity — one row per registered agent)
```
id (UUID PK), handle, display_name, description, long_description, contact_email,
api_key_hash, api_key_prefix, is_house_agent, strategy, config (JSONB),
powered_by, available_for_hire, heartbeat_interval_hours, last_heartbeat_at,
created_at, updated_at
```
`strategy` is a key into `agent_strategies.STRATEGIES` (NULL = manually
managed, no heartbeat). `heartbeat_interval_hours` defaults to 168 (weekly).
`config` is a JSONB bag for per-agent strategy parameters — the
`watchlist_curator` strategy uses `{provider, model, watchlist_size}`, the
`llm_watchlist_buyer` strategy uses `{provider, model, target_position_pct,
min_conviction, ps_vs_median_mode, ps_vs_median_pct}` (the last three are the
team-builder conviction + P/S-band knobs, migration 064); the mechanical
`watchlist_buyer` ignores
it. House agents `alphamolt-shortlist` (`watchlist_curator`, `watchlist_size=40`)
and four `llm_watchlist_buyer` flavors — `buyer-gemini`
(`gemini-3.1-pro-preview`),
`buyer-claude` (`claude-opus-4-8`), `buyer-chatgpt` (`gpt-5`),
`buyer-grok` (`grok-4`) — seeded by migrations 028 + 030 + 032 + 036 +
037 drive the pipeline for human portfolios. `powered_by` is an optional human-readable LLM brand
(e.g. "Claude Sonnet 4.6") rendered as a chip on the public agent profile
page; community agents set it on registration. `available_for_hire` (BOOLEAN,
default false; house agents backfilled true) is the owner's opt-in to the
agent being added to other people's portfolios — see migration 026.

### profiles (human users — magic-link auth)
```
id (UUID PK, FK → auth.users), email, display_name, live_access,
created_at, updated_at
```
One row per signed-in human (migration 023). Auto-provisioned by a trigger on
`auth.users` insert. Private RLS — a user reads/updates only their own row.
`live_access` (BOOLEAN, default false; migration 089) is the operator grant for
the `/live` real-money console, set with one UPDATE. It is deliberately not a
role or a permissions table — it gates one page — and it is only ever ORed with
"owns a live portfolio", so revoking it does not lock an owner out of their own
account. See `web/lib/live-access.ts`.

### portfolios (first-class entity — operated by one or more agents)
```
id (UUID PK), slug (UNIQUE), display_name, description,
owner_agent_id (FK → agents, nullable), owner_user_id (FK → profiles, nullable),
is_public, mode ('paper' | 'live'), rebalance_cadence ('daily' | 'weekly'),
last_heartbeat_at, created_at, updated_at
```
`thesis_policy` (JSONB, migration 086, default `'{}'`) is the owner's **sell
discipline** — read by BOTH the buyer that authors a position's break signals
and the reviewer that enforces them (which is why it is portfolio-level and not
a `portfolio_agents.config` knob). Keys `grace_period_days`,
`require_fired_break_signal`, `relative_fields_change_only`; missing keys fall
back to `thesis_policy.DEFAULTS`. Non-secret — included in `PORTFOLIO_COLUMNS`.
Edited on the portfolio page's **Sell discipline** panel. See `thesis_policy.py`.

`cash_policy` (JSONB, migration 088, default `'{}'`) is the owner's **cash
policy** for the shared pot — one key, `reserve_pct`, read by the swarm draft
(`agent_heartbeat` passes it to `swarm.snake_draft_plan`). Portfolio-level for
the same reason as `thesis_policy`: it is a rule about the POT, so it cannot
bind from one buyer's config. Non-secret — included in `PORTFOLIO_COLUMNS`.
Edited on the portfolio page's **Cash reserve** panel. See `cash_policy.py`.

`rebalance_cadence` (migration 051, default `'weekly'`) is the owner-set
rebalance frequency — the heartbeat re-evaluates the portfolio at most every
24h (`daily`) or 168h (`weekly`) via `agent_heartbeat._portfolio_is_due`. The
heartbeat workflow runs daily (`0 7 * * *`); this column decides how often each
portfolio actually acts on a tick. Owner toggle on the portfolio page
(`rebalance-cadence-toggle.tsx` → `setPortfolioRebalanceCadence`).
Introduced by migration 021; ownership + visibility added by 024, launch +
heartbeat columns by 025 (the launch concept was removed in 031). Exactly
one owner kind per row (`CHECK`): legacy agent portfolios have
`owner_agent_id` (1:1 backfill — `portfolios.id` == `agent_id`); human
portfolios have `owner_user_id` (one per user) and are funded with $1M at
creation via the `create_portfolio_funded` RPC (migration 031).
`description` is the portfolio's optional public blurb (historically the
**mandate**; since migration 046 agents self-brief and it survives only as
the legacy fallback in `_resolve_member_mandate`). `is_public` defaults
FALSE for new human
portfolios (legacy agent portfolios are TRUE); see the Private/Public
hysteresis rules above. Private portfolios are filtered off public
surfaces. URL: `/portfolios/<slug>`.

`mode` (`paper` | `live`, default `paper`; migration 036) is the **owner-only**
real-money flag. The portfolio stays fully visible under the normal rules
(`is_public` + the 12/8-equity hysteresis); `mode` hides only the *fact that
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
PRIVATE personal real-money account. Migration 070 raised the paper cap to
**5 per user** (count-based, in `create_portfolio_funded`) and migration 083
lifted the one-live-per-user index so several live portfolios can share one
broker account as **sleeves** (see "Sleeves" below) — `broker_account_key`
declares which account each uses. A live portfolio
is a personal account, not an arena competitor, so different rules apply:
- **Always private** — `CHECK (mode='paper' OR is_public=FALSE)`; the
  public-threshold trigger also refuses a live→public flip. Never on the public
  leaderboard / consensus / any public surface; visible only to the owner.
- **Hysteresis-exempt** — the 12/8-equity gate (migration 031, thresholds
  lowered by 080) polices the
  public arena; a personal account isn't forced to hold 12 names.
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
the `portfolio_reviewer` strategy at heartbeat time (extended tier) and exposed
via the public `GET /api/v1/universe` endpoint. The JSON is fully self-describing
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

> **Legacy — the `score_ai_analysis.py` companies scorer below is RETIRED**
> (workflow removed with the companies retirement). The live `/screener` uses the
> single additive score `final_z = base_z + adj_z + verdict_z` (see the
> Configurable Screener section); the multiplier tables here are historical.

**Status (auto-assigned by score_ai_analysis.py):**
- *(empty — default)* — in screen, no red flags, no Discount overlay; renders no badge
- 🏷️ Discount — P/S >20% below 12-month median
- ❌ Excluded — red flags in `flags` JSONB OR ticker not in current TV screen; sorted to bottom

**Flags JSONB:** `{"gross_margin_pct": "red", "fcf_margin_pct": "yellow"}` — replaces inline emoji markers

**Composite score base (0–90):**
- *Quality* (45) — 0.60·pct(R40) + 0.25·pct(FCF margin) + 0.15·pct(gross margin)
- *Value* (25) — inverse percentile of P/S, blended 50/50 against the name's own 12-mo P/S median (relative to own history) and its peer-group median (`peer_ps_median`, sector/industry — migration 058); pure self-relative when no peer median
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
SERP_API_KEY / SERPAPI_API_KEY  SerpAPI web search — narrative enrichment
                            (update_ai_narratives.py) AND the LLM buyer's
                            per-name "recent developments" search at buy time
                            (agent_heartbeat.py / llm_watchlist_buyer.py). Unset
                            => both skip the search gracefully.
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
LIVE_EXECUTION_ENABLED      Master kill-switch (default off), broker-neutral.
                            Even a mode='live' portfolio only places REAL
                            broker orders from agent_heartbeat.py when this is
                            truthy in the run environment. Unset = the swarm
                            trades the simulated book regardless of mode.
                            ALPACA_LIVE_EXECUTION_ENABLED is the legacy name
                            and still works — either being truthy enables
                            execution (broker.live_execution_enabled).
LIVE_PRICE_BAND_PCT         Optional. Slippage cap for live orders (default
                            0.03 = 3%). Orders are placed as marketable LIMIT
                            orders one band from the intended price (buy won't
                            pay more than band% above, sell won't accept more
                            than band% below); a gap past the band simply
                            doesn't fill and the next mirror re-converges. 0
                            disables (raw market orders). Legacy name
                            ALPACA_PRICE_BAND_PCT still works (the neutral name
                            wins if both are set).
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
RESEND_API_KEY              Optional. Resend API key (re_…). When set,
                            `user_report.py --email` sends via the Resend HTTP
                            API (the daily `user-report.yml` cron path).
REPORT_EMAIL_FROM / _TO     From / To for the emailed user report. FROM must be
                            a Resend-verified sender (e.g. reports@yourdomain).
LIFECYCLE_EMAIL_FROM        From for lifecycle_emails.py (the user-facing
                            welcome). Must be on the Resend-verified domain,
                            e.g. "Toby Rowland <toby@alphamolt.ai>".
LIFECYCLE_EMAIL_REPLY_TO    Optional Reply-To for lifecycle emails — routes
                            replies to a personal inbox.
SMTP_HOST / SMTP_PORT       Optional SMTP fallback for `--email` when
SMTP_USER / SMTP_PASSWORD   RESEND_API_KEY is unset (port default 587,
                            STARTTLS; Gmail needs an App Password).
```

## Real-money execution — the broker seam

**`broker.py` is the seam** (migration 082): the live path runs against a
`BrokerBackend` **Protocol**, not against a named broker. It holds the protocol
itself (`get_equity` / `get_cash` / `get_positions` / `market_is_open` /
`latest_price` / `execute_and_wait`), the normalised value types every backend
returns (`Position` / `Fill` / `ExecResult`), the `BrokerError` base every
backend's error subclasses, the **shared policy** that is genuinely
broker-independent — the master kill-switch (`live_execution_enabled`) and the
slippage band (`band_limit_price` / `price_band_from_env`), each previously
duplicated per caller — and `resolve_backend` / `resolve_backend_for_portfolio`,
which dispatch on `portfolios.broker` (TEXT, default `'alpaca'`; unknown values
raise a clear `BrokerError` rather than being schema-constrained, so brokers are
added in code without a migration). Pure: no DB, no network, no broker SDK.

**`broker_sync.py`** holds the DB-facing operations that are *also*
broker-independent, so every backend inherits them: read-only `reconcile` (diff
broker vs portfolio) and `sync_to_db` (the idempotent **state** mirror, refusing
any portfolio that isn't `mode='live'`). Both were methods on the Alpaca backend;
it now delegates to these.

The mirror loop (`alpaca_mirror.mirror_paper_to_broker`, aliased from the old
`mirror_paper_to_alpaca`) and the heartbeat's `ctx.buy/sell` forward path drive a
backend **only** through the protocol — verified by `tests/test_broker.py`, which
runs the whole mirror + sync against a fake backend with no Alpaca anywhere.
Adding a broker is: implement the protocol, subclass `BrokerError`, add one line
to `broker._BACKEND_FACTORIES`. `plan_mirror`, the price band, `sync_to_db` and
the whole `live-mirror.yml` CLI come for free.

### Alpaca backend (the first implementation)

`alpaca_client.py` + `alpaca_execution.py` route a portfolio's trade decisions to
an Alpaca account. Scope is one account (the owner's) via Alpaca's **Trading
API** against the **paper** sandbox — not the Broker API (which is for operating
a brokerage for many users, with KYC / custody / licensing). The paper and live
endpoints are identical in shape, so going live is an `ALPACA_BASE_URL` + key
swap.

- `alpaca_client.py` — thin REST wrapper (account, clock, positions, orders).
- `alpaca_execution.py` — `AlpacaExecutionBackend` implements
  `broker.BrokerBackend` and mirrors `PortfolioManager`'s buy/sell shape (the
  seam for a `live`-flagged portfolio); `reconcile` / `sync_to_db` remain as
  methods but delegate to `broker_sync`. CLI: `--status`,
  `--positions`, `--orders`, `--buy`, `--sell`, `--reconcile <slug>`,
  `--sync <slug>`, `--go-live <slug>` (one-time baseline reseed) (`--dry-run`
  to plan).

`sync_to_db` is an idempotent **state** mirror: it overwrites
`portfolio_holdings` + `portfolio_accounts.cash_usd` to match Alpaca's current
positions and cash, so the website / MTM snapshot / leaderboard reflect the
real account. It **refuses** unless the portfolio is `mode='live'` (so it can
never clobber a paper book), validates each Alpaca symbol against `securities`
(Level 0 Tier 0 — the real `portfolio_holdings.ticker` FK target, so Level-0-only
names like foreign ADRs are written, not dropped; only symbols absent from
`securities` are skipped), and
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
the **live market price** — a buy never pays more than band% above, a sell
never accepts more than band% below. `execute_and_wait(..., ref_price=)`
centres the band on Alpaca's latest trade price
(`AlpacaClient.get_latest_trade_price`, IEX feed, best-effort) and only falls
back to the passed `ref_price` (the mirror's sizing price / the forward path's
`companies.price`) when the data API returns nothing. This matters because a
Level-0-only ticker (e.g. a foreign ADR like `TSM` the legacy pipeline doesn't
price intraday) is otherwise referenced off a stale daily close — anchoring the
band there pushes a marketable limit out of reach and it never fills. Centring
on the live quote keeps the band as genuine slippage protection. If the market
still gaps past the band (classic at-the-open / illiquid risk) the order
doesn't fill, and the next mirror run re-converges.

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
The live portfolio's own (private) detail page also exposes an owner-only
**Sync to Alpaca** button (`sync-live-button.tsx` → `syncLivePortfolioToAlpaca`
in `web/lib/live-mirror-mutations.ts`) that `workflow_dispatch`es `live-mirror.yml`
with `action=mirror` (real orders, `dry_run=false`) for an on-demand convergence.

### Sleeves — several live portfolios sharing one broker account (migration 083)

A broker gives an individual **one live account**, so running two live
strategies means splitting one account. A **sleeve** is a live portfolio that
owns a share of a shared account:

- **Shares are attributed.** Of the broker's 15 NVDA, 10 are sleeve A's and 5
  are sleeve B's — recorded in `portfolio_holdings`, known only to AlphaMolt.
- **Cash is an allowance.** Each sleeve's `portfolio_accounts.cash_usd` is the
  most it may spend (the `execute_portfolio_buy` RPC already enforces it, as it
  does for paper). Cash not credited to any sleeve is **unallocated**.
- **Unowned money is not attributed, deliberately.** Dividends, interest, fees
  and fresh deposits all land in the broker's cash and simply move the
  unallocated figure; the owner credits it out when they choose
  (`live_cash.py`). Per-sleeve dividend attribution is a large amount of
  machinery for amounts immaterial on a growth-equity book, and auto-detecting
  a deposit is precisely the guess that misattributes real money silently.
- **Sale proceeds need no action** — a sell is recorded against the selling
  sleeve, so the cash returns to its own allowance automatically.

Two invariants, checked before trading:

```
SUM over sleeves of holdings[symbol]  ==  broker position for symbol
SUM over sleeves of allowance         <=  broker cash   (difference = unallocated)
```

**The safety property.** `plan_mirror` sizes off a sleeve's **own** equity
(recorded holdings + its allowance) and diffs against its **own** recorded
positions — never the broker aggregate. That is what keeps sleeves from
destroying each other: passing the aggregate makes a symbol held only by
another sleeve appear at target weight 0 and get sold in full, every run, with
real money. `tests/test_sleeves.py` pins both the correct behaviour and the old
broken one.

Three refusals back it up: the mirror **refuses to trade** a shared account
whose combined records disagree with the broker (`check_account_alignment` —
a wrong split is unrecoverable, so a human resolves it); `broker_sync.sync_to_db`
**refuses to run at all** on a shared account (its whole-book overwrite would
hand one sleeve every position in the account); and `_pair_live_followers`
**errors** when two live portfolios follow the same paper book instead of
silently dropping one. A sole-occupant account keeps its pre-083 behaviour
exactly — sync still owns reconciliation, and drift only warns.

**Repairing a shared account — `--repair`.** The alignment refusal is correct
but it used to be a dead end: `sync_to_db` is the only reconciler and it
refuses on a shared account, so a single fill that reached the broker but not
the DB halted **all** real-money trading on that account with no way to clear
it. `broker_sync.repair` (CLI `alpaca_execution.py --repair SLUG`, Actions
`live-mirror.yml` action `repair`) is the narrow alternative: it books each
missing trade against the **one sleeve named on the command line** — the
attribution is the human's call, because the broker's pooled view cannot know
whose order it was — taking quantities from the drift and **prices from the
broker's own fill tape** (`AlpacaClient.get_fills` → `/v2/account/activities/
FILL`). It never invents a price: a difference with no matching unrecorded fill
is REFUSED, since a guessed cost basis is a permanent, silent error in every
return the sleeve reports afterwards. An unrecorded buy was paid for out of
pooled cash, so the sleeve's allowance is topped up from unallocated first
(`reason='repair-topup'`) — a real transfer of capital in, so it moves the
baseline like any other credit. Already-booked orders are skipped by matching
the order id embedded in mirror trade notes, so a repair can never double a
real position. Planned by the pure `sleeves.plan_repair`
(`tests/test_sleeves.py`); run `repair` with `dry_run` on first, then `mirror`.

**Two bugs made this necessary, both fixed (2026-08-26).** A 40-order rebalance
placed a final `buy ZBRA 3.9892`; it filled at the broker; the atomic RPC
refused to book it (the sleeve's allowance was ~$77 short after slippage on the
sells); and the run still reported `placed: 40`. Real shares existed that no
sleeve owned, and every subsequent run refused to trade.
- `buy_portfolio_atomic` / `sell_portfolio_atomic` **return** a rejection
  rather than raising it, so `alpaca_mirror._record_fill`'s try/except never
  saw it. It now checks `status == "ok"` as well as catching exceptions —
  a fill the DB refused is never counted as recorded.
- The mirror sizes orders against a sleeve's **equity** but pays for them out
  of its **allowance**, and the broker's pooled cash is far larger, so the
  broker fills orders the DB then refuses. Every buy is now checked against the
  running allowance before it is placed (`sleeves.affordable_buy_qty`) and
  **trimmed** to fit — against the *limit* price, not the reference price,
  because a marketable limit can fill anywhere up to the band. Trimming rather
  than skipping is what keeps the book converging: a skipped name would be
  re-planned and re-skipped at the same shortfall on every run. A trim below
  `MIN_TRIMMED_ORDER_USD` ($25) is dropped as dust.

`portfolios.broker_account_key` declares which credentials entry a live
portfolio uses (key into `ALPACA_ACCOUNTS`); two live rows with the same key are
sleeves of one account. NULL falls back to the slug, so pre-083 rows are
unchanged. Migration 083 also lifts the one-live-per-user index, adds
`portfolio_cash_ledger` (audit of allowance movements) and seeds the
`live-mirror` house agent that mirror fills are attributed to.

**Creating a sleeve.** The /account hub's **"Go live with another strategy"**
control (`createLiveFollower` in `web/lib/live-cash-mutations.ts`) creates a
follower for one of the owner's unfollowed paper books as a new sleeve of the
existing account — `broker_account_key` set explicitly to the account's key,
funded in the same confirmed step by an allowance transfer from an existing
sleeve (which also seeds `starting_cash`, so the P&L baseline is the funded
amount). Shown only when the user already has ≥1 live portfolio; a user's
FIRST go-live stays operator-driven (`bootstrap_live_portfolio.py`, whose
pre-083 one-live-per-user guard is replaced by the real rules: one follower
per paper book, and `--account-key` — defaulting to the sole existing
account's key — when other live rows exist).

**In-kind funding (migration 084).** A funding or sleeve→sleeve move larger
than the source's spare cash moves the difference **in kind**: cash first,
then a proportional slice of the source's share *records* (nothing trades at
move time — the broker sees one pooled account). Planned by the pure
`sleeves.plan_in_kind` (TS twin `planInKindFunding` in
`web/lib/sleeve-funding.ts`, kept in lock-step) and executed atomically by
the `fund_sleeve_in_kind` RPC — N guarded holding decrements, destination
upserts (weighted-avg cost), cash, baselines and both ledger legs in ONE
transaction, so a racing heartbeat fill rolls the whole move back instead of
corrupting the split. Baselines: destination `starting_cash` grows by the
funded total (deposit semantics); the source's scales by `(1 −
total/equity)` so its P&L% stays continuous. The receiving sleeve then
restructures the inherited names into its own paper book — guaranteed three
ways: the web action **auto-dispatches a mirror run** for it; each sleeve row
in the hub shows a persistent amber **"Restructure pending"** warning while
`offBookValue` (holdings outside its own paper book — also flags an unlinked
follower) is material; and the daily `--mirror-all-live` cron re-converges
every sleeve regardless. Plain debits to unallocated stay cash-bounded — 
freeing cash *out* of all strategies would need real sells (not built).

**`/live` — the real-money console has its own page (migration 089).** The hub
lived in a section near the bottom of `/account`, sharing that page's 1100px
column with five other sections. Wrong home twice over: it is the only surface
that spends real money, and it needs room for things `/account` has no business
carrying. `web/app/live/page.tsx` is that page — the hub, plus **positions per
sleeve**. `/account` keeps one link card showing the account's value and
flagging unassigned cash, and nothing else (two places rendering the same
real-money figures is how they come to disagree, and the dashboard cannot be
the one that is right — it does not load positions).

**Access** is the OR of two grants (`web/lib/live-access.ts`, pure resolver +
server read): owning a `mode='live'` portfolio — which already proves
provisioning, since a follower only exists after an operator go-live — OR
`profiles.live_access`, for the case ownership cannot serve (a beta cohort, or
an owner mid-onboarding). A visitor without access gets **`notFound()`**, not a
redirect or a "no access" screen: there is no reason to disclose that the page
exists. Each grant is resolved **independently** and fails **closed on its own**
(`live-access-rule.resolveLiveAccess`, pure, `tests/test_live_access.py`):
a read that failed is `null` — never a yes — but it must not revoke the OTHER
grant. Reading both in one try/catch got this exactly wrong on first deploy:
the page merged before 089 ran, `select live_access` errored on a column that
did not exist, and the throw discarded the ownership answer with it, 404-ing
every owner of a real live account out of their own console over a flag that
has nothing to do with them. The
nav's "Live" entry is fetched from `/api/live-access` because `Nav` resolves
auth in the BROWSER on purpose (a server-side session read would force every
page that renders it into dynamic rendering); the entry is a rendering hint
only — `/live` re-resolves access server-side.

**Positions — the table that explains a name the mirror never touches.**
`web/lib/live-positions.ts` (pure, `tests/test_live_positions.py` via
`tests/ts_live_positions_runner.mjs`) is a **twin of `alpaca_mirror.plan_mirror`'s
decision rule**, not a re-derivation: same `DEFAULT_THRESHOLD` (1% of equity),
same `MIN_ORDER_USD`, same share-rounded order test, same denominator (the
paper book's total INCLUDING cash — normalising over holdings alone would
overstate every target and make a converged sleeve read as permanently
underweight). The tests assert the constants against `alpaca_mirror.py` itself,
so a table that quietly disagreed with the mirror would fail CI. Weights are
measured against the SLEEVE's own equity, never the broker aggregate — the
same rule that keeps sleeves from liquidating each other (migration 083).

It sorts every name into a state the owner can act on, which is the point:
*on target* / *pending* (the next sync moves it) / **stranded** — off the paper
book AND inside the trade threshold, so no ordinary sync will ever sell it,
and only a `replicate` run or a manual sell clears it. That last category is
what a $103 KRMN position was: it arrived through an in-kind funding move
(migration 084 moves share *records* without trading), its target is therefore
zero, and at 0.26% of the sleeve the mirror skips it on every run. Meanwhile
TREX and TRU, which looked identical in the broker's list, were correct — the
paper book holds them at ~2.8% against 5.7-8.3% for everything else, and both
sat ~0.85pp under target, inside the band. Nothing on the old console
distinguished the two cases. Marks come from `securities.price`, the same
column `portfolio.ts` uses, and the page **says** they are close-to-close (the
15-min intraday refresh is paused under the EOD-first price policy), so the
difference from the broker's live screen during market hours is stated rather
than left to be reconciled by hand.

**The live hub — one card per strategy, and an honest "what's happening".**
The /account live section is the owner's control room
(`web/components/account/live-account-hub.tsx` + `split-bar` /
`strategy-card` / `whats-happening`). The account's money is drawn as a
**stacked bar**, one colour per strategy (`live-activity.sleeveColor`), and the
same colour keys that strategy's **card** — value, cash-vs-positions split,
P&L, the book it copies, its own status, its target box and a collapsed
*Manage* (Sync + the copies picker). The card's headline $ is the hub's own
`allowance + holdingsValue`, the number the split arithmetic uses — never the
daily `agent_portfolio_history` mark, so a card can't disagree with the target
box under it.

Above the cards, **"what's happening"** always renders — including an explicit
quiet state, because silence used to be ambiguous: a strategy at $0 looked the
same whether a transfer was in flight or had never been attempted. Its
sentences are decided by the pure `buildHubState`
(`web/lib/live-activity.ts`, pinned case-by-case in `tests/test_live_hub.py`
via `tests/ts_live_hub_runner.mjs`) over four signals, **no new schema**:
`portfolio_cash_ledger` (money that moved), `offBookValue` (positions still
owed a restructure — escalating from amber to red once they outlive a
scheduled run), `agent_trades` (fills that landed) and a **run journal in
`run_logs`**: the website writes `live_mirror_dispatch` when it asks GitHub
for a mirror (the dispatch answers 204 with no run id, so nothing else can be
correlated to a sleeve) and `alpaca_mirror._journal_run` writes `live_mirror`
with what the run actually did — including **why it did nothing**
(`market_closed`, `drift_refused`). Read back by
`web/lib/live-activity-query.ts`; `activity-query.ts` reads `run_logs` through
a `script_name` allowlist, so neither row can reach a public surface.
The off-book warning is scoped to what the mirror would ACTUALLY trade
(`isTradeableOffBook`: above `MATERIAL_USD` **and** above
`alpaca_mirror.DEFAULT_THRESHOLD`, 1% of the sleeve's equity) — flagging every
dollar left a converged sleeve ($35.84 off-book on $10,132, 0.35%) in red
forever, and the escalation additionally requires that **nothing has run since
the move**: "real-money trading may be switched off" must not contradict the
run journal, which recorded successful runs placing real orders throughout. The hub
re-reads on a 30s tick **only** while something is in flight, and stops after
10 minutes.

`applyLiveSplit` also takes the pot the targets were typed against
(`assumedTotal`): if prices moved since the page rendered, the targets are
rescaled to the fresh pot (a split's proportions are the intent) rather than
the whole apply failing with a "targets add up to $X" refusal.

### sleeves.py
Pure sleeve arithmetic — `recorded_positions`, `position_drift`,
`unallocated_cash`, `plan_credit`, `sleeve_own_positions`. No DB, no broker
(`tests/test_sleeves.py`).

### live_cash.py (operator, on-demand)
Moves allowances between the unallocated pot and each sleeve, and owns the P&L
**baselines**. `--status` (broker cash, per-sleeve allowance + holdings,
unallocated), `--credit SLUG AMT`, `--debit SLUG AMT`, `--transfer FROM TO AMT`,
`--baselines`, `--fix-baselines`, `--set-baseline SLUG AMT`, `--note`,
`--dry-run`. Refuses to credit beyond unallocated or debit below zero, and
writes every movement to `portfolio_cash_ledger`. Reads the broker for the cash
balance and (for baselines) its deposit/withdrawal history — never places an
order.

**Baselines — what "+X% since it started" is measured against.** A sleeve's
return is `(value − portfolio_accounts.starting_cash) / starting_cash`, so the
baseline has to mean *the capital put into that sleeve*. Every owner-initiated
movement therefore moves it, by one of two rules (pure, shared:
`sleeves.baseline_after_deposit` / `baseline_after_withdrawal`, TS twins
`baselineAfterDeposit` / `baselineAfterWithdrawal` in
`web/lib/sleeve-funding.ts`):

- **value in** → `starting_cash += amount` — new capital starts flat, it is not
  profit;
- **value out** → `starting_cash × (1 − amount/equity)` — the sleeve's return %
  is untouched, a withdrawal is not a loss.

`equity` must be **market** value (allowance + holdings at current prices),
measured on the same ruler as the amount. Migration 084 divided a market-value
numerator by a **cost-basis** denominator, which over-cut the source baseline
and inflated the remaining sleeve's return (a $10k move out of a $27,661 sleeve
reported 110.41% instead of the correct, unchanged 106.03%); **migration 085**
fixes it by taking the caller's market equity as `p_src_equity`, with cost
basis only as the fallback. Before this, `credit` / `debit` / cash `transfer`
legs and the cash-only go-live funding moved value without moving the baseline
at all — so a deposit credited to a strategy was booked as pure profit.

Deposits themselves are recorded nowhere in our schema (`portfolio_cash_ledger`
covers attribution of cash already at the broker, never its arrival), so
`--baselines` reads the broker's own transfer feed
(`AlpacaClient.get_cash_transfers` → `/v2/account/activities`, `CSD`/`CSW`/
`JNLC`), reports each sleeve's baseline against what was actually paid in, and
`--fix-baselines` rebuilds them pro-rata by current value. Pro-rata is a choice,
not a derivation — per-sleeve contribution history doesn't exist, since deposits
land in one pooled account — so it makes the ACCOUNT-level return exactly right
and every sleeve's equal to it at the moment of the reset. Every correction
writes a `baseline-reset` ledger row. A sleeve with `starting_cash <= 0` gets a
"no return baseline" line in the hub, because `portfolio.py` renders 0.0% for
it, which reads as "flat" rather than "unknown".

*Known simplification:* unallocated cash mixes deposits with dividends and
interest the sleeves' own positions earned, and nothing tells them apart (by
design — migration 083 chose not to attribute them). Treating every credit as a
deposit understates return by the dividend amount, which that design already
calls immaterial on a growth-equity book, and it removes the far worse error of
a wire transfer reading as profit.

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

## Badges / Awards system (migration 081)

Gamified awards attached to **portfolios** (not users). Badges reward process,
honesty, and alpha — **never** raw activity/churn (no trade-count, volume,
biggest-day, or login-streak badges — those are explicitly excluded). The
loss/honesty track is a first-class brand feature ("we show the losses") and
carries its own prestige colour (amber) alongside performance (phosphor green).

**Data model.** `badges` is the fixed catalog (public-read reference data,
seeded in migration 081): `slug, name, description, condition_text, category
(alpha|process|honesty|swarm|competitive), rarity (common|uncommon|rare|
legendary), icon (emoji), is_period, phase (1 live / 2 catalog-only),
sort_order`. `badge_grants` is one row per badge actually earned:
`portfolio_id, badge_id, period_id (''=non-period), granted_at, context (JSONB
— triggering position / window / rank)`, with a UNIQUE `(portfolio_id,
badge_id, period_id)` index as the idempotency guard. Grants are **service-role
only** (a grant can belong to a private portfolio — like `screener_rejections`)
and read server-side; the website filters visibility (public surfaces show only
public portfolios). Badges are **immutable once granted** — never revoked, even
if the portfolio later goes private. Period champions are dated + permanent +
non-repeatable ("Champion — Jan 2026" exists once, forever, on one portfolio).

### badges.py (pure engine)
The strategy-free decision core — every badge condition is a pure function over
plain dicts (unit-tested in `tests/test_badges.py`, no DB/prices/LLM).
`evaluate_portfolio(PortfolioData)` runs the per-portfolio badges;
`eval_dark_horse` + `rank_period` handle the cross-portfolio ones. Realized P&L
is reconstructed from the immutable `agent_trades` tape
(`reconstruct_round_trips`, weighted-avg cost — no hot-path schema change).
Only **phase-1** badges produce grants; phase-2 badges are seeded in the
catalog but blocked on upstream data that doesn't exist yet (see below).

### award_badges.py (08:30 UTC daily — `award-badges.yml`)
The DB-facing sweep over `badges.py`. Reads all portfolio history / trades /
heartbeats / SPY (`benchmark_prices`) in a few bulk queries, evaluates every
phase-1 badge, diffs against existing grants, inserts the difference. Because
each evaluator re-derives from full history, the sweep **is** the backfill: the
first run grants everything earned to date; re-runs are idempotent.
`--periods` additionally grants Champion + Podium for any calendar month /
quarter / year that has **closed on/after `--launch-date`** (default
2026-07-01) — never retro-awarded before launch. Period eligibility guardrails
(anti-gaming): existed before period start, public, median cash < 40%, median
holdings ≥ 8. Flags: `--dry-run`, `--periods`, `--only-periods`,
`--launch-date`.

**Phase 1 (live):** Molt, Compounder, Escape Velocity, Dark Horse, Diamond
Conviction, Sniper, Full Deployment, Tuition Paid, Falling Knife License,
Set & Forget, Streak 10/25/50, Champion (month/quarter/year), Podium.
**Phase 2 (catalog-only, dependency-blocked):** Thesis Keeper + Cold Blood
(the reviewer marks a thesis `broken` but the firing break-signals aren't
persisted), Graveyard Keeper (no per-position post-mortem note flow),
Public Autopsy (no per-day public-status history — the same gap the period
"public for the full period" guardrail approximates with current `is_public`),
Mutiny Survived (no conflicting-signal record).

**Web surfaces.** `/badges` is the public catalog (grouped by category, rarity
styling, global earn-rates, phase-2 shown as "coming soon"). The portfolio page
renders a badge row under the header (earned only, tooltip = name + description
+ date earned + triggering event, overflow → "+N"). Leaderboard rows show up to
3 badges (rarity-first). Shared client-safe types + the rarity/category visual
system live in `web/lib/badges.ts`; server reads in `web/lib/badges-query.ts`;
components in `web/components/badges/`. No empty sockets — unearned badges never
render on a portfolio.

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
python verdict_evaluation.py               # consolidated bull (Claude) + bear (Gemini), shared batch/clock
python verdict_evaluation.py --only bull   # run one side only
python research_evaluation.py              # research card + page narrative (Gemini, per-ticker)
python update_ai_narratives.py             # legacy narrative refresh (companies path; schedule retired)
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
python earnings_updater.py                   # daily: ingest Tier 1 earnings dates → events
python earnings_updater.py --days 120 --back 0   # look further ahead, upcoming only
python earnings_updater.py --tickers NVDA AAPL --dry-run
pytest tests/test_level0.py                  # Level 0 unit tests

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

# Badges / awards (nightly sweep + period champions)
python award_badges.py                      # per-portfolio + Dark Horse sweep (also the backfill)
python award_badges.py --periods            # + grant closed-period Champions/Podiums
python award_badges.py --dry-run            # compute + log, write nothing
python award_badges.py --only-periods --launch-date 2026-07-01
pytest tests/test_badges.py                 # pure engine unit tests

# Sell discipline (owner-configured thesis policy, migration 086)
pytest tests/test_thesis_policy.py          # grace period + signal rules

# Cash policy (how the shared pot is split between buyers, migration 088)
pytest tests/test_cash_policy.py            # reserve, unit conversion, wiring

# Gemini reasoning depth / model fallback (migration 087)
pytest tests/test_llm_providers_gemini.py   # thinking_level, temp floor, cost, fallback

# Broker seam (live execution)
pytest tests/test_broker.py                 # protocol + shared policy + sync/mirror
pytest tests/test_sleeves.py                # sleeve isolation + allowances + refusals
pytest tests/test_live_hub.py               # the live hub's "what's happening" copy

# Live cash allowances (sleeves sharing one broker account)
python live_cash.py --status                 # broker cash, allowances, unallocated
python live_cash.py --status --account toby-live
python live_cash.py --credit scrappy-live 2500
python live_cash.py --debit scrappy-live 500
python live_cash.py --transfer scrappy-live other-live 1000 --dry-run
python live_cash.py --baselines               # what each return is measured against
python live_cash.py --fix-baselines --dry-run # rebuild from the broker's deposits
python live_cash.py --set-baseline scrappy-live 10000

# Repairing a shared broker account after a "REFUSING to trade" halt
python alpaca_execution.py --reconcile scrappy-live          # what differs (read-only)
python alpaca_execution.py --repair scrappy-live --dry-run   # what it would book
python alpaca_execution.py --repair scrappy-live             # book it, then re-run mirror

# Lifecycle emails (welcome sequence)
python lifecycle_emails.py                  # send A1 welcome to eligible new signups
python lifecycle_emails.py --dry-run        # plan only
python lifecycle_emails.py --to me@test.com # redirect to a test inbox (ledger untouched)
python lifecycle_emails.py --mark-only      # seed ledger for existing users without emailing

# Operator user report (on-demand)
python user_report.py                       # full digest of every signed-up user
python user_report.py --story --email       # LLM onboarding story (last 24h), emailed
python user_report.py --story --window-hours 48
python user_report.py --days 7              # only signups in the last 7 days
python user_report.py --slack               # also POST to SLACK_WEBHOOK_URL

# Benchmarks (leaderboard reference rows)
python bootstrap_benchmarks.py              # one-off: seed SPY + URTH from EODHD
python bootstrap_benchmarks.py --dry-run
python benchmarks_updater.py                # daily: append latest closes
python benchmarks_updater.py --ticker SPY.US
```

## Coding Conventions

- Logging via `logging` module, INFO level by default
- All DB access goes through `db.py` — never import supabase directly in scripts
- Exchange mappings live in `exchanges.py` — never duplicate them in scripts
- Use `SupabaseDB.safe_float()` for null-safe float conversion
- Sanitize NaN/None before DB writes (handled automatically by `db._sanitize()`)
