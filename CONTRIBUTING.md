# Contributing

The most welcome contribution is **a new trading agent**. This guide is mostly
about that. Bug fixes and pipeline improvements are welcome too — open an issue
or PR.

## Got an idea but not code? Open an issue.

The [`💡 Agent idea`](.github/ISSUE_TEMPLATE/agent-idea.yml) template asks three
questions: what signal, what's the buy/sell rule, where's the data. That's all
we need to evaluate it — and often to build it. This is genuinely how agents in
the arena have started.

## Writing an agent

The full quickstart is in the [README](README.md#build-an-agent-in-50-lines).
The short version:

1. **Write the decision as a pure function.** Inputs (current book, your signal
   data) → a plan of trades. No DB, no broker, no network. See
   [`pelosi_mirror.py`](pelosi_mirror.py)'s `plan_mirror` for the reference.
2. **Write a thin `rebalance(ctx)` wrapper** that does the IO: read
   `ctx.get_book()`, compute the plan, call `ctx.buy(...)` / `ctx.sell(...)`,
   return a `RebalanceResult`.
3. **Register it** in `agent_strategies.STRATEGIES`.
4. **Unit-test the pure core** with plain dicts — like
   [`tests/test_pelosi_mirror.py`](tests/test_pelosi_mirror.py).

### Conventions (please follow these — they're what gets a PR merged)

- **Idempotent modulo price drift.** Two back-to-back runs on an unchanged
  universe = zero new trades. Diff against `ctx.get_book()`.
- **Pure core, separate IO.** The decision logic must be testable without
  Supabase, a broker, or API keys. This is the bar for review.
- **Tunables go in `ctx.params`**, with a defaults dict in your module (see
  `PELOSI_MIRROR_DEFAULTS`). Don't hardcode magic numbers.
- **Trade only through the facade** — `ctx.buy` / `ctx.sell` / `ctx.get_book`.
  Never call `PortfolioManager` or the DB directly from a strategy; the facade
  is what makes one strategy run on both paper and live books.
- **Record a thesis on each buy** (`ctx.buy(..., thesis={...})`) when your agent
  has a "why" — it feeds the audit trail and the sell-side reviewer.
- **Match the surrounding style.** `logging` at INFO, no new dependencies unless
  necessary, all DB access through `db.py`.

## Running tests

The strategy tests need **no credentials**:

```bash
pip install -r requirements.txt pytest
pytest                              # whole suite (tests/)
pytest tests/test_pelosi_mirror.py  # just one area
```

Run the test that covers your area before opening a PR, and add one for your new
strategy's pure core. Lint with [ruff](https://docs.astral.sh/ruff/) before
pushing — CI runs `ruff check .` (config in `pyproject.toml`):

```bash
pip install ruff
ruff check .
```

## Pull requests

- One strategy (or one fix) per PR; keep it focused.
- Include the unit test for your pure core.
- Describe the signal and the rule in the PR body — pretend the reviewer has
  never heard your idea.

## Code of conduct

Be decent. This is a small project; assume good faith and keep discussion about
the work.
