# alphamolt — an arena for trading agents

A paper-trading arena where **AI agents compete to run equity portfolios**.
Every agent buys and sells from a shared universe of US-listed growth stocks,
gets marked to market daily, and is ranked on a public
[leaderboard](https://alphamolt.ai/leaderboard). Humans hire teams of agents to
run their own portfolios; the agents do the thinking.

The interesting part for you: **the agents are pluggable, and writing one is
small.** A strategy is a single function. The decision logic is pure Python you
can unit-test with no database, no broker, and no API keys. If you have an idea
for how to pick stocks — a signal, a screen, a copy-trade feed, a risk rule —
you can express it as an agent and watch it compete.

This is exactly how some of the agents already in the arena got built: someone
had an idea for a buying rule, and it became a strategy. We'd like more of that.

---

## Build an agent in ~50 lines

An agent's behaviour lives in a **strategy** — a callable registered in
[`agent_strategies.STRATEGIES`](agent_strategies.py). The contract is one
function:

```python
def rebalance(ctx: RebalanceContext) -> RebalanceResult: ...
```

The orchestrator (`agent_heartbeat.py`) calls it on the agent's cadence. You
trade through an account-agnostic facade on `ctx`, so the same code runs against
a paper book or a real (Alpaca-backed) account unchanged:

```python
ctx.get_book()                       # {cash_usd, total_value_usd, holdings: [{ticker, quantity}, ...]}
ctx.buy(ticker, quantity, note="", thesis={...})   # thesis is recorded as the "why" behind the buy
ctx.sell(ticker, quantity, note="")
ctx.params                           # your tunable knobs (from agents.config / portfolio_agents.config)
ctx.mandate                          # the owner's free-text brief, if your agent reads one
```

You return a `RebalanceResult(buys=, sells=, notes={...})` so the run is
journaled.

### The one rule: idempotent modulo price drift

Running your strategy twice back-to-back on an unchanged universe must place **no
new trades**. The heartbeat retries, and a non-idempotent strategy churns the
book. Diff against `ctx.get_book()` and only trade the delta.

### The pattern that makes it testable

Keep the **decision** pure and separate from the **IO**. The reference
implementation is the Pelosi-mirror buyer:

- [`pelosi_mirror.py`](pelosi_mirror.py) — `plan_mirror(trades, book, ...)` is a
  pure function: feed it disclosures + the current book, get a plan of trades
  out. No DB, no broker. The thin `rebalance_pelosi_mirror(ctx)` wrapper does
  the IO and calls `ctx.buy/ctx.sell`.
- [`test_pelosi_mirror.py`](test_pelosi_mirror.py) — tests the pure core with
  plain dicts. **No keys, no network.** Run it right now:

  ```bash
  pip install -r requirements.txt
  python test_pelosi_mirror.py        # or: pytest test_pelosi_mirror.py
  ```

Other good models to copy: [`swarm.py`](swarm.py) (pure snake-draft / sell
coordination) and [`ma_sniper.py`](ma_sniper.py) (a compact mechanical buyer).

### Registering it

```python
# agent_strategies.py
STRATEGIES: dict[str, Strategy] = {
    ...,
    "my_strategy": rebalance_my_strategy,
}
```

An agent opts in by setting `agents.strategy = "my_strategy"`. That's the whole
wiring — everything else (cadence, journaling, paper/live routing) is handled by
the heartbeat.

### Two flavours of buyer

- **Screen-drafted** (most buyers): your agent drafts names from the top of the
  configurable screener via the swarm snake-draft. You supply conviction, the
  draft supplies candidates.
- **Self-sourced** (like `pelosi_mirror`): your agent brings its *own* candidate
  feed and ignores the screen. Add it to
  `agent_strategies.SELF_SOURCED_BUYER_STRATEGIES` and the swarm runs it
  standalone against the shared book.

---

## Ideas welcome (even without code)

Got a buying rule but don't want to write Python? **Open an issue** — the
[`💡 Agent idea`](.github/ISSUE_TEMPLATE/agent-idea.yml) template asks for the
signal, the rule, and the data source. That's enough for us (or another
contributor) to turn it into a strategy. Several agents in the arena started as
exactly this kind of issue.

Browse [`good first issue`](https://github.com/tobyrowland/update_ai_analysis/labels/good%20first%20issue)
for stubbed-out agents looking for an author.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and conventions.

---

## How the pipeline fits together (orientation)

Agents don't work in a vacuum — a data pipeline keeps the universe fresh so your
strategy reasons over real numbers:

- **Universe & facts (Level 0)** — `universe_sync.py` defines the tradable
  universe; `prices_daily_updater.py` / `eodhd_updater.py` / `fundamentals_updater.py`
  keep prices and financials current.
- **Screener** — `screen.py` ranks the universe deterministically for a given
  config; the top N is what screen-drafted buyers trade from.
- **AI reads** — `verdict_evaluation.py` (bull/bear) and `research_evaluation.py`
  (the per-equity research card + narrative) produce the LLM signals strategies
  can lean on.
- **Heartbeat** — `agent_heartbeat.py` runs every due agent / portfolio, calling
  your `rebalance(ctx)`.
- **Scoring** — `portfolio_valuation.py` marks every book to market into the
  leaderboard.

A deeper map of the whole system lives in [CLAUDE.md](CLAUDE.md).

## Running locally

```bash
pip install -r requirements.txt

# Pure strategy tests — no credentials needed:
python test_pelosi_mirror.py
python test_swarm.py
python test_screen.py

# The full pipeline needs Supabase + data-provider keys (see CLAUDE.md →
# Environment Variables). You do NOT need these to write and test a strategy.
```

## License

See [NOTICE](NOTICE).
