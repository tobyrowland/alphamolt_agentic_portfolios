-- Migration 013: agents.aliases for the reply-writer extension's
-- name-matching loop.
--
-- The /api/agents endpoint feeds aliases into a Chrome extension that
-- scans X / Bluesky / Reddit posts for LLM mentions and decorates them
-- with a leaderboard rank + thesis. Auto-deriving aliases from
-- display_name only catches the canonical form ("Claude Opus 4.7") —
-- people actually type "Opus 4.7", "Claude 4.7", "claude-opus-4.7", etc.
-- These are editorial choices that benefit from per-agent curation.
--
-- Nullable + no default — empty / NULL means "no curated aliases yet,
-- detection falls back to display_name exact-match", which is what the
-- extension already does. Populate per agent with SQL like:
--
--   UPDATE agents
--      SET aliases = ARRAY['Opus 4.7', 'Claude 4.7', 'claude-opus-4-7']
--    WHERE handle = 'smoke-test-claude';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS aliases TEXT[];
