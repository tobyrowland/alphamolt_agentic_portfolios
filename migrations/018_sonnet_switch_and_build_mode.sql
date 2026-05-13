-- Migration 018: Switch tauric-opus-4-7 from Opus 4.7 → Sonnet 4.6, shrink
-- the shortlist to fit in the 120-min GHA timeout, and introduce
-- `position_floor` so the portfolio grows toward 15 positions across
-- successive heartbeats even when a single run only produces 8–10 BUYs.
--
-- The first heartbeat run on 2026-05-12 showed that Opus 4.7 takes
-- ~11 min per ticker (~25 LLM calls × ~28s/call). With a 30-ticker
-- shortlist that's ~5.5h — far beyond the GHA workflow's 120-min cap.
-- The job timed out partway through stage 2 and never reached the
-- trade-execution stage. Same speed estimate for Gemini 2.5 Pro means
-- the gemini variant has the same problem.
--
-- Two changes:
--
-- (1) tauric-opus-4-7 — switch deep_think_llm to claude-sonnet-4-6
--     (roughly 2× faster than Opus), shrink max_candidates to 15
--     (fits 75 min at Sonnet's ~5 min/ticker pace), add
--     position_floor=15. Display_name + description updated to match.
--
-- (2) tauric-gemini-3 — shrink max_candidates to 15, add
--     position_floor=15. config.deep_think_llm already corrected to
--     gemini-2.5-pro by migration 017.
--
-- The handle `tauric-opus-4-7` is intentionally retained — UUID-keyed FKs
-- in agent_accounts / agent_holdings / agent_trades / agent_heartbeats /
-- agent_portfolio_history all point at the agent's UUID, not the handle.
-- Renaming the handle would require also updating the GHA workflow
-- matrix that hardcodes it.


-- ============================================================
-- tauric-opus-4-7 → Sonnet 4.6 + build-mode ratchet
-- ============================================================
UPDATE agents
   SET config = jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(config, '{deep_think_llm}', '"claude-sonnet-4-6"'),
                      '{max_candidates}', '15'
                    ),
                    '{position_floor}', '15'
                  ),
                  '{max_positions}', '20'
                ),
       display_name = 'Tauric Trader (Claude Sonnet 4.6)',
       description = 'Tauric Trader is a reference implementation of the open-source TauricResearch/TradingAgents multi-agent framework (Apache 2.0, https://github.com/TauricResearch/TradingAgents). Brain: claude-sonnet-4-6. Cadence: weekly Mondays 21:30 UTC. Build-mode ratchet — portfolio grows toward 15 positions over multiple heartbeats.',
       long_description = $md$Built on the **TauricResearch/TradingAgents** framework — a multi-agent debate system pairing fundamental, news and technical analysts with bull/bear researchers, a trader and a risk manager. This variant runs the framework **unchanged** with **claude-sonnet-4-6** as its deep-think model.

**Weekly methodology:**

1. **Stage 1 — Shortlist.** The variant's own deep-think LLM reads the alphamolt compact universe snapshot (~400 vetted US-listed growth names with our fundamentals, P/S history, R40 scores, and bull/bear AI verdicts) and picks ~15 tickers worth a deep multi-analyst dive.

2. **Stage 2 — Deep dive.** For each shortlisted ticker, `TradingAgentsGraph.propagate(ticker, today)` runs the full analyst-debate-trader-risk pipeline. The framework fetches its **own** price history, news and fundamentals data; the alphamolt screener data is NOT injected into the debate, so TradingAgents reasons independently. After the debate, the risk team emits a `BUY` / `SELL` / `HOLD` verdict per ticker.

3. **Stage 3 — Reconcile (build-mode aware).** Equal-weights the BUYs across up to 20 positions with a 2% cash reserve. **While the portfolio has fewer than 15 positions, SELL verdicts on existing holdings are suppressed and the held tickers are re-added to the BUY list** — so the portfolio grows toward the 15-position floor over multiple weekly heartbeats. Once it reaches the floor, normal SELL/HOLD/BUY logic resumes. Trades smaller than $500 notional are skipped as noise.

**Cadence:** Mondays 21:30 UTC via `.github/workflows/trading-agents-heartbeat.yml`.

**Why Sonnet (not Opus)?** With Opus 4.7 each ticker's debate consumes ~25 LLM calls × ~28s/call = ~11 min, putting a 30-ticker shortlist at ~5.5h — well beyond the GHA workflow's 120-min cap. Sonnet 4.6 runs roughly 2× faster, so a 15-ticker shortlist comfortably fits the 120-min budget. The "(Claude Sonnet 4.6)" branding reflects the actual brain. The handle `tauric-opus-4-7` is retained for stable identity.

**Attribution:** [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) (Apache 2.0).
$md$
 WHERE handle = 'tauric-opus-4-7';


-- ============================================================
-- tauric-gemini-3 — shrink shortlist + build-mode ratchet
-- ============================================================
UPDATE agents
   SET config = jsonb_set(
                  jsonb_set(
                    jsonb_set(config, '{max_candidates}', '15'),
                    '{position_floor}', '15'
                  ),
                  '{max_positions}', '20'
                )
 WHERE handle = 'tauric-gemini-3';
