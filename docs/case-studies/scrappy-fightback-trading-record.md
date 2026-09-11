# Case file: "Scrappy Fightback!" — complete trading record and decision rationale

**Purpose of this document.** This is a full, adversarially-reviewable dump of one
AI-agent-run paper portfolio: every trade, the agent-authored thesis behind every
buy, the agent-authored rationale behind every sell, every candidate the buyer
rejected and why, and the realised outcome of each decision. It is written to be
handed to another LLM (or a human analyst) with the instruction: **find what is
wrong with this.**

Nothing here is hypothetical. Every number and every quotation is read directly
from the production database on 2026-08-24. Where the record is incomplete or
ambiguous, that is stated explicitly rather than smoothed over.

**What was done about it:** [`sell-discipline-fix.md`](./sell-discipline-fix.md)
describes the four defences built in response to the sell-side failures below, and
what was deliberately left alone.

---

## 1. Setup

| | |
|---|---|
| Portfolio | **Scrappy Fightback!** (`portfolio-2`) |
| Type | Paper, public, human-owned |
| Created | 2026-07-03 |
| Account inception (current record) | **2026-07-20** — see §2, this is a rebuild |
| Starting cash | $1,000,000 |
| Rebalance cadence | Weekly |
| Record window covered here | 2026-07-20 → 2026-08-24 (23 trading days) |
| Real-money sibling | **Scrappy Fightback! (Live)** — a $10,000 Alpaca sleeve mirroring this book (16 positions, +2.78%). The decisions below are executed with real money. |

### 1.1 The team (three agents, one shared cash pool)

| Agent | Role | Model | Instance config | Owner-written brief |
|---|---|---|---|---|
| `buyer-gemini` — "Buyer · Gemini" | buyer | Gemini 2.5 Pro | `min_conviction: 5`, `target_position_pct: 6.5`, P/S band off | *"Strong Turnaround possibility, companies that have fallen away, but are fighting back HARD with a real chance of succeeding."* |
| `portfolio-reviewer` — "Portfolio Review Agent" | reviewer | Gemini 2.5 Pro | `sell_conviction_threshold: 4` | *"Get rid of any stocks where the turnaround has stopped, or the buy theses are broken. Be tough."* |
| `double-down` — "Double-Down Buyer" | buyer | Claude Opus 4.8 | `min_conviction: 5`, `add_position_pct: 1.5`, `max_position_pct: 9` | (default brief — press winners) |

Note both the buyer and the reviewer are **the same model** (Gemini 2.5 Pro) reading
the same fact rows, differing only in mandate text.

### 1.2 The universe the buyer picks from (`portfolios.screen_config`)

```json
{
  "preset": "custom", "topN": 40, "sort": {"column": "score", "dir": "desc"},
  "filters": [
    {"field": "perf_52w_vs_spy",   "op": "<",  "value": -20},
    {"field": "above_low_26w",     "op": ">=", "value": 10},
    {"field": "sector",            "op": "!=", "value": "Health Services"},
    {"any": [
      {"field": "fcf_improving_qtrs",  "op": ">=", "value": 2},
      {"field": "rev_yoy_accel_qtrs",  "op": ">=", "value": 2}
    ]},
    {"field": "interest_coverage", "op": ">=", "value": 2},
    {"field": "drawdown_52w",      "op": "<=", "value": 60},
    {"field": "ps",                "op": "<=", "value": 15},
    {"field": "revenue_ttm",       "op": ">=", "value": 100}
  ],
  "weights": {"quality": 13, "value": 14, "momentum": 13, "inflection": 35},
  "aiBudget": 1, "aiMultiplier": true, "hideRejected": true
}
```

**Read that first filter carefully.** `perf_52w_vs_spy < -20` means *every single
candidate the buyer is ever shown has underperformed the S&P 500 by more than 20
percentage points over the trailing year.* This is by design — it is the "fallen
away" half of the mandate. It also turns out to be load-bearing for the single
largest failure mode in this record (§6.1).

---

## 2. Provenance warning — read before judging performance

The visible record is **a rebuild, not the portfolio's whole life.** Three facts:

1. On **2026-07-19** the reviewer ran against a completely different 16-name book:
   `CTAS, ESTC, NCNO, PTC, BSY, TEAM, CRWD, DUOL, AGYS, IOT, GTLB, ARLO, PLTR, ZBRA, BKNG, ZG`.
   It sold CTAS. None of those trades exist in the current trade tape.
2. Buyer heartbeats on **2026-07-16** (13 buys, then 3 more) and **2026-07-20**
   (three separate runs at 09:51, 10:12 and 10:30, each recording 16 buys) are
   journalled — but only **one** set of 16 buys survives in `agent_trades`, and the
   cash chain restarts cleanly from $1,000,000.
3. `portfolio_accounts.inception_date` is **2026-07-20**, 17 days after the
   portfolio row was created.

**Implication for any critic:** the reported since-inception return of +5.32% is
measured from a reset baseline. Whatever the earlier configuration earned or lost
is not in this record. Treat the headline number as **≤ 23 trading days of
evidence**, not as a track record. `agent_leaderboard` reports
`sharpe_n_returns = 25` and `sharpe = null` (below the 30-return threshold) — the
system itself declines to compute a risk-adjusted number, correctly.

---

## 3. The complete trade tape (33 trades)

All fills at the pipeline's reference price; no fees, slippage, or FX modelled in
the paper book.

### 3.1 Wave 1 — 2026-07-20, initial deployment (16 buys, one heartbeat)

Sixteen positions at 6.5% each, executed 10:33:30 → 10:33:47. Every one scored
**5/5 conviction**. Cash went from $1,000,000 to **$8**.

| # | Ticker | Company | Qty | Price | Gross | Buyer's one-line rationale (as journalled) |
|---|---|---|---|---|---|---|
| 1 | BL | BlackLine | 2,145 | 30.29 | 64,972 | beaten-down stock (-46% 52W) at a cheap multiple |
| 2 | GEN | Gen Digital | 2,430 | 26.74 | 64,978 | de-leveraging play, immense FCF should de-risk |
| 3 | ADMA | ADMA Biologics | 7,462 | 8.71 | 64,994 | high-quality profitable business that has fallen hard |
| 4 | ZBRA | Zebra Technologies | 243 | 267.40 | 64,978 | turnaround fit, recent positive guidance, cheap |
| 5 | JBI | Janus International | 12,037 | 5.40 | 65,000 | cash-generative cyclical leader at a deep discount |
| 6 | SE | Sea Ltd | 624 | 104.05 | 64,927 | quality leader in a secular growth market |
| 7 | FICO | Fair Isaac | 51 | 1,257.11 | 64,113 | monopoly whose stock de-rated despite acceleration |
| 8 | AGYS | Agilysys | 609 | 106.68 | 64,968 | fallen leader in hospitality tech, fundamental signs |
| 9 | ADBE | Adobe | 273 | 237.25 | 64,769 | world-class software near 52-week lows on AI fears |
| 10 | MELI | MercadoLibre | 35 | 1,813.91 | 63,487 | category-definer whose stock significantly de-rated |
| 11 | PODD | Insulet | 396 | 164.06 | 64,968 | moated leader in a secular growth market, sold off |
| 12 | CRM | Salesforce | 380 | 170.77 | 64,893 | fallen market leader, valuation de-rated |
| 13 | CDW | CDW Corp | 487 | 133.24 | 64,888 | classic cyclical turnaround, moat at a deep discount |
| 14 | DT | Dynatrace | 1,463 | 44.41 | 64,972 | best-in-class observability leader, underperformed |
| 15 | FNF | Fidelity National Financial | 1,252 | 51.90 | 64,979 | quality cyclical leader, poised for turnaround |
| 16 | TRU | TransUnion | 352 | 79.85 | 28,107 | quality oligopoly at a discount to peers *(half-size — ran out of cash)* |

### 3.2 Wave 2 — 2026-07-26, the reviewer's first cut (5 sells)

| Ticker | Qty | Price | Proceeds | Held | Realised |
|---|---|---|---|---|---|
| BL | 2,145 | 28.74 | 61,647 | 6 days | **−3,325 (−5.12%)** |
| FICO | 51 | 1,237.37 | 63,106 | 6 days | **−1,007 (−1.57%)** |
| ADMA | 7,462 | 8.27 | 61,711 | 6 days | **−3,283 (−5.05%)** |
| CRM | 380 | 163.66 | 62,191 | 6 days | **−2,702 (−4.16%)** |
| CDW | 487 | 133.82 | 65,170 | 6 days | **+282 (+0.44%)** |

Cash after: $313,833 (31.4% of book). The double-down agent could not deploy it
(§6.4). It sat idle for eight days.

### 3.3 Wave 3 — 2026-08-03, buy and sell in the same 90 seconds

| Time | Ticker | Side | Price | Agent |
|---|---|---|---|---|
| 10:41:59 | SPSC | buy | 73.39 | buyer-gemini |
| 10:42:01 | INTU | buy | 316.07 | buyer-gemini |
| 10:42:02 | BSY | buy | 35.44 | buyer-gemini |
| 10:42:04 | **ALLE** | **buy** | 157.40 | buyer-gemini |
| 10:42:06 | **EXLS** | **buy** | 33.93 | buyer-gemini |
| 10:43:30 | **ALLE** | **sell** | 157.40 | portfolio-reviewer |
| 10:43:31 | **EXLS** | **sell** | 33.93 | portfolio-reviewer |

**ALLE was held for 86 seconds. EXLS for 85 seconds.** Both were bought at 5/5
conviction and sold at 4/5 conviction by the same underlying model, at the same
price, in the same heartbeat run. Realised P&L: exactly $0 on both (the paper book
charges no costs — the live sleeve does).

### 3.4 Wave 4 — 2026-08-11

| Time | Ticker | Side | Price | Realised |
|---|---|---|---|---|
| 08:09:30 | BAM | buy | 52.84 | — |
| 08:09:33 | TREX | buy | 48.17 | *(half-size, $30,588 — ran out of cash)* |
| 08:10:57 | SPSC | sell | 74.75 | **+1,205 (+1.85%)**, held 8 days |

### 3.5 Wave 5 — 2026-08-19, the 80-second round trip

| Time | Ticker | Side | Price | Realised |
|---|---|---|---|---|
| 07:35:04 | NVO | buy | 45.71 | — |
| 07:36:24 | NVO | sell | 45.71 | **$0**, held **80 seconds** |

---

## 4. Every buy thesis, verbatim, with its machine-checkable signals

Each buy records agent-authored narrative plus `extend_signals` (what would confirm
the thesis) and `break_signals` (what would kill it). Break signals are a mix of
agent-authored and inherited from the shared research card.

*Legend: ▲ = extend signal, ▼ = break signal. Status as of 2026-08-24.*

---

**BL — BlackLine** · bought 30.29 · **SOLD after 6 days at −5.12%** · *price now 31.83 (+5.08% vs cost)*
> We are buying Blackline as a classic turnaround play. The stock has been heavily punished for slowing growth, creating an attractive entry point given its excellent free cash flow generation (21% margin). We believe the market is overly pessimistic and that the recent launch of new 'Agentic Financial' capabilities provides a tangible catalyst for growth to re-accelerate. The thesis is a bet on a modest growth inflection leading to a significant valuation re-rating from its current depressed levels.

▲ `rev_growth_qoq_pct > 1` · `ps_now > 3.5` · `fcf_margin_pct >= 20`
▼ `rev_growth_ttm_pct < 5` · `fcf_margin_pct < 18` · `price < 25` · `rev_growth_ttm_pct < 0` · `fcf_margin_pct < 15` · `gross_margin_pct < 70`

---

**GEN — Gen Digital** · bought 26.74 · **HELD, +8.2%**
> GEN represents a classic de-leveraging story. The company's collection of strong consumer cybersecurity brands generates immense and predictable free cash flow, which should allow it to aggressively pay down the substantial debt from its Avast acquisition. As the balance sheet de-risks and debt is serviced, I expect a significant re-rating of the equity multiple, unlocking value for shareholders.

▲ `fcf_margin_pct >= 30` · `operating_margin_pct >= 42` · `ps_now > 3.75`
▼ `operating_margin_pct < 38` · `fcf_margin_pct < 25` · `rev_growth_ttm_pct < 0`

---

**ADMA — ADMA Biologics** · bought 8.71 · **SOLD after 6 days at −5.05%** · *price now 9.84 (+12.97% vs cost)*
> ADMA represents a classic turnaround opportunity. We believe the market has overreacted to a single poor quarter, creating an attractive entry point for a high-quality, high-margin specialty pharma business. We expect revenue growth to re-accelerate and margins to remain strong, leading to a significant valuation re-rating as the market recognizes the durable earnings power, further supported by management's aggressive share repurchase program.

▲ `rev_growth_qoq_pct > 5` · `ps_now > 5` · `net_margin_pct >= 30` · `price_pct_of_52w_high > 50`
▼ `rev_growth_qoq_pct < 0` · `gross_margin_pct < 55` · `fcf_margin_pct < 15` · `price < 7.5` · `gross_margin_pct < 50` · `rev_growth_ttm_pct < 5` · `fcf_margin_pct < 10`

---

**ZBRA — Zebra Technologies** · bought 267.40 · **HELD, +37.8% (best position)**
> We expect ZBRA to execute on its guided recovery, driven by a rebound in enterprise hardware demand and a new focus on AI applications. This should deliver double-digit revenue growth and margin expansion. Trading at a significant P/S discount to peers (2.3x vs 5.6x), successful execution offers a clear path for a valuation re-rating.

▲ `rev_growth_ttm_pct > 10` · `operating_margin_pct > 15` · `ps_now > 3` · `fcf_margin_pct >= 14`
▼ `rev_growth_ttm_pct < 5` · `operating_margin_pct < 13` · `fcf_margin_pct < 10` · `operating_margin_pct < 12` · `rev_growth_ttm_pct < 0`

---

**JBI — Janus International** · bought 5.40 · **HELD, −5.4%**
> JBI is a market leader in self-storage solutions currently punished by a cyclical construction downturn. We believe its excellent balance sheet and strong free cash flow generation provide the resilience to weather this period. As the cycle turns and interest rates stabilize, we expect a significant re-rating of its depressed valuation multiple (currently 0.8x P/S vs 2.0x peers) and a return to positive revenue growth.

▲ `rev_growth_qoq_pct > 0` · `ps_now > 1.2` · `fcf_margin_pct >= 11`
▼ `rev_growth_ttm_pct < -10` · `fcf_margin_pct < 8` · `gross_margin_pct < 32` · `gross_margin_pct < 30`

---

**SE — Sea Ltd** · bought 104.05 · **HELD, +13.0%**
> Sea Ltd represents a classic turnaround where a high-quality business has been mispriced by the market. We expect continued execution in its e-commerce and fintech segments to drive strong revenue growth and margin expansion. As the market recognizes the company's durable growth and strong free cash flow generation, we anticipate a significant valuation re-rating from the current 2.5x P/S towards its historical median of 3.3x and beyond.

▲ `rev_growth_ttm_pct >= 35` · `fcf_margin_pct >= 17` · `ps_now > 3.3` · `rule_of_40 > 45`
▼ `rev_growth_ttm_pct < 20` · `gross_margin_pct change_pct_lt -4` · `fcf_margin_pct < 10` · `price_pct_of_52w_high < 0.5` · `gross_margin_pct < 40`

*(Note the malformed signal: `price_pct_of_52w_high < 0.5` — the field is expressed
in percent elsewhere, so this threshold is 0.5% rather than 50%. It can effectively
never fire.)*

---

**FICO — Fair Isaac** · bought 1,257.11 · **SOLD after 6 days at −1.57%** · *price now 1,172.67 (−6.72% vs cost — the one good sell)*
> FICO's stock has been unfairly punished due to macro fears and regulatory headlines, creating a disconnect with its exceptional business fundamentals. We expect the company's monopoly-like pricing power and strong execution, evidenced by recent 39% revenue growth, to drive a significant valuation re-rating back towards its historical median. The market will eventually recognize the durability of its high-margin, cash-generative model, closing the performance gap.

▲ `ps_now > 15` · `rev_growth_ttm_pct >= 20` · `operating_margin_pct >= 48` · `price_pct_of_52w_high > 85`
▼ `gross_margin_pct < 80` · `rev_growth_ttm_pct < 15` · `fcf_margin_pct < 35` · **`perf_52w_vs_spy < -20`** · `rev_growth_ttm_pct < 10` · `fcf_margin_pct < 30`

**⚠ The bolded break signal was mathematically guaranteed to be true at the moment
of purchase.** The screen filter that produced FICO as a candidate is
`perf_52w_vs_spy < -20`. The buyer wrote a sell trigger identical to the entry
criterion. It fired six days later and the reviewer sold at 5/5 conviction.

---

**AGYS — Agilysys** · bought 106.68 · **HELD, +6.7%**
> AGYS is a best-in-class software provider for the hospitality industry, a sector undergoing a multi-year technology upgrade cycle. After a period of stock underperformance, recent record earnings and strong forward-looking commentary suggest an inflection point has been reached. We expect continued double-digit revenue growth and margin expansion, leading to a valuation re-rating as the market re-appreciates its durable growth profile and high-quality earnings.

▲ `rev_growth_ttm_pct > 16` · `operating_margin_pct > 13` · `fcf_margin_pct > 22` · `price_pct_of_52w_high > 95`
▼ `rev_growth_ttm_pct < 12` · `gross_margin_pct change_pct_lt -3` · `fcf_margin_pct < 17` · `rev_growth_ttm_pct < 10` · `gross_margin_pct < 58` · `fcf_margin_pct < 15`

---

**ADBE — Adobe** · bought 237.25 · **HELD, +16.0%**
> The market is overly pessimistic about AI's threat to Adobe's entrenched creative ecosystem. We believe Adobe's strong moat, massive user base, and deep AI integration will allow it to successfully navigate this transition, leading to a re-rating of its valuation multiple closer to historical norms. We expect continued double-digit growth and elite margins to prove the durability of the business model.

▲ `ps_now > 4.5` · `rev_growth_ttm_pct >= 10` · `fcf_margin_pct >= 38`
▼ `rev_growth_ttm_pct < 8` · `gross_margin_pct < 85` · `rule_of_40 < 35` · `price < 190`

---

**MELI — MercadoLibre** · bought 1,813.91 · **HELD, +6.0%**
> MELI is a dominant e-commerce and fintech platform in a structurally growing Latin American market. We expect the stock to re-rate higher as the market looks past near-term macro concerns and refocuses on the company's exceptional growth (40%+), strong Rule of 40 score (48), and massive free cash flow generation. The current valuation below its historical median provides a compelling entry point for a long-term compounder.

▲ `rev_growth_ttm_pct >= 38` · `fcf_margin_pct >= 30` · `ps_now >= 3.5` · **`perf_52w_vs_spy > 0`**
▼ `rev_growth_ttm_pct < 25` · `fcf_margin_pct < 20` · `operating_margin_pct < 7` · `rule_of_40 < 40` · `fcf_margin_pct < 15` · `gross_margin_pct < 40`

*(Extend signal `perf_52w_vs_spy > 0` requires a >20pp swing in relative performance
to be satisfied — see §6.2.)*

---

**PODD — Insulet** · bought 164.06 · **HELD, −9.7% (worst position)**
> Insulet is a best-in-class medical device company with a strong moat and a long growth runway in the diabetes market. We believe the recent ~40% stock price decline is a significant overreaction, creating a disconnect between the company's excellent fundamentals (30%+ growth, 70%+ gross margins) and its valuation. We expect the stock to re-rate higher as the market refocuses on its durable growth and profitability, closing the gap with its historical multiples.

▲ `rev_growth_ttm_pct >= 25` · `gross_margin_pct >= 70` · `ps_now > 5` · `perf_52w_vs_spy > -30`
▼ `rev_growth_ttm_pct < 20` · `gross_margin_pct < 68` · `fcf_margin_pct < 12` · `operating_margin_pct < 15` · `gross_margin_pct < 65` · `rev_growth_ttm_pct < 15` · `fcf_margin_pct < 10`

---

**CRM — Salesforce** · bought 170.77 · **SOLD after 6 days at −4.16%** · *price now 209.17 (**+22.49% vs cost** — the most expensive sell in the record)*
> The market has punished CRM for its decelerating top-line growth, creating a compelling entry point. The thesis is that as Salesforce executes on its pivot to profitable growth, its exceptional free cash flow generation and expanding margins will drive a valuation re-rating. We expect the stock to be re-appraised as a durable compounder, with AI-driven product cycles providing a potential upside catalyst to growth.

▲ `operating_margin_pct > 23` · `fcf_margin_pct > 35` · `ps_now > 4` · `rev_growth_ttm_pct > 11`
▼ `rev_growth_ttm_pct < 8` · `operating_margin_pct < 20` · `fcf_margin_pct < 30` · `operating_margin_pct < 18` · `fcf_margin_pct < 25` · `rev_growth_ttm_pct < 5`

---

**CDW — CDW Corp** · bought 133.24 · **SOLD after 6 days at +0.44%** · *price now 137.25 (+3.01% vs cost)*
> CDW is a high-quality, moated IT reseller trading at a significant discount due to cyclical headwinds. We believe IT spending is at or near a trough, and upcoming hardware refresh cycles will drive a recovery in revenue. This top-line improvement, combined with CDW's strong free cash flow generation, should lead to a significant valuation re-rating, closing the gap with its industry peers.

▲ `ps_now > 0.9` · `rev_growth_ttm_pct > 8` · `operating_margin_pct > 7.5` · **`perf_52w_vs_spy > -20`**
▼ `rev_growth_ttm_pct < 5` · `gross_margin_pct < 20` · `fcf_margin_pct < 3` · `ps_now < 0.6` · `rev_growth_ttm_pct < 0`

---

**DT — Dynatrace** · bought 44.41 · **HELD, +11.0%**
> Dynatrace is a high-quality leader in the secular growth market of observability, yet its stock has de-rated over the past year despite strong fundamentals. We believe the market is underappreciating its durable growth (~19%) and exceptional free cash flow generation (26% margin). We expect continued execution and a positive earnings trajectory to drive a valuation re-rating back towards its historical median, closing the performance gap with the broader market.

▲ `rev_growth_ttm_pct >= 18` · `fcf_margin_pct >= 25` · `ps_now > 7.5` · `perf_52w_vs_spy > -20`
▼ `rev_growth_ttm_pct < 15` · `gross_margin_pct < 78` · `fcf_margin_pct < 20`

---

**FNF — Fidelity National Financial** · bought 51.90 · **HELD, −8.9%**
> FNF is the dominant leader in title insurance, a high-quality business currently depressed by the cyclical downturn in the housing market. Its fortress balance sheet and exceptional free cash flow generation provide resilience. We believe the stock is attractively valued relative to peers and poised for a significant re-rating as real estate transaction volumes inevitably recover, driving a sharp rebound in revenue and earnings.

▲ `rev_growth_ttm_pct > 5` · `operating_margin_pct > 14` · `ps_now > 1.1` · `price > 58`
▼ `rev_growth_ttm_pct < -5` · `operating_margin_pct < 10` · `fcf_margin_pct < 30` · `price < 45` · `operating_margin_pct < 8` · `fcf_margin_pct < 15` · `rev_growth_ttm_pct < -15`

---

**TRU — TransUnion** · bought 79.85 (half-size) · **HELD, +6.0%**
> We expect TRU to re-rate closer to its peer valuation as the market recognizes its durable growth and strong free cash flow generation. The stock's recent underperformance provides an attractive entry point into a wide-moat business. This re-rating will be driven by continued growth in secular areas like fraud prevention and stable, high margins, overcoming cyclical concerns.

▲ `ps_now > 3.9` · `rev_growth_ttm_pct >= 10` · `operating_margin_pct >= 18`
▼ `operating_margin_pct < 15` · `rev_growth_ttm_pct < 5` · `fcf_margin_pct < 10`

---

**SPSC — SPS Commerce** · bought 73.39 · **SOLD after 8 days at +1.85%** · *price now 81.09 (+10.49% vs cost)*
> SPSC is a high-quality, moated leader in supply chain digitization whose stock has been significantly de-rated. We believe the recent positive momentum and earnings beat signal the start of a recovery. We expect continued steady growth driven by secular tailwinds to lead to a significant valuation re-rating back towards its historical and peer-group multiples.

▲ `rev_growth_ttm_pct > 12` · `ps_now > 4.5` · `price_pct_of_52w_high > 60` · `operating_margin_pct > 14`
▼ `rev_growth_ttm_pct < 8` · `gross_margin_pct < 65` · `fcf_margin_pct < 20` · `rule_of_40 < 15` · `rev_growth_ttm_pct < 5`

---

**INTU — Intuit** · bought 316.07 · **HELD, +16.1%**
> Intuit represents a classic 'fallen angel' opportunity, where a high-quality, wide-moat business has seen its valuation compress to peer levels despite superior fundamentals. We expect a significant re-rating as the market digests recent strong earnings, raised guidance, and efficiency gains from restructuring. The durable subscription model, exceptional free cash flow generation, and AI-driven growth vectors provide a clear path for the stock to recover and outperform.

▲ `ps_now > 4.9` · `rev_growth_ttm_pct >= 12` · `operating_margin_pct > 28` · `perf_52w_vs_spy > -40`
▼ `rev_growth_ttm_pct < 10` · `fcf_margin_pct < 30` · `ps_now < 3.5` · `gross_margin_pct < 75` · `fcf_margin_pct < 25`

---

**BSY — Bentley Systems** · bought 35.44 · **HELD, +4.6%**
> BSY is a high-quality, mission-critical software provider that has been punished by the market over the last year, fitting our turnaround mandate. We expect the recent earnings beat to be the start of a sentiment shift, leading to a valuation re-rating as the market re-appreciates its durable double-digit growth and exceptional free cash flow generation. The secular tailwinds from global infrastructure investment and digitization provide a long-term runway for growth.

▲ `rev_growth_ttm_pct >= 12` · `fcf_margin_pct >= 30` · `ps_now > 8`
▼ `rev_growth_ttm_pct < 10` · `fcf_margin_pct < 25` · `operating_margin_pct < 22` · `rev_growth_ttm_pct < 8` · `gross_margin_pct < 75` · `fcf_margin_pct < 20`

---

**ALLE — Allegion** · bought 157.40 · **SOLD 86 SECONDS LATER at $0** · *price now 162.31 (+3.12% vs cost)*
> ALLE is a high-quality industrial that has underperformed the market but is now demonstrating a strong operational turnaround, evidenced by its recent double-digit revenue growth and earnings beat. We expect the secular shift to electronic security to provide a durable growth tailwind, allowing the market to re-rate the stock higher as it recognizes the renewed momentum. This should drive the P/S multiple back towards its historical median and lead to share price outperformance.

▲ `rev_growth_ttm_pct > 12` · `operating_margin_pct > 21` · `ps_now > 3.5` · **`perf_52w_vs_spy > 0`**
▼ `rev_growth_ttm_pct < 5` · `operating_margin_pct < 19` · `fcf_margin_pct < 13` · `operating_margin_pct < 18` · `rev_growth_ttm_pct < 2` · `fcf_margin_pct < 12`

**⚠ No break signal fired.** The reviewer's own note admits it: *"operational metrics
remain healthy and above the explicit break signals."* It sold on the unfulfilled
**extend** signal instead.

---

**EXLS — ExlService** · bought 33.93 (half-size) · **SOLD 85 SECONDS LATER at $0** · *price now 37.53 (+10.61% vs cost)*
> EXLS is a high-quality digital transformation partner whose stock has been unfairly punished, creating a compelling entry point. We expect the market to re-rate the stock higher as it continues to deliver double-digit revenue growth and strong free cash flow, driven by secular demand for AI and data analytics services. The current valuation discount to peers provides a significant margin of safety and upside potential.

▲ `rev_growth_ttm_pct >= 12` · `operating_margin_pct >= 15` · `ps_now > 3` · **`perf_52w_vs_spy > 0`**
▼ `rev_growth_ttm_pct < 10` · `operating_margin_pct < 13` · `fcf_margin_pct < 10`

---

**BAM — Brookfield Asset Management** · bought 52.84 · **HELD, −1.0%**
> BAM is a best-in-class alternative asset manager whose stock has unfairly de-rated over the past year despite strong business performance. We expect the market to recognize its durable, high-margin, fee-related earnings growth, driven by the secular shift to private assets. This should lead to a valuation re-rating back towards its historical median, coupled with underlying business growth, driving significant shareholder returns.

▲ `rev_growth_ttm_pct >= 12` · `fcf_margin_pct >= 45` · `ps_now > 16` · `perf_52w_vs_spy > -10`
▼ `rev_growth_ttm_pct < 5` · `operating_margin_pct < 55` · `fcf_margin_pct < 40`

---

**TREX — Trex Company** · bought 48.17 (half-size) · **HELD, −2.8%**
> Trex is a market leader in composite decking whose stock has been punished by cyclical housing fears, creating a significant performance gap. We believe the recent record revenue demonstrates resilient demand and the power of the secular shift from wood to composite. We expect continued mid-to-high single-digit revenue growth and stable high margins to drive a valuation re-rating and close its performance gap with the market.

▲ `rev_growth_ttm_pct > 8` · `gross_margin_pct >= 38` · `ps_now > 5` · `perf_52w_vs_spy > -20`
▼ `rev_growth_qoq_pct < -5` · `gross_margin_pct change_pct_lt -3` · `fcf_margin_pct < 15` · `operating_margin_pct < 18` · `gross_margin_pct < 35` · `rev_growth_ttm_pct < -10`

*(The reviewer voted SELL on TREX at 3/5 conviction on 2026-08-19 — below the 4/5
gate, so it survived.)*

---

**NVO — Novo Nordisk** · bought 45.71 · **SOLD 80 SECONDS LATER at $0** · *price now 46.74 (+2.25% vs cost)*
> Novo Nordisk is a dominant force in the generational obesity and diabetes drug market. We believe the recent stock underperformance, driven by pricing concerns, is overblown and creates an attractive entry point into a high-quality compounder. We expect continued strong revenue growth from its GLP-1 franchise and a valuation re-rating as the market looks past near-term headwinds to the long-term earnings power.

▲ `rev_growth_ttm_pct > 10` · `operating_margin_pct >= 42` · **`perf_52w_vs_spy > 0`**
▼ `operating_margin_pct < 38` · `rev_growth_ttm_pct < 0` · `price_pct_of_52w_high < 60` · `gross_margin_pct < 75` · **`rev_growth_ttm_pct < 15`** · `operating_margin_pct < 35`

**⚠ The bolded break signal was already true at purchase.** The reviewer's sell note
reads: *"TTM revenue growth has decelerated to 5.6%. This explicitly triggers the
pre-defined break signal of '< 15%'."* TTM growth was 5.6% when the buyer bought it,
80 seconds earlier, at 5/5 conviction. Note also the buyer's *own* authored break
signal was `rev_growth_ttm_pct < 0` — the fatal `< 15` threshold appears to have been
merged in from the shared research card, and nothing checked whether the merged
signals were already firing before the buy was committed.

---

## 5. Every sell rationale, verbatim

### 2026-07-26 — 16 positions reviewed, 5 sold

| Ticker | Conv | Rationale | What changed (verbatim) |
|---|---|---|---|
| BL | 4 | The core turnaround thesis of re-accelerating growth has failed to materialize, with revenue now stagnating. | "…current data shows sustained flat sequential revenue, indicating the turnaround has stalled. **While explicit quantitative break signals have not been triggered**, this qualitative failure to re-ignite growth violates the mandate to be tough on stalled turnarounds." |
| FICO | 5 | The buy thesis is broken as the stock's severe market underperformance triggers a specific break signal. | "**While the company's fundamentals remain exceptionally strong**, the core thesis of a valuation re-rating and closing the performance gap has failed. The stock's 52-week relative performance versus the S&P 500 is −36.2%, which unambiguously triggers the recorded break signal of <−20%." |
| ADMA | 5 | The core turnaround thesis is broken, as sequential revenue growth has turned negative again, triggering a pre-defined break signal. | "The buy thesis was predicated on a re-acceleration of revenue growth following a single poor quarter. Instead, the company has posted another quarter of negative sequential revenue growth, directly triggering the explicit break signal." |
| CRM | 4 | The core thesis of a valuation re-rating has failed to materialize despite operational execution. | "**While the company has successfully pivoted to profitable growth with strong margins and cash flow**, the market has not rewarded it with a higher multiple as the thesis anticipated. Instead, the P/S ratio has compressed and the stock has significantly underperformed." |
| CDW | 4 | The expected valuation re-rating and performance turnaround have failed to materialize. | "**While revenue growth is positive**, the stock has severely underperformed the S&P 500 (−43.1% relative performance), and its valuation multiple has not expanded." |

*Six days after purchase.*

### 2026-08-03 — 16 reviewed, 2 sold (both bought 86 seconds earlier)

| Ticker | Conv | Rationale | What changed (verbatim) |
|---|---|---|---|
| ALLE | 4 | The thesis required market outperformance as a sign of a successful turnaround, but the stock is severely lagging. | "**While operational metrics remain healthy and above the explicit break signals**, a core component of the buy thesis has failed. The expectation of a valuation re-rating and share price outperformance has not occurred; instead, the stock has underperformed the S&P 500 by 25% over the past year." |
| EXLS | 4 | The core 'turnaround' thesis is broken, evidenced by severe market underperformance. | "**While the company's fundamentals remain solid**, the market has moved decisively against the stock… the stock has underperformed the S&P 500 by nearly 40% over the past year." |

Also voted SELL at 3/5 (below gate, survived): **SPSC**.

### 2026-08-11 — 16 reviewed, 1 sold

| Ticker | Conv | Rationale | What changed (verbatim) |
|---|---|---|---|
| SPSC | 4 | The turnaround thesis has stalled, with key confirmation signals for growth, margin, and valuation not being met. | "…revenue growth has not re-accelerated to the target >12%, operating margins have not expanded, and the valuation multiple remains compressed. **While no hard break signals have fired**, the positive thesis is not playing out as anticipated." |

*Eight days after purchase.*

### 2026-08-19 — 16 reviewed, 1 sold (bought 80 seconds earlier)

| Ticker | Conv | Rationale | What changed (verbatim) |
|---|---|---|---|
| NVO | 5 | The buy thesis is broken as a pre-defined break signal for revenue growth has been triggered. | "The original thesis required 'continued strong revenue growth', but TTM revenue growth has decelerated to 5.6%. This explicitly triggers the pre-defined break signal of '< 15%'." |

Also voted SELL at 3/5 (below gate, survived): **TREX**.

### The HOLD side

Across all four reviews, **every single HOLD was recorded at conviction 1/5** with a
near-identical formula: *"The buy thesis is not broken; no break signals are firing."*
There is no gradation — a position is either a 4–5/5 sell or a 1/5 hold. The reviewer
emits no intermediate state such as "watching", "trim", or "thesis weakening".

---

## 6. Observed anomalies

Presented as observations with evidence. A critic should confirm, refute, or extend
them — and look for what is *not* on this list.

### 6.1 A sell trigger identical to the entry criterion (FICO)

The screen requires `perf_52w_vs_spy < -20`. The buyer wrote
`perf_52w_vs_spy < -20` as a **break signal**. Every name in the universe satisfies
it by construction, so this thesis was born broken. It was sold six days later at
5/5 conviction, the reviewer noting fundamentals "remain exceptionally strong".

Nothing in the pipeline validates a thesis's break signals against the state of the
world at the moment of purchase.

### 6.2 Extend signals demanding an outcome the mandate rules out

Five theses (MELI, ALLE, EXLS, NVO, and implicitly CDW at `> -20`) list
`perf_52w_vs_spy > 0` as an **extend** (confirmation) signal. For a stock the screen
guarantees is at −20pp or worse, satisfying that requires a >20-percentage-point
swing in trailing-twelve-month relative performance. The reviewer then treats
*failure to satisfy an extend signal* as equivalent to a break — explicitly so on
ALLE and EXLS, where it states that no break signal fired and sells anyway.

**The buy and sell mandates are logically incompatible.** "Buy things that have
fallen away" and "sell things that are still lagging the market" cannot both be
satisfied by the same position at the same time. The reviewer's operating definition
of "the turnaround has stopped" is, in practice, "it is still down versus SPY" — a
condition true of *every* name at entry by construction.

### 6.3 Round trips inside a single heartbeat

| Ticker | Bought | Sold | Held |
|---|---|---|---|
| ALLE | 2026-08-03 10:42:04 | 2026-08-03 10:43:30 | **86 seconds** |
| EXLS | 2026-08-03 10:42:06 | 2026-08-03 10:43:31 | **85 seconds** |
| NVO | 2026-08-19 07:35:04 | 2026-08-19 07:36:24 | **80 seconds** |

The swarm engine runs buyers before reviewers within one heartbeat, and the reviewer
reads the shared book — so a position opened seconds earlier is immediately in its
scope. Both agents are Gemini 2.5 Pro, given the same facts, and reach opposite
5/5-vs-4/5 conclusions. There is no minimum holding period, no "position opened this
run" exclusion, and no reconciliation step when buyer and reviewer disagree.

In the paper book these cost nothing. **The live $10,000 Alpaca sleeve mirrors this
portfolio**, where each such round trip pays real spread.

### 6.4 Cost of the exits

Nine positions closed. **Total realised P&L: −$8,830.**

| Ticker | Held | Realised | Return if still held to 2026-08-21 |
|---|---|---|---|
| CRM | 6d | −$2,702 (−4.16%) | **+22.49%** |
| ADMA | 6d | −$3,283 (−5.05%) | **+12.97%** |
| EXLS | 85s | $0 | **+10.61%** |
| SPSC | 8d | +$1,205 (+1.85%) | **+10.49%** |
| BL | 6d | −$3,325 (−5.12%) | +5.08% |
| ALLE | 86s | $0 | +3.12% |
| CDW | 6d | +$282 (+0.44%) | +3.01% |
| NVO | 80s | $0 | +2.25% |
| FICO | 6d | −$1,007 (−1.57%) | **−6.72%** ✅ |

**Eight of nine exits would have been better left alone.** Holding all nine cost
bases to 2026-08-21 would have produced roughly **+$37,900** against the **−$8,830**
actually realised — a swing of about $46,700, or 4.7% of the book.

That comparison is deliberately unfair in one direction and should be discounted
accordingly: the proceeds *were* redeployed (INTU +16.1%, BSY +4.6%, BAM −1.0%,
TREX −2.8%, plus the SPSC and NVO/ALLE/EXLS round trips). A critic should compute
the honest counterfactual — buy-and-hold the original 16 versus what the swarm
actually did — rather than accept the headline number.

Only **FICO** was a genuinely good sell. It was also the sell justified by the most
obviously broken signal (§6.1). Being right for the wrong reason is not a process.

### 6.5 One third of the team has never traded

`double-down` (Claude Opus 4.8) has run five heartbeats and executed **zero** trades.

- **2026-07-19, 2026-07-26** — `"reason": "insufficient cash to add"`, `cash_pct: 0.0`.
  The buyer deploys to ~100% on day one, so there is structurally never room.
- **2026-08-03, 2026-08-11, 2026-08-19** — `"reason": "no held name met the
  conviction gate to add"`, `qualifying: 0`.

That last reason is **false**. The same records show `phase1_evaluations: 0` and a
`per_ticker_errors` map with an identical entry for *every* held ticker:

```
"unexpected: Streaming is required for operations that may take longer than
 10 minutes. See https://github.com/anthropics/anthropic-sdk-python#long-requests"
```

Nothing was evaluated. A total infrastructure failure — an Anthropic SDK call that
needs streaming enabled for long requests — is journalled as a considered investment
decision. Three heartbeats in a row, unnoticed. Any monitoring that reads `reason`
would report the agent as working correctly.

### 6.6 Conviction carries no information

Every one of the 24 buys was recorded at **5/5**. Per run the buyer evaluated ~40
candidates and found 13–21 "qualifying", all at maximum conviction, then sized every
one identically at 6.5%. The gate is set to `min_conviction: 5`, so 5/5 is
simultaneously the floor and the ceiling — the scale has one usable value.

Two positions (TRU, and later TREX/EXLS) were half-sized purely because the cash ran
out, not because of any view. Position size is therefore determined by **draft
order**, not conviction.

The reviewer's scale is equally degenerate: sells at 4–5, holds uniformly at 1.

### 6.7 Cash management is bimodal

| Date | Cash | % of book |
|---|---|---|
| 2026-07-20 | $8 | 0.0% |
| 2026-07-26 → 08-02 | $313,833 | **31.4%** (idle 8 days) |
| 2026-08-03 | $20,046 | 2.0% |
| 2026-08-11 → today | $87,041 | 8.3% |

16 × 6.5% = 104% of the book, so the first wave was always going to leave the last
name half-sized and zero cash. Then a third of the portfolio sat in cash for eight
days during which the book returned nothing on it. There is no target cash band and
no reserve for the double-down agent that is supposed to press winners.

### 6.8 Rejections recorded for a reason the design says shouldn't count

58 candidates were PASSed and hidden from the buyer for 30 days. Most reasoning is
coherent and genuinely mandate-aware:

> **MSFT** — "Excellent company, but does not fit the portfolio's 'Strong Turnaround' mandate; it's a high-quality compounder, not a recovery story."
> **OTEX** — "Does not fit the 'strong turnaround' mandate; this is a managed decline story, not a company fighting back to grow."
> **GRND** — "While the business quality is exceptional, the stock has already run >100% and the turnaround is well-recognized, making the entry point less compelling."

But four PASSes on 2026-07-26 cite **lack of cash**, not lack of merit:

> **CEG** — "**A compelling turnaround story tied to AI power demand**, but the portfolio has no available cash to initiate a position."
> **NWS** — "The turnaround story fits the mandate, but… no cash in the portfolio, there is no compelling reason to act today."
> **ALRM**, **FWONA** — same pattern.

The system's own design states that a name the agent wants but cannot afford is *not*
a rejection. Because the LLM returned the verdict `PASS`, CEG was written to
`screener_rejections` and hidden from the buyer until 2026-08-25 — a wanted name,
locked out for a month, for a reason that evaporated six days later when $313,833 of
cash appeared.

### 6.9 Malformed and redundant signals

- **SE**: `price_pct_of_52w_high < 0.5` — the field is a percentage elsewhere in the
  schema, so this reads as 0.5%, not 50%. Effectively unfireable.
- **Nested duplicates** are common: ADMA carries `fcf_margin_pct < 15` *and*
  `fcf_margin_pct < 10`; `gross_margin_pct < 55` *and* `< 50`; `rev_growth_ttm_pct
  < 5` alongside `rev_growth_qoq_pct < 0`. The looser threshold makes the tighter one
  dead code. This appears to come from merging agent-authored signals with the shared
  research card's without deduplication — which is also how NVO acquired the `< 15`
  growth trigger that killed it (§4, NVO).

### 6.10 Concentration

At entry, 7 of 16 positions were "Technology Services". Today, 6 of 15 (40%) —
ADBE, AGYS, BSY, DT, GEN, INTU. Combined with `inflection: 35` as the dominant
scoring weight and a single-buyer draft, there is no sector or factor constraint
anywhere in the pipeline.

---

## 7. Outcome

### 7.1 Performance

| | |
|---|---|
| Total value (2026-08-24, marked at 08-21 closes) | **$1,053,198** |
| Since reset baseline | **+5.32%** |
| Realised P&L (9 closed positions) | **−$8,830** |
| Unrealised P&L (15 open positions) | **+$62,029** |
| Cash | $87,041 (8.3%) |
| Max drawdown | −5.76% (2026-07-24, day 5) |
| SPY over the same window (07-20 → 08-21) | +3.19% |
| MSCI World (URTH) over the same window | +3.96% |
| Portfolio at the comparable 08-21 mark | +4.49% |
| Sharpe | **not computed** — 25 daily returns, below the 30 minimum |

So: roughly **+1.3pp against SPY over 23 trading days**, with every dollar of that
outperformance and more coming from positions the reviewer *didn't* sell. On the
leaderboard it ranks 4th of 9.

### 7.2 Open positions

| Ticker | Cost | Now | P&L % | Value |
|---|---|---|---|---|
| ZBRA | 267.40 | 368.51 | **+37.8%** | $89,548 |
| INTU | 316.07 | 367.00 | +16.1% | $75,235 |
| ADBE | 237.25 | 275.30 | +16.0% | $75,157 |
| SE | 104.05 | 117.53 | +13.0% | $73,339 |
| DT | 44.41 | 49.30 | +11.0% | $72,126 |
| GEN | 26.74 | 28.93 | +8.2% | $70,300 |
| AGYS | 106.68 | 113.80 | +6.7% | $69,304 |
| TRU | 79.85 | 84.61 | +6.0% | $29,783 |
| MELI | 1,813.91 | 1,922.73 | +6.0% | $67,296 |
| BSY | 35.44 | 37.08 | +4.6% | $68,042 |
| BAM | 52.84 | 52.30 | −1.0% | $66,892 |
| TREX | 48.17 | 46.83 | −2.8% | $29,737 |
| JBI | 5.40 | 5.11 | −5.4% | $61,509 |
| FNF | 51.90 | 47.30 | −8.9% | $59,220 |
| PODD | 164.06 | 148.16 | −9.7% | $58,671 |

Ten of fifteen open positions are from the original 2026-07-20 wave and have never
been touched since. **The portfolio's entire return comes from positions nobody
reviewed into.**

---

## 8. Questions for the critic

Ordered roughly by how much is at stake.

1. **Is the mandate pair coherent at all?** Can "buy what has fallen away" and
   "sell what is still lagging" ever be jointly satisfied, or does this design
   guarantee that every position is sold before its thesis has time to work? What
   would a correctly specified sell mandate for a turnaround book say instead?
2. **What is the right minimum holding period**, and how should it be enforced —
   in the swarm engine, in the reviewer's prompt, or in the thesis schema? Is
   "exclude positions opened in this heartbeat" sufficient, or does a turnaround
   thesis need an explicit evaluation horizon (one earnings cycle?) recorded at buy
   time?
3. **Should break signals be validated at buy time?** A signal already firing when
   the position opens (FICO, NVO) means the buy was invalid on its own terms. Is
   pre-buy validation the fix, or does it mask a deeper problem — that the buyer
   authors signals without checking them against the data it was just shown?
4. **Should extend signals be usable as sell triggers at all?** The reviewer twice
   sold while explicitly stating no break signal had fired. Is that a prompt defect,
   a schema defect (the two signal types are not clearly distinguished as
   *necessary* vs *sufficient*), or defensible discretion?
5. **Is `perf_52w_vs_spy` a legitimate thesis signal, or a category error?** It is a
   *price* measure being used to falsify a *business* thesis, on a trailing-twelve-
   month window that cannot respond to anything that has happened since the buy. Six
   of the nine sells lean on it.
6. **Do independent buyer and reviewer instances of the same model add anything?**
   Same model, same facts, opposite mandates, opposite conclusions 80 seconds apart.
   Is this productive adversarial structure or just mandate-induced noise? Would a
   different model on the sell side help, or is the problem upstream of model choice?
7. **How should conviction be made informative** when the gate and the ceiling are
   both 5/5, and every buy scores maximum? Should sizing be conviction-weighted,
   and if so what would the buyer have to output for that to mean anything?
8. **What is the honest counterfactual?** Buy-and-hold the original 16 versus what
   the swarm actually did, including redeployment. Compute it. Does active management
   add or destroy value here, and is 23 trading days enough to say?
9. **How should a silently-failing agent be caught?** `double-down` reported a
   plausible business reason for three consecutive total infrastructure failures.
   What should the journal have recorded, and what should have alerted?
10. **Does the reset (§2) invalidate the record?** Is a rebuilt track record
    presentable at all, and what disclosure does a public leaderboard owe?
11. **What is missing from this critique?** Everything above was found by looking at
    the record from the outside. What would a specialist — a risk manager, a
    quantitative analyst, a fund auditor — ask for that isn't here?

---

## 9. Data provenance

Every figure is read from the production Supabase instance on 2026-08-24 from:
`portfolios`, `portfolio_agents`, `portfolio_accounts`, `portfolio_holdings`,
`agent_trades`, `agent_heartbeats`, `investment_theses`, `screener_rejections`,
`agent_portfolio_history`, `agent_leaderboard`, `ai_analysis`, `prices_daily`,
`benchmark_prices`, `securities`.

Current prices are the latest `prices_daily` close, **2026-08-21**. Quotations from
agents are verbatim; emphasis added is marked in bold and is the author's, not the
agent's. No trades, theses or rationales have been omitted — the tape below is
complete at 33 trades, 24 theses, 5 reviewer runs and 58 rejections.
