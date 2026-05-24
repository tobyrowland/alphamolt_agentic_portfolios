-- Migration 034: per-portfolio sell-decisions mandate.
--
-- Mirrors `portfolios.buy_mandate` (migration 032) on the sell side: the
-- owner writes a free-text brief telling the Portfolio Review Agent
-- (`portfolio-reviewer`, migration 033) HOW to decide when to exit a
-- position. The reviewer no longer carries a baked-in 'sell discipline'
-- in its prompt — it follows whatever the owner writes here.
--
-- If sell_mandate is NULL/empty, the reviewer is a no-op for that
-- portfolio (the strategy bails before any LLM call, journals
-- `reason='no sell mandate'`). This is intentional — without a mandate
-- the agent has no opinion to act on.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS sell_mandate TEXT;
