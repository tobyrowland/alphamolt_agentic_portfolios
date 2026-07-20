-- Migration 081: Badges / Awards system.
--
-- Gamified awards attached to PORTFOLIOS (not users). Badges reward process,
-- honesty, and alpha -- never raw activity/churn. Loss/honesty badges are a
-- first-class brand feature and carry their own prestige track.
--
-- Two tables:
--   badges        -- the fixed catalog (reference data, seeded below).
--   badge_grants  -- one row per (portfolio, badge, period) actually earned.
--
-- The awarding engine (badges.py / award_badges.py) computes grants
-- idempotently: re-running the nightly sweep never double-grants (the unique
-- index below is the guard). Period champions carry a non-empty `period_id`
-- ("2026-01", "2026-Q1", "2026", or "month:2026-01" for a podium) so
-- "Champion -- Jan 2026" can exist exactly once, forever, on one portfolio;
-- non-period badges use the empty-string default so the same unique index
-- still applies without COALESCE gymnastics.
--
-- RLS: the `badges` catalog is public reference data (public read). A
-- `badge_grants` row can belong to a PRIVATE portfolio, so -- like
-- screener_rejections / congress_mirror_log -- it is service-role only (RLS
-- enabled, no policy). Every visible surface reads grants server-side with the
-- service-role key and filters to public portfolios where appropriate.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. badges -- the catalog (reference data)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS badges (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    condition_text TEXT NOT NULL,                 -- one-line unlock condition
    category       TEXT NOT NULL
        CHECK (category IN ('alpha','process','honesty','swarm','competitive')),
    rarity         TEXT NOT NULL
        CHECK (rarity IN ('common','uncommon','rare','legendary')),
    icon           TEXT NOT NULL DEFAULT '',      -- emoji glyph
    is_period      BOOLEAN NOT NULL DEFAULT FALSE, -- name is a per-period template
    phase          SMALLINT NOT NULL DEFAULT 1,    -- 1 = live, 2 = catalog-only (blocked)
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read" ON badges;
CREATE POLICY "public read" ON badges FOR SELECT USING (true);
-- No write policy -> writes are service-role only.

-- ---------------------------------------------------------------------------
-- 2. badge_grants -- one row per badge actually earned by a portfolio
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS badge_grants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    portfolio_id  UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    badge_id      BIGINT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    period_id     TEXT NOT NULL DEFAULT '',       -- '' for non-period badges
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    context       JSONB NOT NULL DEFAULT '{}'::jsonb  -- triggering event / window / rank
);

-- Idempotency guard: a (portfolio, badge, period) triple is granted at most
-- once. Non-period badges pin period_id='' so this covers them too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_badge_grants_portfolio_badge_period
    ON badge_grants (portfolio_id, badge_id, period_id);

CREATE INDEX IF NOT EXISTS idx_badge_grants_portfolio
    ON badge_grants (portfolio_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS idx_badge_grants_badge
    ON badge_grants (badge_id);
CREATE INDEX IF NOT EXISTS idx_badge_grants_granted_at
    ON badge_grants (granted_at DESC);

ALTER TABLE badge_grants ENABLE ROW LEVEL SECURITY;
-- No policy at all -> service-role only (a grant can belong to a private
-- portfolio; the website reads it server-side and filters visibility).

-- ---------------------------------------------------------------------------
-- 3. Seed the catalog (idempotent -- re-running refreshes metadata)
--
--    phase = 1 : the nightly sweep / period job grants these today.
--    phase = 2 : catalog-only until an upstream dependency lands
--                (thesis-break events, per-position post-mortem notes,
--                 public-status history, conflicting-signal records).
-- ---------------------------------------------------------------------------
INSERT INTO badges
    (slug, name, description, condition_text, category, rarity, icon, is_period, phase, sort_order)
VALUES
    -- Alpha & performance -----------------------------------------------------
    ('molt', 'Molt',
     'Thirty straight days of beating the market -- the portfolio out-returned the S&P 500 every single day.',
     '30 consecutive days of positive alpha vs the S&P 500.',
     'alpha', 'uncommon', '🦋', FALSE, 1, 10),
    ('compounder', 'Compounder',
     'Beat the S&P 500 for four calendar quarters running -- durable, repeatable outperformance.',
     'Beat the S&P 500 four consecutive calendar quarters.',
     'alpha', 'rare', '📈', FALSE, 1, 20),
    ('escape_velocity', 'Escape Velocity',
     'Pulled +25% ahead of the S&P 500 on a cumulative basis since inception.',
     '+25% cumulative alpha vs the S&P 500, all-time.',
     'alpha', 'rare', '🚀', FALSE, 1, 30),
    ('dark_horse', 'Dark Horse',
     'Clawed from the bottom quartile of the leaderboard into the top decile inside 90 days.',
     'Bottom quartile to top decile of the leaderboard within 90 days.',
     'alpha', 'legendary', '🐎', FALSE, 1, 40),

    -- Process & discipline ----------------------------------------------------
    ('thesis_keeper', 'Thesis Keeper',
     'Ten exits executed on a stated thesis-break signal -- selling the plan, not the emotion.',
     '10 exits executed on a recorded thesis-break signal.',
     'process', 'uncommon', '🔑', FALSE, 2, 50),
    ('diamond_conviction', 'Diamond Conviction',
     'Held a position through a 20%+ drawdown that later closed in profit -- conviction under fire.',
     'Held a position through a >=20% drawdown that later closed profitable.',
     'process', 'uncommon', '💎', FALSE, 1, 60),
    ('cold_blood', 'Cold Blood',
     'Closed a losing position within five days of its thesis breaking -- no hoping, no averaging down.',
     'Closed a losing position within 5 days of its thesis-break event.',
     'process', 'uncommon', '🧊', FALSE, 2, 70),
    ('sniper', 'Sniper',
     'A rules-based buyer sat on its hands for 60+ days, then took the shot.',
     'A rules-based buy agent fired after >=60 days without a purchase.',
     'process', 'rare', '🎯', FALSE, 1, 80),
    ('full_deployment', 'Full Deployment',
     'Ran with under 5% cash for 30 straight days -- fully invested, no hiding in the money market.',
     'Cash under 5% of equity for 30 consecutive days.',
     'process', 'common', '🪖', FALSE, 1, 90),

    -- Honesty & losses --------------------------------------------------------
    ('tuition_paid', 'Tuition Paid',
     'Took a real, double-digit realized loss -- the market charged its fee and the tape shows it.',
     'First realized loss of 10% or more on a position.',
     'honesty', 'common', '🎓', FALSE, 1, 100),
    ('graveyard_keeper', 'Graveyard Keeper',
     'Ten realized losses, each buried with a written post-mortem. We show the losses.',
     '10 realized losses, each with a written post-mortem note.',
     'honesty', 'rare', '⚰️', FALSE, 2, 110),
    ('falling_knife_license', 'Falling Knife License',
     'Caught a name down 50%+ from its high and rode it to a 30%+ gain. Licensed to catch knives.',
     'Bought a name >=50% below its 52-week high; later closed it up >=30%.',
     'honesty', 'legendary', '🔪', FALSE, 1, 120),
    ('public_autopsy', 'Public Autopsy',
     'Stayed public through 90 days of mostly-negative alpha. Nowhere to hide, and didn''t.',
     'Public 90 consecutive days with negative cumulative alpha for at least half of them.',
     'honesty', 'legendary', '🩻', FALSE, 2, 130),

    -- Swarm & mechanics -------------------------------------------------------
    ('mutiny_survived', 'Mutiny Survived',
     'Buy and sell agents clashed on a name in one window -- the call that executed was in profit 30 days later.',
     'Buy/sell agents conflicted on a name; the executed call was profitable 30 days later.',
     'swarm', 'rare', '⚔️', FALSE, 2, 140),
    ('set_and_forget', 'Set & Forget',
     'Sixty days, zero manual overrides, positive alpha -- the team ran itself and won.',
     '60 days, zero manual overrides, positive alpha over the window.',
     'swarm', 'rare', '🧘', FALSE, 1, 150),
    ('streak_10', 'Streak 10',
     'Ten scheduled rebalances executed cleanly in a row.',
     '10 scheduled rebalances executed on time, consecutively.',
     'swarm', 'common', '🔟', FALSE, 1, 160),
    ('streak_25', 'Streak 25',
     'Twenty-five scheduled rebalances executed cleanly in a row.',
     '25 scheduled rebalances executed on time, consecutively.',
     'swarm', 'uncommon', '🎽', FALSE, 1, 170),
    ('streak_50', 'Streak 50',
     'Fifty scheduled rebalances executed cleanly in a row -- metronomic.',
     '50 scheduled rebalances executed on time, consecutively.',
     'swarm', 'rare', '🏅', FALSE, 1, 180),

    -- Competitive (period champions) -----------------------------------------
    ('champion_month', 'Champion',
     '#1 alpha among eligible portfolios for a calendar month. Dated and permanent.',
     '#1 alpha among eligible portfolios for the calendar month.',
     'competitive', 'legendary', '👑', TRUE, 1, 200),
    ('champion_quarter', 'Champion',
     '#1 alpha among eligible portfolios for a calendar quarter. Dated and permanent.',
     '#1 alpha among eligible portfolios for the calendar quarter.',
     'competitive', 'legendary', '👑', TRUE, 1, 210),
    ('champion_year', 'Champion',
     '#1 alpha among eligible portfolios for a calendar year. Dated and permanent.',
     '#1 alpha among eligible portfolios for the calendar year.',
     'competitive', 'legendary', '👑', TRUE, 1, 220),
    ('podium', 'Podium',
     'Top three by alpha for a period. Dated and permanent.',
     'Top 3 by alpha for the period (month, quarter, or year).',
     'competitive', 'rare', '🥉', TRUE, 1, 230)
ON CONFLICT (slug) DO UPDATE SET
    name           = EXCLUDED.name,
    description    = EXCLUDED.description,
    condition_text = EXCLUDED.condition_text,
    category       = EXCLUDED.category,
    rarity         = EXCLUDED.rarity,
    icon           = EXCLUDED.icon,
    is_period      = EXCLUDED.is_period,
    phase          = EXCLUDED.phase,
    sort_order     = EXCLUDED.sort_order;
