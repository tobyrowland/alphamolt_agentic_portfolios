"""The weekly review email — a model's critique of each owner's book, on a schedule.

What can go wrong here is mostly about WHO gets it and WHAT it is fed, not
the prose: a live (real-money) book reviewed by a chatbot, a user emailed
twice in one week because a rerun forgot the ledger, an opted-out user
emailed anyway, a week-on-week return that counts a deposit as a gain, a
chart that draws a deposit as a jump. The pure parts are pinned here; the
prompt is pinned to the pack it consumes.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import unittest
from datetime import date
from unittest import mock

import weekly_review_emails as w
from llm_providers import LLMProviderError, LLMResponse

ROOT = pathlib.Path(__file__).resolve().parents[1]

KEY = "weekly_review_2026-W37"  # the week ending Sunday 13 Sep 2026


def profile(uid, email="a@b.com", opted_in=True, **extra):
    return {"id": uid, "email": email, "display_name": "Ada Lovelace",
            "weekly_review_emails": opted_in, **extra}


def book(pid, owner, mode="paper", created="2026-08-01", slug=None):
    return {
        "id": pid, "slug": slug or pid, "display_name": pid.upper(),
        "owner_user_id": owner, "mode": mode, "created_at": created,
    }


class WeekTests(unittest.TestCase):
    def test_the_week_ends_on_the_most_recent_sunday_today_included(self):
        sunday = date(2026, 9, 13)
        self.assertEqual(w.last_sunday(sunday), sunday)             # the send day
        self.assertEqual(w.last_sunday(date(2026, 9, 14)), sunday)  # a Monday rerun
        self.assertEqual(w.last_sunday(date(2026, 9, 19)), sunday)  # Saturday, still
        self.assertEqual(w.last_sunday(date(2026, 9, 20)), date(2026, 9, 20))

    def test_key_is_the_reviewed_weeks_iso_week(self):
        self.assertEqual(w.week_key(date(2026, 9, 13)), KEY)

    def test_monday_rerun_shares_sundays_key(self):
        """Sunday is the LAST day of its ISO week and Monday the first of the
        next. A key taken from the run date would let a Monday recovery run
        email everyone a second copy; keyed on the reviewed week it cannot."""
        sunday_run = w.week_key(w.last_sunday(date(2026, 9, 13)))
        monday_run = w.week_key(w.last_sunday(date(2026, 9, 14)))
        self.assertEqual(sunday_run, monday_run)
        self.assertNotEqual(sunday_run, w.week_key(w.last_sunday(date(2026, 9, 20))))

    def test_iso_year_not_calendar_year_at_the_boundary(self):
        """The week ending Sunday 3 Jan 2027 is ISO week 53 of 2026."""
        self.assertEqual(w.week_key(date(2027, 1, 3)), "weekly_review_2026-W53")


class PlanTests(unittest.TestCase):
    def test_owner_of_a_paper_book_with_positions_is_due(self):
        plan = w.plan_sends([profile("u1")], [book("p1", "u1")], {"p1": 12}, set(), KEY)
        self.assertEqual([(p["id"], [b["id"] for b in bs]) for p, bs in plan], [("u1", ["p1"])])

    def test_live_book_is_never_reviewed(self):
        """A live follower holds no decisions of its own and is real money —
        the one book the email must never discuss."""
        plan = w.plan_sends(
            [profile("u1")], [book("p1", "u1", mode="live")], {"p1": 12}, set(), KEY
        )
        self.assertEqual(plan, [])

    def test_empty_book_has_nothing_to_review(self):
        plan = w.plan_sends([profile("u1")], [book("p1", "u1")], {}, set(), KEY)
        self.assertEqual(plan, [])

    def test_already_sent_this_week_is_skipped(self):
        plan = w.plan_sends(
            [profile("u1")], [book("p1", "u1")], {"p1": 3}, {("u1", KEY)}, KEY
        )
        self.assertEqual(plan, [])

    def test_last_weeks_send_does_not_block_this_week(self):
        plan = w.plan_sends(
            [profile("u1")], [book("p1", "u1")], {"p1": 3},
            {("u1", "weekly_review_2026-W36")}, KEY,
        )
        self.assertEqual(len(plan), 1)

    def test_only_an_opted_in_user_is_due(self):
        """Opt-in, not opt-out: False is not consent and neither is a missing
        flag (a pre-092 row) — nothing but True sends."""
        for flag in (False, None):
            plan = w.plan_sends(
                [profile("u1", opted_in=flag)], [book("p1", "u1")], {"p1": 3}, set(), KEY,
            )
            self.assertEqual(plan, [], f"flag={flag!r}")
        missing = {k: v for k, v in profile("u1").items() if k != "weekly_review_emails"}
        self.assertEqual(w.plan_sends([missing], [book("p1", "u1")], {"p1": 3}, set(), KEY), [])

    def test_profile_without_email_is_skipped(self):
        plan = w.plan_sends(
            [profile("u1", email=None)], [book("p1", "u1")], {"p1": 3}, set(), KEY
        )
        self.assertEqual(plan, [])

    def test_one_email_covering_every_book_oldest_first(self):
        books = [
            book("p2", "u1", created="2026-09-01"),
            book("p1", "u1", created="2026-07-20"),
            book("p3", "u1", created="2026-08-10"),  # empty — left out
        ]
        plan = w.plan_sends([profile("u1")], books, {"p1": 10, "p2": 4}, set(), KEY)
        self.assertEqual(len(plan), 1)
        self.assertEqual([b["id"] for b in plan[0][1]], ["p1", "p2"])

    def test_someone_elses_book_is_not_yours(self):
        plan = w.plan_sends([profile("u1")], [book("p1", "u2")], {"p1": 3}, set(), KEY)
        self.assertEqual(plan, [])


SNAPS = [
    {"snapshot_date": "2026-09-07", "total_value_usd": 10000, "twr_index": 1.05},
    {"snapshot_date": "2026-09-13", "total_value_usd": 15000, "twr_index": 1.05},
]


class WeekNumbersTests(unittest.TestCase):
    def test_uses_the_time_weighted_index_so_a_deposit_is_not_a_gain(self):
        self.assertAlmostEqual(w.window_change_pct(SNAPS), 0.0)

    def test_falls_back_to_value_ratio_without_an_index(self):
        snaps = [
            {"snapshot_date": "2026-09-13", "total_value_usd": 1030000},
            {"snapshot_date": "2026-09-07", "total_value_usd": 1000000},
        ]
        self.assertAlmostEqual(w.window_change_pct(snaps), 3.0)

    def test_one_snapshot_is_not_a_week(self):
        self.assertIsNone(w.window_change_pct([{"snapshot_date": "2026-09-13",
                                                "total_value_usd": 1}]))

    def test_benchmark_uses_last_close_on_or_before_each_end(self):
        """A Monday email asks about Sunday and the Sunday before — both
        answered by the Friday close."""
        spy = {"2026-09-04": 100.0, "2026-09-08": 101.0, "2026-09-11": 104.0}
        self.assertAlmostEqual(
            w.series_change_pct(spy, date(2026, 9, 6), date(2026, 9, 13)), 4.0
        )
        self.assertIsNone(w.series_change_pct(spy, date(2026, 9, 1), date(2026, 9, 13)))

    def test_stats_line_reads_as_one_line(self):
        line = w.stats_line({"total_value": 1037823.93, "week_pct": -1.24, "spy_pct": 0.8,
                             "since_pct": 3.78, "holdings": 16})
        self.assertEqual(
            line, "$1,037,824 · -1.2% this week (S&P 500 +0.8%) · +3.8% since inception · "
                  "16 positions",
        )
        self.assertEqual(w.stats_line({}), "")
        self.assertEqual(w.stats_line({"holdings": 1}), "1 position")


class ChartSeriesTests(unittest.TestCase):
    def test_chart_line_uses_the_index_so_a_deposit_is_flat(self):
        """Same $10k → $15k book, index flat: the chart draws a flat line."""
        pts = w.rebased_points(SNAPS)
        self.assertEqual([round(v, 6) for _, v in pts], [100.0, 100.0])

    def test_chart_line_falls_back_to_value_when_the_index_backfill_lags(self):
        """The real Scrappy book: twr_index NULL before 2 Sep. One missing
        row means the whole line is drawn from value, never a mix."""
        snaps = [
            {"snapshot_date": "2026-09-01", "total_value_usd": 1000, "twr_index": None},
            {"snapshot_date": "2026-09-02", "total_value_usd": 1100, "twr_index": 1.0},
            {"snapshot_date": "2026-09-03", "total_value_usd": 1210, "twr_index": 1.1},
        ]
        self.assertEqual([round(v, 6) for _, v in w.rebased_points(snaps)],
                         [100.0, 110.0, 121.0])

    def test_benchmark_points_are_windowed_and_rebased(self):
        spy = {"2026-08-01": 50.0, "2026-09-01": 100.0, "2026-09-05": 110.0, "2026-10-01": 1.0}
        pts = w.series_points(spy, date(2026, 8, 20), date(2026, 9, 13))
        self.assertEqual([(d, round(v, 6)) for d, v in pts],
                         [("2026-09-01", 100.0), ("2026-09-05", 110.0)])

    def test_chart_is_a_png_or_nothing(self):
        try:
            import matplotlib  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("matplotlib not installed")
        png = w.render_chart_png(
            [("2026-09-01", 100.0), ("2026-09-08", 97.0), ("2026-09-13", 95.0)],
            [("2026-09-01", 100.0), ("2026-09-13", 99.2)], "Scrappy Fightback!",
        )
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertIsNone(w.render_chart_png([("2026-09-13", 100.0)], [], "one point"))

    def test_attachment_carries_the_cid_the_html_references(self):
        review = {"slug": "Portfolio 2", "chart": {"cid": w.chart_cid("Portfolio 2"),
                                                     "png": b"\x89PNGfake"}}
        att = w.chart_attachment(review)
        self.assertEqual(att["content_id"], "chart-portfolio-2")
        self.assertEqual(att["content_type"], "image/png")
        self.assertEqual(att["filename"], "Portfolio 2-30d.png")
        self.assertIsNone(w.chart_attachment({"slug": "x", "chart": None}))


class TradesTests(unittest.TestCase):
    TAPE = [
        {"executedAt": "2026-09-11", "ticker": "BSY", "side": "sell", "quantity": 1835,
         "price": 31.0, "agent": "Sector Rebalancer", "realisedUsd": -8147.4},
        {"executedAt": "2026-09-11", "ticker": "SE", "side": "buy", "quantity": 136,
         "price": 107.69, "agent": "Double-Down Buyer"},
        {"executedAt": "2026-09-06", "ticker": "OLD", "side": "buy", "quantity": 1,
         "price": 1.0, "agent": None},
        {"executedAt": "2026-09-09T10:00:00Z", "ticker": "MID", "side": "buy", "quantity": 2,
         "price": 2.0, "agent": "Buyer · Gemini"},
    ]

    def test_only_the_weeks_rows_oldest_first(self):
        rows = w.week_trades(self.TAPE, date(2026, 9, 7), date(2026, 9, 13))
        self.assertEqual([t["ticker"] for t in rows], ["MID", "BSY", "SE"])

    def test_text_line_shows_realised_on_sells_only(self):
        self.assertEqual(
            w._trade_line(self.TAPE[0]),
            "2026-09-11  SELL BSY    1,835 @ $31.00  realised -$8,147  (Sector Rebalancer)",
        )
        self.assertNotIn("realised", w._trade_line(self.TAPE[1]))


REVIEW = {
    "headline": "The book is drifting from turnarounds to compounders.",
    "paragraphs": ["MELI & SE are not <fallen> names.", "The daily buyer averages down."],
    "recommendations": [
        {"action": "Add a 30% drawdown floor to the screen", "why": "So fallen means fallen."},
        {"action": "Sell FNF by hand", "why": "Its $45 stop is firing."},
    ],
}
REVIEWS = [{
    "name": "Scrappy Fightback!", "slug": "portfolio-2",
    "stats": {"total_value": 985462.12, "week_pct": -4.69, "spy_pct": -0.77,
              "since_pct": -1.5, "holdings": 14},
    "chart": {"cid": "chart-portfolio-2", "png": b"\x89PNGfake"},
    "trades": TradesTests.TAPE[:2],
    "review": REVIEW,
}]


class EmailTests(unittest.TestCase):
    def test_text_carries_every_section(self):
        text = w.email_text("Ada", REVIEWS, "gemini-3.1-pro-preview")
        self.assertTrue(text.startswith("Hi Ada —\n\nToby here with your weekly review. Every Sunday"))
        self.assertIn("Scrappy Fightback! — https://www.alphamolt.ai/portfolios/portfolio-2", text)
        self.assertIn("$985,462 · -4.7% this week (S&P 500 -0.8%) · -1.5% since inception · "
                      "14 positions", text)
        self.assertIn("This week's trades\n2026-09-11  SELL BSY", text)
        self.assertIn("The review\nThe book is drifting", text)
        self.assertIn("What I'd change\n1. Add a 30% drawdown floor to the screen — So fallen "
                      "means fallen.\n2. Sell FNF by hand — Its $45 stop is firing.", text)
        self.assertIn("The reviewer was gemini-3.1-pro-preview", text)
        self.assertIn("Copy for AI review", text)
        self.assertIn("nothing here is advice about real money", text)
        self.assertIn('Reply "no more reviews"', text)

    def test_html_references_the_chart_by_cid_and_escapes_prose(self):
        body = w.email_html("Ada", REVIEWS, "m")
        self.assertIn("<p>Toby here with your weekly review.", body)
        self.assertIn(">The review</p>", body)
        self.assertIn('<img src="cid:chart-portfolio-2"', body)
        self.assertNotIn("data:image/png", body)
        self.assertIn("MELI &amp; SE are not &lt;fallen&gt; names.", body)
        self.assertIn("<ol", body)
        self.assertIn("<strong>Add a 30% drawdown floor to the screen</strong>", body)
        self.assertIn("<strong>BSY</strong>", body)
        self.assertIn("-$8,147", body)

    def test_preview_inlines_the_chart_as_a_data_uri(self):
        body = w.email_html("Ada", REVIEWS, "m", inline_charts=True)
        self.assertIn('<img src="data:image/png;base64,', body)
        self.assertNotIn("cid:", body)

    def test_no_chart_and_no_trades_still_render(self):
        r = [{**REVIEWS[0], "chart": None, "trades": []}]
        body = w.email_html(None, r, "m")
        self.assertNotIn("<img", body)
        self.assertIn("None.", body)
        self.assertTrue(w.email_text(None, r, "m").startswith("Hi —"))
        self.assertIn("This week's trades\nNone.", w.email_text(None, r, "m"))

    def test_subject_names_the_book_or_counts_them(self):
        self.assertEqual(w.email_subject(REVIEWS), "this week's review of Scrappy Fightback!")
        self.assertEqual(
            w.email_subject(REVIEWS + [{**REVIEWS[0], "name": "Other"}]),
            "this week's review of your 2 portfolios",
        )


class PromptTests(unittest.TestCase):
    def test_user_prompt_names_the_week_and_carries_the_whole_pack(self):
        pack = "# Book — portfolio review pack\n\n## Positions\n..."
        prompt = w.review_user_prompt(pack, date(2026, 9, 13))
        self.assertIn("Week under review: 2026-09-07 to 2026-09-13.", prompt)
        self.assertTrue(prompt.endswith(pack))

    def test_prompt_refers_to_sections_the_pack_actually_emits(self):
        """The system prompt tells the model to skip the pack's already-fixed
        section by name. If the pack renames it, the instruction goes stale
        silently — so pin the name against the TypeScript that emits it."""
        ts = (ROOT / "web" / "lib" / "portfolio-export.ts").read_text()
        self.assertIn('"## What has already been fixed"', ts)
        self.assertIn('"What has already been fixed"', w.REVIEW_SYSTEM)
        self.assertIn('"## Questions worth asking a reviewer"', ts)

    def test_prompt_asks_for_the_shape_the_renderer_expects(self):
        for phrase in ('"headline"', '"paragraphs"', '"recommendations"', '"action"', '"why"',
                       "exactly two", "two to four", "never give advice about real money",
                       "closing marks", "weakest thesis", "match the mandate",
                       "do not restate those"):
            self.assertIn(phrase, w.REVIEW_SYSTEM)


class WriteReviewTests(unittest.TestCase):
    CFG = {"provider": "google", "model": "m", "fallback_model": "f", "thinking_level": "medium"}

    def _resp(self, payload, model="f"):
        return LLMResponse(text=payload, model=model, provider="google")

    def test_returns_the_parsed_review_and_the_model_that_answered(self):
        with mock.patch.object(w, "call_llm", return_value=self._resp(
            "```json\n" + json.dumps(REVIEW) + "\n```"
        )) as m:
            review, model = w.write_review("pack", date(2026, 9, 13), self.CFG)
        self.assertEqual(model, "f")
        self.assertEqual(review["headline"], REVIEW["headline"])
        self.assertEqual(len(review["recommendations"]), 2)
        kwargs = m.call_args.kwargs
        self.assertEqual(kwargs["system"], w.REVIEW_SYSTEM)
        self.assertEqual(kwargs["fallback_model"], "f")
        self.assertEqual(kwargs["thinking_level"], "medium")
        self.assertIn("pack", kwargs["user"])

    def test_wrong_shape_is_an_error_not_an_email(self):
        bad = [
            "Looks fine.",                                              # not JSON
            json.dumps({"headline": "x", "paragraphs": ["a"], "recommendations": []}),
            json.dumps({"headline": "", "paragraphs": ["a"],
                        "recommendations": [{"action": "a", "why": "b"}] * 2}),
            json.dumps({"headline": "x", "paragraphs": [],
                        "recommendations": [{"action": "a", "why": "b"}] * 2}),
            json.dumps({"headline": "x", "paragraphs": ["a"],
                        "recommendations": [{"action": "a", "why": "b"}] * 5}),
            json.dumps({"headline": "x", "paragraphs": ["a"],
                        "recommendations": [{"action": "a"}, {"why": "b"}]}),
        ]
        for payload in bad:
            with mock.patch.object(w, "call_llm", return_value=self._resp(payload)):
                with self.assertRaises(LLMProviderError, msg=payload):
                    w.write_review("pack", date(2026, 9, 13), self.CFG)

    def test_action_loses_its_trailing_full_stop(self):
        review = w.parse_review(json.dumps({**REVIEW, "recommendations": [
            {"action": "Sell FNF by hand.", "why": "w"}, {"action": "b", "why": "w"}]}))
        self.assertEqual(review["recommendations"][0]["action"], "Sell FNF by hand")

    def test_a_runaway_pack_is_refused_before_it_is_sent(self):
        with mock.patch.object(w, "call_llm") as m:
            with self.assertRaises(LLMProviderError):
                w.write_review("x" * (w.MAX_PACK_CHARS + 1), date(2026, 9, 13), self.CFG)
        m.assert_not_called()

    def test_reviewer_config_defaults_and_overrides(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            cfg = w.reviewer_config()
        self.assertEqual(cfg["provider"], "google")
        self.assertEqual(cfg["model"], "gemini-3.1-pro-preview")
        self.assertEqual(cfg["fallback_model"], "gemini-2.5-pro")
        with mock.patch.dict(os.environ, {"REVIEW_EMAIL_LLM_PROVIDER": "anthropic",
                                          "REVIEW_EMAIL_LLM_MODEL": "claude-opus-4-8",
                                          "REVIEW_EMAIL_LLM_FALLBACK": ""}):
            cfg = w.reviewer_config()
        self.assertEqual((cfg["provider"], cfg["model"], cfg["fallback_model"]),
                         ("anthropic", "claude-opus-4-8", None))


class BuildReviewTests(unittest.TestCase):
    def test_assembles_stats_trades_and_chart_from_the_pack_and_history(self):
        snaps = [{"snapshot_date": f"2026-09-{d:02d}", "total_value_usd": v, "twr_index": None}
                 for d, v in [(1, 1000.0), (6, 1010.0), (9, 990.0), (13, 960.0)]]
        spy = {"2026-09-04": 100.0, "2026-09-11": 102.0}
        pack = {"markdown": "#", "totalValue": 960.0, "returnPct": -4.0, "holdings": 3,
                "trades": TradesTests.TAPE}
        with mock.patch.object(w, "write_review", return_value=(REVIEW, "m")), \
             mock.patch.object(w, "render_chart_png", return_value=b"\x89PNGfake") as chart:
            r, model = w.build_review({"slug": "p1", "display_name": "P1"}, pack, snaps, spy,
                                      date(2026, 9, 13), {})
        self.assertEqual(model, "m")
        self.assertEqual(r["name"], "P1")
        self.assertAlmostEqual(r["stats"]["week_pct"], (960 / 1010 - 1) * 100)
        self.assertAlmostEqual(r["stats"]["spy_pct"], 2.0)
        self.assertEqual(r["stats"]["holdings"], 3)
        self.assertEqual([t["ticker"] for t in r["trades"]], ["MID", "BSY", "SE"])
        self.assertEqual(r["chart"]["cid"], "chart-p1")
        portfolio_pts, spy_pts, name = chart.call_args.args
        self.assertEqual(len(portfolio_pts), 4)
        self.assertEqual(portfolio_pts[0][1], 100.0)
        self.assertEqual(name, "P1")


class RendererTests(unittest.TestCase):
    def test_renderer_output_is_keyed_by_slug_and_fails_per_book(self):
        out = w.parse_render_output('{"a": {"markdown": "# A"}, "b": {"error": "boom"}}',
                                    ["a", "b", "c"])
        self.assertEqual(out["a"], {"markdown": "# A"})
        self.assertEqual(out["b"], {"error": "boom"})
        self.assertIn("error", out["c"])
        out = w.parse_render_output("not json", ["a"])
        self.assertIn("unparseable", out["a"]["error"])

    def test_renderer_builds_the_same_pack_as_the_button_and_hands_over_the_tape(self):
        """The email must be fed the document the page's button produces —
        the same builder over the same query — not a re-derivation; and the
        trade table must come from the pack's own rows."""
        src = pathlib.Path(w.RENDERER).read_text()
        for module in ("portfolios-query.ts", "portfolio-export-query.ts", "portfolio-export.ts"):
            self.assertIn(module, src)
        self.assertIn("buildPortfolioExport", src)
        self.assertIn("getPortfolioExportData", src)
        self.assertIn("trades: data.trades", src)

    def test_renderer_refuses_to_run_without_a_slug(self):
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node not available")
        proc = subprocess.run(
            [node, "--experimental-strip-types", w.RENDERER],
            capture_output=True, text=True, cwd=ROOT,
        )
        if "--experimental-strip-types" in proc.stderr and proc.returncode != 2:
            raise unittest.SkipTest("node cannot strip types")
        self.assertEqual(proc.returncode, 2)

    def test_workflow_installs_node_and_the_web_runtime_deps(self):
        wf = (ROOT / ".github" / "workflows" / "weekly-review-emails.yml").read_text()
        self.assertIn("actions/setup-node", wf)
        self.assertIn('node-version: "22"', wf)
        self.assertIn("npm ci --omit=dev", wf)
        self.assertIn("python weekly_review_emails.py", wf)
        self.assertIn('cron: "0 22 * * 0"', wf)

    def test_workflow_can_switch_a_user_on_from_the_actions_page(self):
        """The operator's opt-in needs the service key, which only the runner
        has — so the switch must be reachable without a terminal."""
        wf = (ROOT / ".github" / "workflows" / "weekly-review-emails.yml").read_text()
        self.assertIn("opt_in:", wf)
        self.assertIn("opt_out:", wf)
        self.assertIn('python weekly_review_emails.py --opt-in "$e"', wf)
        self.assertIn('python weekly_review_emails.py --opt-out "$e"', wf)


if __name__ == "__main__":
    unittest.main()
