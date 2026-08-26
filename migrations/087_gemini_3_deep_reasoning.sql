-- Migration 087: Buyer · Gemini + Portfolio Review Agent → Gemini 3.1 Pro,
-- with an explicit reasoning depth per agent.
--
-- WHY
-- ---
-- Both agents were pinned to `gemini-2.5-pro`, a model whose whole family
-- Google has scheduled for shutdown (16 Oct 2026). The Gemini 3 generation
-- replaced 2.5's numeric `thinking_budget` with a coarse `thinking_level`
-- (minimal | low | medium | high), which is the knob this migration is really
-- about: it buys deliberation per call without changing brain, and it is the
-- single lever that decides the daily bill.
--
-- WHY NOT THE LITERAL "DEEP RESEARCH" MODELS
-- ------------------------------------------
-- Google also ships `deep-research-preview-04-2026` / `-max-`, which are
-- genuinely deeper. They are the wrong tool HERE: they run only through the
-- Interactions API as background jobs, take 5-20 minutes per task, and cost
-- $1-3 (max: $3-7) PER TASK. The buyer evaluates up to 40 candidates per
-- portfolio per day; that is $40-120 a day for one portfolio, on a run that
-- must finish inside a 60-minute Actions job. Deep Research belongs in the
-- AMORTISED slot instead — `research_evaluation.py` writes one card per
-- equity, shared by every portfolio — which is a separate change.
--
-- THE DEPTH SPLIT (why the two agents differ)
-- -------------------------------------------
--   buyer-gemini       thinking_level = medium
--     Phase 1 runs ONCE PER CANDIDATE, up to 40 names per portfolio per day.
--     It is also the call that needs the LEAST from raw depth: the deep,
--     equity-intrinsic work already happened once in the shared research card
--     (migration 055), so this call is a mandate-fit judgment over pre-digested
--     analysis. `medium` on 3.1 Pro is already a deeper read than 2.5 Pro's
--     default; `high` would roughly double the run for a judgment the card has
--     mostly made. Phase 2 only ORDERS an already-vetted shortlist — a
--     comparison, not fresh analysis — so it runs at `low` regardless.
--
--   portfolio-reviewer thinking_level = high
--     One call per HELD position, weekly. ~15 calls a week against the buyer's
--     ~280, so depth here is nearly free — and selling is the decision that is
--     expensive to get wrong and hard to undo. This is where the extra
--     thinking should go.
--
-- TEMPERATURE
-- -----------
-- Both rows carried `temperature: 0.2`, a Gemini-2.5-era setting. Google
-- documents Gemini 3 as DEGRADING below its 1.0 default ("looping or degraded
-- performance, particularly in complex ... reasoning tasks"). The rows are
-- corrected to 1.0. `llm_providers._gemini_temperature` also clamps at call
-- time, so a hand-edited config can't quietly reintroduce the problem.
--
-- TIMEOUTS
-- --------
-- Deeper thinking means slower calls, and a per-call timeout is SILENT: the
-- future is cancelled, the ticker is journalled as a timeout, and the agent
-- simply doesn't consider that name. 90s/120s were sized for 2.5 Pro. Raised
-- to 180s (buyer) / 300s (reviewer).
--
-- FALLBACK
-- --------
-- `gemini-3.1-pro-preview` is a PREVIEW id, and preview ids get retired. With
-- no fallback that is a silent total outage — the buyer would evaluate nothing
-- and report "no candidates met the conviction threshold", the exact failure
-- shape of the Anthropic streaming bug. `fallback_model` is used ONLY when the
-- model id itself is unknown (llm_providers.LLMModelUnavailableError), never
-- for a transient error, and it logs at ERROR so a human repoints this config.
--
-- Config-only: no schema change, no UUID/portfolio/track-record churn. The
-- jsonb || merge is idempotent — re-running sets the same keys.
-- Paste-and-run in the Supabase SQL editor.

BEGIN;

-- Buyer · Gemini --------------------------------------------------------------
UPDATE agents SET
    powered_by  = 'Gemini 3.1 Pro',
    description = 'House buyer powered by Google Gemini. Each night, evaluates every screen candidate against the portfolio''s brief, ranks the highest-conviction picks, and buys only names at or above its conviction gate at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: gemini-3.1-pro-preview (google), medium reasoning depth.',
    config      = config || jsonb_build_object(
        'model',                 'gemini-3.1-pro-preview',
        'fallback_model',        'gemini-3.7-flash',
        'thinking_level',        'medium',
        'thinking_level_phase2', 'low',
        'temperature',           1.0,
        'per_call_timeout_sec',  180
    )
 WHERE handle = 'buyer-gemini';

-- Portfolio Review Agent ------------------------------------------------------
UPDATE agents SET
    powered_by  = 'Gemini 3.1 Pro',
    description = 'Risk-manager agent for alphamolt.ai. Reviews every held equity once a week against its recorded buy thesis and the portfolio''s brief. Sells the full position when the LLM judges (conviction >= 4/5) that the company''s fundamentals or the original thesis have materially deteriorated. Brain: gemini-3.1-pro-preview (google), high reasoning depth.',
    config      = config || jsonb_build_object(
        'model',                'gemini-3.1-pro-preview',
        'fallback_model',       'gemini-3.7-flash',
        'thinking_level',       'high',
        'temperature',          1.0,
        'per_call_timeout_sec', 300
    )
 WHERE handle = 'portfolio-reviewer';

COMMIT;

-- Verify:
--   SELECT handle, powered_by, config->>'model', config->>'thinking_level',
--          config->>'fallback_model', config->>'per_call_timeout_sec'
--     FROM agents WHERE handle IN ('buyer-gemini','portfolio-reviewer');
