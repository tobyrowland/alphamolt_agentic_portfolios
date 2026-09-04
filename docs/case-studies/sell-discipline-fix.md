# How the instant-sell problem was fixed

Companion to [`scrappy-fightback-trading-record.md`](./scrappy-fightback-trading-record.md),
which documented the failure. This describes what was built in response, why each
piece sits where it does, and what was deliberately not done.

The short version: a buying agent authored the conditions under which a different
agent would later sell, nothing checked those conditions against reality, and the
two agents ran minutes apart over a shared book. Three positions were bought and
sold inside ninety seconds. The fix is four defences at four different points, one
of which is a correctness invariant and three of which the owner controls.

---

## 1. What actually went wrong

Three distinct mechanisms, which the case file records with evidence. They are worth
separating because they have different causes and needed different fixes.

### 1.1 Theses that were broken at birth

The screen filters `perf_52w_vs_spy < -20` — it selects names that have fallen at
least 20 points behind the market. The buyer, handed one of those names, wrote
`perf_52w_vs_spy < -20` as the **break signal** that would invalidate its own thesis.

Every candidate satisfies that by construction. The thesis was false the instant it
was recorded. FICO was sold six days later at 5/5 conviction, with the reviewer
noting that fundamentals "remain exceptionally strong".

**Cause:** nothing evaluated a break signal against the state of the world at the
moment of purchase. A signal was stored as text and only ever checked later.

### 1.2 Confirmation signals read as falsification signals

Five theses listed `perf_52w_vs_spy > 0` as an **extend** signal — the condition
that would *confirm* the thesis. On a stock the screen guarantees is at −20 or
worse, that needs a twenty-point swing in a trailing-twelve-month number.

The reviewer then treated *failure to satisfy an extend signal* as equivalent to a
break, twice selling while explicitly stating that no break signal had fired.

**Cause:** two kinds of signal that fail in opposite directions were stored in the
same shape and given to the reviewer as one undifferentiated list.

### 1.3 No holding period at all

| Ticker | Bought | Sold | Held |
|---|---|---|---|
| ALLE | 2026-08-03 10:42:04 | 2026-08-03 10:43:30 | **86 seconds** |
| EXLS | 2026-08-03 10:42:06 | 2026-08-03 10:43:31 | **85 seconds** |
| NVO  | 2026-08-19 07:35:04 | 2026-08-19 07:36:24 | **80 seconds** |

**Cause:** the swarm runs buyers before reviewers within a single heartbeat, over
one shared book. A position opened seconds earlier is already in the reviewer's
scope. Nothing excluded it, and nothing reconciled a buyer and reviewer disagreeing
about the same name on the same facts a minute apart.

Nine closed positions cost **−$8,830** realised. CRM, held six days, would have
returned **+22.5%** if left alone.

---

## 2. The four defences

### 2.1 A break signal may not already be true — a correctness invariant

`theses._drop_already_true`, applied unconditionally in `record_thesis`.

Every break signal is evaluated against the buy-time snapshot *as both the frozen
and the current state* — exactly the evaluation `check_thesis` would perform the
moment the position opened. Anything already true is dropped, and logged.

This is **not** a policy knob. Nothing wants a position whose exit trigger is
already met, so there is no configuration under which the old behaviour is correct.
`change_pct_*` signals survive by construction: at purchase the delta is zero.

This answers the case file's question 3 directly. It fixes §1.1 empirically —
against the real snapshot, not by pattern-matching field names.

### 2.2 Price-relative fields take change-since-buy operators, per kind

`thesis_policy.signal_permitted(signal, policy, *, kind=)`, applied at authoring
time in the buyer, **after** the research card's signals are merged in so inherited
signals are policed too.

A static threshold on a price-relative field (`perf_52w_vs_spy`,
`price_pct_of_52w_high`, `ps_now`, `composite_score`) says where the stock *is*,
which on a screen selecting beaten-down names is usually already true. The
change-since-buy form is structurally immune, because at purchase the delta is zero.

The rule is **kind-specific**, and `kind` is a required keyword argument — either
default would be silently wrong for the other kind:

| | static downside (`<`, `<=`) | static upside (`>`, `>=`) | `change_pct_*` |
|---|---|---|---|
| **break** | banned — the born-broken case | **allowed** — it is a take-profit | allowed |
| **extend** | banned | banned — the unreachable wish of §1.2 | allowed |

`ps_now > 15` on a break signal is a take-profit: on a screen selecting cheap names
it sits far above where the stock is, so it cannot be the born-broken failure, and
2.1 still rejects it against the real snapshot if it somehow is. The same threshold
on an *extend* signal is precisely the unreachable confirmation the reviewer reached
for when nothing had fired.

`price` is deliberately **excluded** from the relative-field set. `change_pct_*`
compares an absolute difference, so on a raw share price the same number is a 9.6%
stop on a $52 name and 0.28% on an $1,800 one. Banning the static form there would
outlaw the only sane price stop and permit one that silently misbehaves.

The buyer's prompt teaches all of this, so the model authors compliant signals
rather than having them silently filtered.

### 2.3 A grace period

`grace_period_days`, default **30**. The reviewer skips positions younger than this
entirely, journalling them as `skipped_in_grace_period`
(`portfolio_reviewer.py:456`).

This is the answer to §1.3, and it is deliberately blunt. The alternative considered
— "exclude positions opened in this heartbeat" — fixes the 86-second round trip and
nothing else; a position sold on day two is the same error with better optics. A
turnaround thesis cannot be confirmed or refuted in a week, so judging it sooner
harvests noise.

The owner's manual Sell button is the escape hatch for a genuine blow-up, which is
why the rule can be this blunt without being dangerous.

### 2.4 A sell requires a break signal to actually be firing

`require_fired_break_signal`, default **on**. The reviewer refuses a SELL unless a
recorded break signal is firing per `theses.check_thesis`
(`portfolio_reviewer.py:595`).

This closes §1.2: an unsatisfied extend signal, or a narrative "the re-rating hasn't
happened yet", is no longer sufficient.

Two details matter more than they look:

**It self-disables where there is nothing to check.** No thesis, no signals, or a
failed oracle → the sell proceeds. A position can never become unsellable because
its paperwork is missing.

**A blocked sell is journalled separately**, under
`verdicts.sell_blocked_by_policy`, not folded into the HOLD list. A suppressed sell
is a decision. Hiding it in with the holds would conceal exactly the behaviour the
policy exists to change, and would make the policy impossible to evaluate.

---

## 3. Why the policy lives on the portfolio

Per-agent settings live in `portfolio_agents.config` and reach exactly one member.
But the buyer **writes** the break signals and the reviewer **acts** on them, so a
rule on either alone cannot bind the other. Putting the grace period on the reviewer
would leave the buyer free to author born-broken signals; putting the signal rules
on the buyer would leave the reviewer free to sell on an unfired extend.

So it is one column, `portfolios.thesis_policy` (migration 086), read by both sides.

`resolve_policy` fills every missing key from `DEFAULTS`, so `{}` is a complete
policy and every pre-086 row behaves identically to a fully-specified one.

The decision core is pure — no DB, no LLM, no clock of its own; callers pass `now` —
and is unit-tested in `tests/test_thesis_policy.py` against the real production
decisions it prevents. `tests/test_buyer_signal_policy.py` separately pins the
*wiring*: that each call site passes the right `kind`, and that the prompt and
`RELATIVE_FIELDS` agree. No test of the pure function can catch a call site passing
the wrong kind.

---

## 4. What was deliberately not done

**The buyer was not stopped from authoring its own falsification tests.** That the
optimist writes the test a different agent later enforces is the interesting part of
the design. The fix constrains the *shape* of what it can write, not who writes it.

**The two mandates were not reconciled.** The case file's question 1 — whether "buy
what has fallen away" and "sell what is still lagging" are jointly satisfiable —
remains open. The policy makes the incoherence non-fatal by refusing sells that
aren't grounded in a fired break signal; it does not resolve it. That is the owner's
call, in the mandate text.

**Conviction was not made informative.** Question 7 stands: the gate and the ceiling
are both 5/5 and every buy scores maximum.

---

## 5. Cleaning up after the fact

The cooldown derives from the immutable `agent_trades` tape, and editing that tape
to undo an exclusion would falsify the audit record. But nine sells made by a process
since ruled invalid were still locking those names out for 90 days — eight of the
nine fired no break signal, and seven still passed every screen filter.

`rebuy_cooldown_ignores_sells_before` states a dated exemption once, scoped to one
portfolio. It can only ever **shorten** the lookback (`cooldown_cutoff` takes the
later of the two cutoffs), a future date is rejected rather than honoured, and it
goes inert on its own once every pre-cutoff sell ages past 90 days. Every buyer
reads it through the single seam `thesis_policy.recently_sold_for_cooldown`, so it
cannot apply on one buy path and not another.

It is **not** rendered in the Sell discipline panel — it is an operator correction,
not a standing preference — but it *is* carried by `web/lib/thesis-policy.ts`,
because `setPortfolioThesisPolicy` writes the whole resolved object and a key the TS
twin didn't know about would be silently deleted on the owner's next save.

---

## 6. What this does not fix

Being honest about the remaining hole, since it bears directly on §2.4.

`build_snapshot` cannot populate `perf_52w_vs_spy`, `price_pct_of_52w_high` or
`composite_score` from the Level 0 fact store, and `check_thesis` builds its
*current* state with the same function. So both sides are null and
`_evaluate_signal` returns False immediately — **every break signal on those three
fields is permanently dead**, static or change-op.

That is a live gap, not a design choice. At last count it was 10 signals across 10
active theses. It means the discipline in §2.4 is weaker in practice than the signal
lists suggest: a reviewer that requires a fired break signal, on a thesis whose
signals cannot fire, will simply never sell that position.

The portfolio export surfaces this to any reviewer as a measured count, so it should
not stay invisible.

---

## 7. Where the code is

| | |
|---|---|
| Policy core (pure) | `thesis_policy.py` |
| Buy-time invariant | `theses._drop_already_true`, called in `record_thesis` |
| Signal authoring | `llm_watchlist_buyer`, after the research-card merge |
| Grace period | `portfolio_reviewer.py:456` |
| Fired-break requirement | `portfolio_reviewer.py:595` |
| Schema | migration 086, `portfolios.thesis_policy` |
| Owner UI | `web/components/portfolio/sell-discipline-panel.tsx` |
| TS twin | `web/lib/thesis-policy.ts` (`DEFAULTS` + `RELATIVE_FIELDS` in lock-step) |
| Tests | `tests/test_thesis_policy.py`, `tests/test_buyer_signal_policy.py` |
