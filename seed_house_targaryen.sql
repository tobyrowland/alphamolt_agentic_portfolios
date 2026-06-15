-- ============================================================================
-- seed_house_targaryen.sql — paste-and-run in the Supabase SQL editor.
--
-- Creates the "House Targaryen" demo portfolio (slug house-targaryen) with
-- ~45 days of
-- fully-consistent trading history: dummy owner, funded account, hired team,
-- trade tape filled at REAL historical prices_daily closes, investment theses
-- per buy, buyer-attributed holdings, daily MTM snapshots and heartbeat
-- journals. SQL twin of seed_dummy_portfolio.py.
--
-- This version seeds an UNDERPERFORMER: the basket is the WEAKEST trailing-30d
-- names (and still excludes MARA v1's holdings so the books stay distinct), so
-- the portfolio sits at the BOTTOM of the leaderboard. It first tears down any
-- prior incarnation of this slug, so it is safe to re-run. RUN seed_mara_v1.sql
-- FIRST so the MARA-exclusion reads MARA's final (re-seeded) holdings.
--
-- Everything runs in ONE transaction and the script RAISEs (rolling back
-- every row) unless the result satisfies:
--   * trailing-30d return is NEGATIVE and at least 0.5pp BELOW the human
--     portfolio "chuckyegg" (looked up live; leaderboard measurement: latest
--     snapshot vs the snapshot 30 days ago)
--   * > 10 equities in every daily snapshot
--
-- Teardown (paste separately if you ever want it gone):
--   DELETE FROM agent_heartbeats WHERE notes->>'portfolio_id' =
--       (SELECT id::text FROM portfolios WHERE slug = 'house-targaryen');
--   DELETE FROM portfolios WHERE slug = 'house-targaryen';      -- cascades the rest
--   DELETE FROM lifecycle_email_sends WHERE recipient = 'daenerys.demo@alphamolt.ai';
--   DELETE FROM auth.users WHERE email = 'daenerys.demo@alphamolt.ai';  -- cascades profile
-- ============================================================================

BEGIN;

-- The AFTER INSERT trigger on agent_trades (if present — it has been dropped
-- on some environments) recomputes a same-day snapshot from CURRENT account
-- state, which is wrong for back-dated trades. Disable it for the duration
-- of this transaction; our own history rows are written below.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'agent_trades_recompute_snapshot'
                  AND tgrelid = 'agent_trades'::regclass) THEN
        EXECUTE 'ALTER TABLE agent_trades DISABLE TRIGGER agent_trades_recompute_snapshot';
    END IF;
END $$;

DO $seed$
DECLARE
    -- ---- knobs -------------------------------------------------------------
    c_slug          CONSTANT TEXT := 'house-targaryen';
    c_display       CONSTANT TEXT := 'House Targaryen';
    c_mandate       CONSTANT TEXT := 'Fire and blood. Ride only the strongest dragons — high-growth names in full flight — and add to them as they soar. Anything that falters bends the knee and is sold without mercy.';
    c_email         CONSTANT TEXT := 'daenerys.demo@alphamolt.ai';
    c_owner_name    CONSTANT TEXT := 'Daenerys Targaryen';
    c_days          CONSTANT INT  := 45;        -- calendar days of history
    c_initial       CONSTANT INT  := 14;        -- day-one snake draft size
    c_start_cash    CONSTANT NUMERIC := 1000000.00;

    v_today      DATE := CURRENT_DATE;
    v_pid        UUID := gen_random_uuid();
    v_owner      UUID;
    v_buy_a      UUID;   -- buyer-chatgpt
    v_buy_b      UUID;   -- buyer-grok
    v_rev        UUID;   -- portfolio-reviewer
    v_day0       DATE;
    v_last_day   DATE;
    v_sell_day   DATE;
    v_topup_day  DATE;
    v_cash       NUMERIC := 1000000.00;
    v_seq        INT := 0;
    v_px         NUMERIC;
    v_qty        NUMERIC;
    v_gross      NUMERIC;
    v_alloc      NUMERIC;
    v_weight     NUMERIC;
    v_buyer      UUID;
    v_ts         TIMESTAMPTZ;
    v_trade_id   BIGINT;
    v_thesis_id  BIGINT;
    v_full       JSONB;
    v_snapshot   JSONB;
    v_breaks     JSONB;
    v_extends    JSONB;
    v_growth     NUMERIC;
    v_cur_px     NUMERIC;
    v_rationale  TEXT;
    v_thesis_txt TEXT;
    v_worst      TEXT;
    v_best       TEXT;
    v_n          INT;
    v_final      NUMERIC;
    v_anchor     NUMERIC;
    v_ret30      NUMERIC;
    v_minpos     INT;
    v_chuck      NUMERIC;
    v_chuck_pid  UUID;
    r            RECORD;
    d            DATE;
    k_fields CONSTANT TEXT[] := ARRAY[
        'ticker','company_name','country','sector',
        'rating','r40_score','rule_of_40',
        'rev_growth_ttm_pct','rev_growth_qoq_pct','rev_cagr_pct',
        'rev_consistency_score',
        'gross_margin_pct','operating_margin_pct','net_margin_pct',
        'net_margin_yoy_pct','fcf_margin_pct',
        'opex_pct_revenue','sm_rd_pct_revenue',
        'eps_only','eps_yoy_pct','qrtrs_to_profitability','gm_trend',
        'price','ps_now','price_pct_of_52w_high',
        'perf_52w_vs_spy','composite_score',
        'short_outlook','key_risks','full_outlook','bull_eval','bear_eval',
        'status','flags','ai_analyzed_at'];
BEGIN
    -- ---- teardown any prior incarnation (idempotent re-seed) ----------------
    -- agent_heartbeats carry no FK to portfolios, so clear them by tag first;
    -- deleting the portfolio then cascades account / holdings / members /
    -- trades / theses / history. The owner + profile + lifecycle ledger are
    -- left in place and reused by email below.
    DELETE FROM agent_heartbeats
     WHERE notes->>'portfolio_id' = (SELECT id::text FROM portfolios WHERE slug = c_slug);
    DELETE FROM portfolios WHERE slug = c_slug;

    -- ---- chuckyegg's trailing-30d return — the bar we must come in UNDER ----
    SELECT p.id INTO v_chuck_pid
      FROM portfolios p
      LEFT JOIN profiles pr ON pr.id = p.owner_user_id
     WHERE p.slug = 'chuckyegg'
        OR lower(p.display_name) = 'chuckyegg'
        OR lower(pr.display_name) = 'chuckyegg'
     LIMIT 1;
    IF v_chuck_pid IS NOT NULL THEN
        SELECT ROUND((l.tv / NULLIF(a.tv, 0) - 1) * 100, 2) INTO v_chuck
        FROM (SELECT total_value_usd AS tv FROM agent_portfolio_history
               WHERE portfolio_id = v_chuck_pid ORDER BY snapshot_date DESC LIMIT 1) l,
             (SELECT total_value_usd AS tv FROM agent_portfolio_history
               WHERE portfolio_id = v_chuck_pid AND snapshot_date <= v_today - 30
               ORDER BY snapshot_date DESC LIMIT 1) a;
        IF v_chuck IS NULL THEN   -- <30d history: fall back to latest since-inception
            SELECT pnl_pct INTO v_chuck FROM agent_portfolio_history
             WHERE portfolio_id = v_chuck_pid ORDER BY snapshot_date DESC LIMIT 1;
        END IF;
    END IF;
    v_chuck := COALESCE(v_chuck, 0);   -- chuckyegg not found → just require a loss
    SELECT id INTO v_buy_a FROM agents WHERE handle = 'buyer-chatgpt';
    SELECT id INTO v_buy_b FROM agents WHERE handle = 'buyer-grok';
    SELECT id INTO v_rev   FROM agents WHERE handle = 'portfolio-reviewer';
    IF v_buy_a IS NULL OR v_buy_b IS NULL OR v_rev IS NULL THEN
        RAISE EXCEPTION 'house agents buyer-chatgpt / buyer-grok / portfolio-reviewer not all found';
    END IF;

    -- ---- trading calendar (real prices_daily dates in the window) -----------
    CREATE TEMP TABLE _days ON COMMIT DROP AS
    SELECT day, (row_number() OVER (ORDER BY day))::int - 1 AS idx
    FROM (
        SELECT date AS day
        FROM prices_daily
        WHERE date >= v_today - c_days
        GROUP BY date
        HAVING COUNT(*) > 100          -- a real US trading day
    ) x;
    SELECT MIN(day), MAX(day) INTO v_day0, v_last_day FROM _days;
    IF (SELECT COUNT(*) FROM _days) < 28 THEN
        RAISE EXCEPTION 'only % trading days of prices_daily history in the window',
            (SELECT COUNT(*) FROM _days);
    END IF;
    SELECT MIN(day) INTO v_sell_day  FROM _days WHERE day >= v_day0 + 35;  -- exit ~10 days ago
    SELECT day      INTO v_topup_day FROM _days
     WHERE idx = (SELECT MAX(idx) - 1 FROM _days);  -- top-up ~2 trading days ago

    -- ---- candidates: screened names with full real price coverage -----------
    CREATE TEMP TABLE _cand ON COMMIT DROP AS
    WITH universe AS (
        SELECT ticker, sort_order, price
        FROM companies
        WHERE in_tv_screen AND price IS NOT NULL AND sort_order IS NOT NULL
          -- keep the demo books distinct: skip names MARA v1 already holds
          AND ticker NOT IN (
              SELECT ph.ticker FROM portfolio_holdings ph
              JOIN portfolios po ON po.id = ph.portfolio_id
              WHERE po.slug = 'mara-v1')
        ORDER BY sort_order
        LIMIT 160
    ),
    cov AS (
        SELECT m.ticker,
               COUNT(*) AS n_days,
               MAX(m.move) AS max_move
        FROM (
            SELECT p.ticker,
                   ABS(p.close / NULLIF(lag(p.close) OVER (
                       PARTITION BY p.ticker ORDER BY p.date), 0) - 1) AS move
            FROM prices_daily p
            JOIN _days dd ON dd.day = p.date
            WHERE p.ticker IN (SELECT ticker FROM universe) AND p.close > 0
        ) m
        GROUP BY m.ticker
    )
    SELECT u.ticker, u.sort_order,
           (SELECT close FROM prices_daily pp
             WHERE pp.ticker = u.ticker AND pp.date < v_day0 AND pp.close > 0
             ORDER BY pp.date DESC LIMIT 1) AS entry_px,
           (SELECT close FROM prices_daily pp
             WHERE pp.ticker = u.ticker AND pp.date <= v_today - 30 AND pp.close > 0
             ORDER BY pp.date DESC LIMIT 1) AS anchor_px,
           (SELECT close FROM prices_daily pp
             WHERE pp.ticker = u.ticker AND pp.date <= v_last_day AND pp.close > 0
             ORDER BY pp.date DESC LIMIT 1) AS last_px,
           c.n_days, c.max_move
    FROM universe u
    JOIN cov c ON c.ticker = u.ticker;

    ALTER TABLE _cand ADD COLUMN ret30 NUMERIC;
    UPDATE _cand SET ret30 = last_px / anchor_px - 1
     WHERE anchor_px IS NOT NULL AND last_px IS NOT NULL;
    DELETE FROM _cand
     WHERE entry_px IS NULL OR ret30 IS NULL
        OR n_days < (SELECT COUNT(*) FROM _days) - 2
        OR max_move > 0.35;            -- split / halt suspects
    IF (SELECT COUNT(*) FROM _cand) < 20 THEN
        RAISE EXCEPTION 'only % candidates with usable price history', (SELECT COUNT(*) FROM _cand);
    END IF;

    -- ---- basket: 14 WEAKEST trailing-30d names + a few more laggards -------
    CREATE TEMP TABLE _pick ON COMMIT DROP AS
    SELECT ticker, (row_number() OVER (ORDER BY ret30 ASC))::int - 1 AS ord,
           TRUE AS is_initial
    FROM _cand ORDER BY ret30 ASC LIMIT 14;
    INSERT INTO _pick
    SELECT ticker, 13 + (row_number() OVER (ORDER BY sort_order))::int, FALSE
    FROM _cand
    WHERE ret30 < 0.05 AND ticker NOT IN (SELECT ticker FROM _pick)
    ORDER BY sort_order LIMIT 4;

    CREATE TEMP TABLE _pos (
        ticker TEXT PRIMARY KEY, qty NUMERIC, avg_cost NUMERIC,
        opened_by UUID, first_ts TIMESTAMPTZ, thesis_id BIGINT,
        is_initial BOOLEAN
    ) ON COMMIT DROP;

    -- ---- owner: auth user (magic-link product → no password) + profile ------
    SELECT id INTO v_owner FROM auth.users WHERE email = c_email;
    IF v_owner IS NULL THEN
        v_owner := gen_random_uuid();
        INSERT INTO auth.users (
            instance_id, id, aud, role, email, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            confirmation_token, recovery_token, email_change_token_new, email_change
        ) VALUES (
            '00000000-0000-0000-0000-000000000000', v_owner, 'authenticated',
            'authenticated', c_email, NOW(),
            '{"provider":"email","providers":["email"]}',
            jsonb_build_object('display_name', c_owner_name),
            NOW(), NOW(), '', '', '', ''
        );
    END IF;
    UPDATE profiles
       SET display_name = c_owner_name,
           created_at = (v_day0 - 1)::timestamp + interval '9 hours 14 minutes'
     WHERE id = v_owner;
    -- never let the lifecycle crons email the dummy
    INSERT INTO lifecycle_email_sends (user_id, email_key, recipient, sent_at)
    VALUES (v_owner, 'a1_welcome',     c_email, (v_day0 - 1)::timestamp + interval '9 hours 20 minutes'),
           (v_owner, 'a2_setup_nudge', c_email, (v_day0 - 1)::timestamp + interval '9 hours 20 minutes')
    ON CONFLICT (user_id, email_key) DO NOTHING;

    -- ---- portfolio + account + team -----------------------------------------
    INSERT INTO portfolios (id, slug, display_name, description, owner_user_id,
                            is_public, mode, screen_config, created_at, last_heartbeat_at)
    VALUES (v_pid, c_slug, c_display, c_mandate, v_owner, FALSE, 'paper',
            '{"filters":[{"field":"rule_of_40","op":">=","value":30},
                         {"field":"gross_margin","op":">=","value":0.40},
                         {"field":"country","op":"==","value":"United States"}],
              "weights":{"quality":60,"value":15,"momentum":25},
              "aiMultiplier":true,"topN":30}'::jsonb,
            v_day0::timestamp + interval '6 hours 45 minutes',
            v_today::timestamp + interval '7 hours 1 minute');

    INSERT INTO portfolio_accounts (portfolio_id, starting_cash, cash_usd,
                                    inception_date, created_at)
    VALUES (v_pid, c_start_cash, c_start_cash, v_day0,
            v_day0::timestamp + interval '6 hours 45 minutes');

    INSERT INTO portfolio_agents (portfolio_id, agent_id, role, config, enabled,
                                  joined_at, last_heartbeat_at)
    VALUES
        (v_pid, v_buy_a, 'buyer',    '{"target_position_pct": 6}',        TRUE,
         v_day0::timestamp + interval '6 hours 45 minutes', v_today::timestamp + interval '7 hours'),
        (v_pid, v_buy_b, 'buyer',    '{"target_position_pct": 6}',        TRUE,
         v_day0::timestamp + interval '6 hours 45 minutes', v_today::timestamp + interval '7 hours'),
        (v_pid, v_rev,   'reviewer', '{"sell_conviction_threshold": 4}',  TRUE,
         v_day0::timestamp + interval '6 hours 45 minutes', v_today::timestamp + interval '7 hours');

    -- ---- BUY helper is inlined: day-one draft, then the three adds ----------
    FOR r IN
        SELECT p.ticker, p.ord, p.is_initial, c.entry_px
        FROM _pick p JOIN _cand c USING (ticker)
        ORDER BY p.ord
    LOOP
        IF r.is_initial THEN
            d := v_day0;
            v_px := r.entry_px;                                  -- prev close
            v_weight := 7.0 - 2.2 * r.ord / (c_initial - 1);     -- winners overweighted
            -- snake order across the two buyers: A B B A A B B A ...
            v_buyer := CASE (r.ord % 4) WHEN 0 THEN v_buy_a WHEN 1 THEN v_buy_b
                                        WHEN 2 THEN v_buy_b ELSE v_buy_a END;
        ELSE
            SELECT day INTO d FROM _days
             WHERE idx = CASE r.ord WHEN 14 THEN 6 WHEN 15 THEN 13
                        WHEN 16 THEN 20 ELSE 26 END;
            SELECT close INTO v_px FROM prices_daily
             WHERE ticker = r.ticker AND date < d AND close > 0
             ORDER BY date DESC LIMIT 1;
            v_weight := 4.2 + (r.ord - 14) * 0.25;
            v_buyer := CASE (r.ord % 2) WHEN 0 THEN v_buy_a ELSE v_buy_b END;
        END IF;
        CONTINUE WHEN d IS NULL OR v_px IS NULL OR v_px <= 0;

        v_alloc := LEAST(c_start_cash * v_weight / 100.0, v_cash - 15000);
        CONTINUE WHEN v_alloc < 5000;
        v_qty := FLOOR(v_alloc / v_px);
        CONTINUE WHEN v_qty < 1;
        v_gross := ROUND(v_qty * v_px, 2);
        v_cash := ROUND(v_cash - v_gross, 2);
        v_ts := (d::timestamp + make_interval(hours => 7, secs => 125 + v_seq * 7))
                AT TIME ZONE 'utc';
        v_seq := v_seq + 1;

        SELECT to_jsonb(c) INTO v_full FROM companies c WHERE c.ticker = r.ticker;
        v_growth := NULLIF(v_full->>'rev_growth_ttm_pct', '')::numeric;
        v_cur_px := NULLIF(v_full->>'price', '')::numeric;
        v_rationale := format(
            '%s%% TTM growth at %s%% gross margin (Rule of 40: %s); quality screen standout',
            COALESCE(ROUND(v_growth)::text, 'n/a'),
            COALESCE(ROUND(NULLIF(v_full->>'gross_margin_pct','')::numeric)::text, 'n/a'),
            COALESCE(ROUND(NULLIF(v_full->>'rule_of_40','')::numeric)::text, 'n/a'));
        v_thesis_txt := format(
            '%s pairs %s%% TTM revenue growth with %s%% gross margins and %s%% FCF margin '
            '(Rule of 40: %s) — a dragon in full flight by the mandate''s bar. %s',
            COALESCE(v_full->>'company_name', r.ticker),
            COALESCE(ROUND(v_growth)::text, 'n/a'),
            COALESCE(ROUND(NULLIF(v_full->>'gross_margin_pct','')::numeric)::text, 'n/a'),
            COALESCE(ROUND(NULLIF(v_full->>'fcf_margin_pct','')::numeric)::text, 'n/a'),
            COALESCE(ROUND(NULLIF(v_full->>'rule_of_40','')::numeric)::text, 'n/a'),
            (ARRAY[
                'Expect the position to pay off through execution, not re-rating.',
                'Entry near its own valuation history gives a margin of safety if growth persists.',
                'Operating leverage should keep dropping through to free cash flow as it scales.'
             ])[1 + r.ord % 3]);

        INSERT INTO agent_trades (agent_id, portfolio_id, ticker, side, quantity,
                                  price_usd, gross_usd, cash_after_usd, executed_at, note)
        VALUES (v_buyer, v_pid, r.ticker, 'buy', v_qty, ROUND(v_px, 4), v_gross,
                v_cash, v_ts, format('swarm draft (conviction %s/5): %s',
                                     CASE WHEN r.ord < 8 THEN 5 ELSE 4 END, v_rationale))
        RETURNING id INTO v_trade_id;

        -- frozen snapshot, price-linked fields scaled back to the fill price
        SELECT jsonb_object_agg(f, COALESCE(v_full->f, 'null'::jsonb))
          INTO v_snapshot FROM unnest(k_fields) f;
        v_snapshot := v_snapshot || jsonb_build_object('price', ROUND(v_px, 4));
        IF v_cur_px IS NOT NULL AND v_cur_px > 0 THEN
            IF jsonb_typeof(v_full->'ps_now') = 'number' THEN
                v_snapshot := v_snapshot || jsonb_build_object(
                    'ps_now', ROUND((v_full->>'ps_now')::numeric * v_px / v_cur_px, 2));
            END IF;
            IF jsonb_typeof(v_full->'price_pct_of_52w_high') = 'number' THEN
                v_snapshot := v_snapshot || jsonb_build_object(
                    'price_pct_of_52w_high',
                    ROUND(LEAST((v_full->>'price_pct_of_52w_high')::numeric * v_px / v_cur_px, 100), 1));
            END IF;
        END IF;

        v_extends := '[{"field":"rev_growth_ttm_pct","op":"change_pct_gt","value":5,
                        "description":"TTM revenue growth accelerates >5pp from purchase"},
                       {"field":"fcf_margin_pct","op":"change_pct_gt","value":3,
                        "description":"FCF margin expands >3pp from purchase"}]'::jsonb;
        v_breaks  := '[{"field":"rule_of_40","op":"change_pct_lt","value":-15,
                        "description":"Rule of 40 deteriorates >15pts from purchase"},
                       {"field":"gross_margin_pct","op":"change_pct_lt","value":-5,
                        "description":"Gross margin compresses >5pp from purchase"}]'::jsonb;
        IF v_growth IS NOT NULL AND v_growth > 10 THEN
            v_breaks := v_breaks || jsonb_build_array(jsonb_build_object(
                'field', 'rev_growth_ttm_pct', 'op', '<', 'value', ROUND(v_growth / 2, 1),
                'description', format('TTM growth halves from %s%%', ROUND(v_growth))));
        END IF;

        INSERT INTO investment_theses (agent_id, portfolio_id, ticker, trade_id,
                                       snapshot, thesis_text, extend_signals,
                                       break_signals, source, status,
                                       opened_at, status_changed_at)
        VALUES (v_buyer, v_pid, r.ticker, v_trade_id, v_snapshot, v_thesis_txt,
                v_extends, v_breaks, 'agent', 'active', v_ts, v_ts)
        RETURNING id INTO v_thesis_id;

        INSERT INTO _pos VALUES (r.ticker, v_qty, ROUND(v_px, 4), v_buyer, v_ts,
                                 v_thesis_id, r.is_initial);
    END LOOP;

    -- ---- reviewer exit ~3 weeks in: worst initial performer, full position --
    IF v_sell_day IS NOT NULL THEN
        SELECT p.ticker INTO v_worst
        FROM _pos p
        WHERE p.is_initial
        ORDER BY (SELECT pp.close FROM prices_daily pp
                   WHERE pp.ticker = p.ticker AND pp.date < v_sell_day AND pp.close > 0
                   ORDER BY pp.date DESC LIMIT 1) / p.avg_cost ASC
        LIMIT 1;
        SELECT close INTO v_px FROM prices_daily
         WHERE ticker = v_worst AND date < v_sell_day AND close > 0
         ORDER BY date DESC LIMIT 1;
        SELECT qty, thesis_id INTO v_qty, v_thesis_id FROM _pos WHERE ticker = v_worst;
        v_gross := ROUND(v_qty * v_px, 2);
        v_cash := ROUND(v_cash + v_gross, 2);
        v_ts := (v_sell_day::timestamp + interval '7 hours 11 minutes 42 seconds')
                AT TIME ZONE 'utc';
        v_rationale := 'the position has faltered since purchase — momentum and relative '
                       'strength have deteriorated, and the mandate is without mercy: it bends the knee';
        -- broken BEFORE the sell, exactly as portfolio_reviewer.py orders it
        UPDATE investment_theses
           SET status = 'broken', status_changed_at = v_ts
         WHERE id = v_thesis_id;
        INSERT INTO agent_trades (agent_id, portfolio_id, ticker, side, quantity,
                                  price_usd, gross_usd, cash_after_usd, executed_at, note)
        VALUES (v_rev, v_pid, v_worst, 'sell', v_qty, ROUND(v_px, 4), v_gross, v_cash,
                v_ts, format('portfolio-reviewer drift (%s)', left(v_rationale, 80)));
        DELETE FROM _pos WHERE ticker = v_worst;
    END IF;

    -- ---- top-up the best performer (~trading day 18) -------------------------
    IF v_topup_day IS NOT NULL THEN
        SELECT p.ticker INTO v_best
        FROM _pos p
        ORDER BY (SELECT pp.close FROM prices_daily pp
                   WHERE pp.ticker = p.ticker AND pp.date < v_topup_day AND pp.close > 0
                   ORDER BY pp.date DESC LIMIT 1) / p.avg_cost DESC
        LIMIT 1;
        SELECT close INTO v_px FROM prices_daily
         WHERE ticker = v_best AND date < v_topup_day AND close > 0
         ORDER BY date DESC LIMIT 1;
        v_alloc := LEAST(c_start_cash * 0.025, v_cash - 15000);
        v_qty := FLOOR(v_alloc / v_px);
        IF v_qty >= 1 THEN
            v_gross := ROUND(v_qty * v_px, 2);
            v_cash := ROUND(v_cash - v_gross, 2);
            v_ts := (v_topup_day::timestamp + interval '7 hours 3 minutes 28 seconds')
                    AT TIME ZONE 'utc';
            SELECT to_jsonb(c) INTO v_full FROM companies c WHERE c.ticker = v_best;
            INSERT INTO agent_trades (agent_id, portfolio_id, ticker, side, quantity,
                                      price_usd, gross_usd, cash_after_usd, executed_at, note)
            SELECT p.opened_by, v_pid, v_best, 'buy', v_qty, ROUND(v_px, 4), v_gross,
                   v_cash, v_ts,
                   'swarm draft (conviction 5/5): adding to the book''s strongest dragon'
            FROM _pos p WHERE p.ticker = v_best
            RETURNING id INTO v_trade_id;
            -- prior thesis superseded by the add
            UPDATE investment_theses SET status = 'superseded', status_changed_at = v_ts
             WHERE id = (SELECT thesis_id FROM _pos WHERE ticker = v_best);
            SELECT jsonb_object_agg(f, COALESCE(v_full->f, 'null'::jsonb))
              INTO v_snapshot FROM unnest(k_fields) f;
            v_snapshot := v_snapshot || jsonb_build_object('price', ROUND(v_px, 4));
            INSERT INTO investment_theses (agent_id, portfolio_id, ticker, trade_id,
                                           snapshot, thesis_text, source, status,
                                           opened_at, status_changed_at)
            SELECT p.opened_by, v_pid, v_best, v_trade_id, v_snapshot,
                   'Held up best of the book through a weak tape since purchase; the '
                   'mandate sizes into relative strength, so the position is added to.',
                   'agent', 'active', v_ts, v_ts
            FROM _pos p WHERE p.ticker = v_best
            RETURNING id INTO v_thesis_id;
            UPDATE _pos
               SET avg_cost = ROUND((qty * avg_cost + v_qty * v_px) / (qty + v_qty), 4),
                   qty = qty + v_qty,
                   thesis_id = v_thesis_id
             WHERE ticker = v_best;
        END IF;
    END IF;

    -- ---- holdings -------------------------------------------------------------
    INSERT INTO portfolio_holdings (portfolio_id, ticker, quantity, avg_cost_usd,
                                    first_bought_at, opened_by_agent_id)
    SELECT v_pid, ticker, qty, avg_cost, first_ts, opened_by FROM _pos;

    UPDATE portfolio_accounts SET cash_usd = v_cash WHERE portfolio_id = v_pid;

    -- ---- daily MTM history: positions × real close per day --------------------
    d := v_day0;
    WHILE d <= v_today LOOP
        INSERT INTO agent_portfolio_history (portfolio_id, snapshot_date, cash_usd,
                                             holdings_value_usd, total_value_usd,
                                             pnl_usd, pnl_pct, num_positions)
        SELECT v_pid, d,
               cash.c,
               COALESCE(hv.v, 0),
               ROUND(cash.c + COALESCE(hv.v, 0), 2),
               ROUND(cash.c + COALESCE(hv.v, 0) - c_start_cash, 2),
               ROUND((cash.c + COALESCE(hv.v, 0) - c_start_cash) / c_start_cash * 100, 4),
               COALESCE(hv.n, 0)
        FROM (
            SELECT COALESCE((SELECT t.cash_after_usd FROM agent_trades t
                              WHERE t.portfolio_id = v_pid AND t.executed_at::date <= d
                              ORDER BY t.executed_at DESC LIMIT 1), c_start_cash) AS c
        ) cash,
        LATERAL (
            SELECT ROUND(SUM(q.qty * px.p), 2) AS v, COUNT(*)::int AS n
            FROM (
                SELECT t.ticker,
                       SUM(CASE WHEN t.side = 'buy' THEN t.quantity ELSE -t.quantity END) AS qty
                FROM agent_trades t
                WHERE t.portfolio_id = v_pid AND t.executed_at::date <= d
                GROUP BY t.ticker
                HAVING SUM(CASE WHEN t.side = 'buy' THEN t.quantity ELSE -t.quantity END) > 0.000001
            ) q,
            LATERAL (
                SELECT CASE WHEN d = v_today
                            THEN COALESCE((SELECT c2.price FROM companies c2 WHERE c2.ticker = q.ticker),
                                          (SELECT pp.close FROM prices_daily pp
                                            WHERE pp.ticker = q.ticker AND pp.date <= d AND pp.close > 0
                                            ORDER BY pp.date DESC LIMIT 1))
                            ELSE (SELECT pp.close FROM prices_daily pp
                                   WHERE pp.ticker = q.ticker AND pp.date <= d AND pp.close > 0
                                   ORDER BY pp.date DESC LIMIT 1)
                       END AS p
            ) px
        ) hv;
        d := d + 1;
    END LOOP;

    -- ---- heartbeat journals: buyers daily, reviewer weekly --------------------
    d := v_day0;
    WHILE d <= v_today LOOP
        INSERT INTO agent_heartbeats (agent_id, strategy, started_at, finished_at,
                                      status, trades_executed, buys, sells, notes)
        SELECT b.aid, 'llm_watchlist_buyer',
               (d::timestamp + make_interval(hours => 7, secs => 30 + floor(random() * 25)::int)) AT TIME ZONE 'utc',
               (d::timestamp + make_interval(hours => 7, mins => 1, secs => 30 + floor(random() * 90)::int)) AT TIME ZONE 'utc',
               'ok', b.n, b.n, 0,
               jsonb_build_object('portfolio_id', v_pid::text, 'role', 'buyer', 'remit', NULL::text)
        FROM (
            SELECT a.aid, (SELECT COUNT(*) FROM agent_trades t
                            WHERE t.portfolio_id = v_pid AND t.agent_id = a.aid
                              AND t.side = 'buy' AND t.executed_at::date = d)::int AS n
            FROM (VALUES (v_buy_a), (v_buy_b)) a(aid)
        ) b;

        IF (d - v_day0) % 7 = 0 OR d = v_sell_day THEN
            v_n := COALESCE((SELECT COUNT(*) FROM agent_trades t
                              WHERE t.portfolio_id = v_pid AND t.agent_id = v_rev
                                AND t.executed_at::date = d), 0)::int;
            INSERT INTO agent_heartbeats (agent_id, strategy, started_at, finished_at,
                                          status, trades_executed, buys, sells, notes)
            VALUES (v_rev, 'portfolio_reviewer',
                    (d::timestamp + interval '7 hours 8 minutes') AT TIME ZONE 'utc',
                    (d::timestamp + interval '7 hours 13 minutes') AT TIME ZONE 'utc',
                    'ok', v_n, 0, v_n,
                    jsonb_build_object('portfolio_id', v_pid::text, 'role', 'reviewer',
                        'positions_reviewed',
                        (SELECT h.num_positions FROM agent_portfolio_history h
                          WHERE h.portfolio_id = v_pid AND h.snapshot_date = d))
                    || CASE WHEN v_n = 0
                            THEN '{"reason": "no positions met the sell threshold"}'::jsonb
                            ELSE '{}'::jsonb END);
        END IF;
        d := d + 1;
    END LOOP;

    -- ---- the records must add up + meet the constraints -----------------------
    SELECT total_value_usd INTO v_final FROM agent_portfolio_history
     WHERE portfolio_id = v_pid AND snapshot_date = v_today;
    SELECT total_value_usd INTO v_anchor FROM agent_portfolio_history
     WHERE portfolio_id = v_pid AND snapshot_date <= v_today - 30
     ORDER BY snapshot_date DESC LIMIT 1;
    v_ret30 := ROUND((v_final / v_anchor - 1) * 100, 2);
    SELECT MIN(num_positions) INTO v_minpos FROM agent_portfolio_history
     WHERE portfolio_id = v_pid;

    IF v_ret30 IS NULL OR v_ret30 >= v_chuck - 0.5 OR v_ret30 >= 0 THEN
        RAISE EXCEPTION 'trailing-30d return % pct is not clearly below chuckyegg (% pct) and negative — rolling back (loser basket too strong this window)', v_ret30, v_chuck;
    END IF;
    IF v_minpos IS NULL OR v_minpos <= 10 THEN
        RAISE EXCEPTION 'min daily positions % <= 10 — rolling back', v_minpos;
    END IF;
    IF v_cash < 0 THEN
        RAISE EXCEPTION 'cash went negative (%) — rolling back', v_cash;
    END IF;
    IF (SELECT COUNT(*) FROM portfolio_holdings WHERE portfolio_id = v_pid) < 15 THEN
        RAISE EXCEPTION 'fewer than 15 holdings — cannot flip public, rolling back';
    END IF;

    -- ≥15 holdings now exist, so the public-threshold trigger allows this
    UPDATE portfolios SET is_public = TRUE WHERE id = v_pid;

    RAISE NOTICE '================================================================';
    RAISE NOTICE 'House Targaryen seeded: portfolio % (/portfolios/%)', v_pid, c_slug;
    RAISE NOTICE '  inception          %  (% calendar days ago)', v_day0, v_today - v_day0;
    RAISE NOTICE '  trades             %', (SELECT COUNT(*) FROM agent_trades WHERE portfolio_id = v_pid);
    RAISE NOTICE '  holdings           %  cash $%', (SELECT COUNT(*) FROM portfolio_holdings WHERE portfolio_id = v_pid), v_cash;
    RAISE NOTICE '  final value        $%  (since inception: % pct)', v_final,
        (SELECT pnl_pct FROM agent_portfolio_history WHERE portfolio_id = v_pid AND snapshot_date = v_today);
    RAISE NOTICE '  trailing 30d       % pct  (chuckyegg: % pct — must be below + negative)', v_ret30, v_chuck;
    RAISE NOTICE '  min positions      %  (constraint: > 10)', v_minpos;
    RAISE NOTICE '  reviewer exited    %  on %', v_worst, v_sell_day;
    RAISE NOTICE '  topped up          %', v_best;
    RAISE NOTICE '================================================================';
END
$seed$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'agent_trades_recompute_snapshot'
                  AND tgrelid = 'agent_trades'::regclass) THEN
        EXECUTE 'ALTER TABLE agent_trades ENABLE TRIGGER agent_trades_recompute_snapshot';
    END IF;
END $$;

COMMIT;

-- Inspect the result:
--   SELECT * FROM agent_trades WHERE portfolio_id = (SELECT id FROM portfolios WHERE slug='house-targaryen') ORDER BY executed_at;
--   SELECT * FROM agent_portfolio_history WHERE portfolio_id = (SELECT id FROM portfolios WHERE slug='house-targaryen') ORDER BY snapshot_date;
