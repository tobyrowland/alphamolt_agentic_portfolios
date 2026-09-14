"""The weekly review email — a model's critique of each owner's book, on a schedule.

What can go wrong here is mostly about WHO gets it and WHAT it is fed, not
the prose: a live (real-money) book reviewed by a chatbot, a user emailed
twice in one week because a rerun forgot the ledger, an opted-out user
emailed anyway, a week-on-week return that counts a deposit as a gain. The
pure parts are pinned here; the prompt is pinned to the pack it consumes.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import unittest
from datetime import date, datetime, timezone
from unittest import mock

import weekly_review_emails as w
from llm_providers import LLMProviderError, LLMResponse

ROOT = pathlib.Path(__file__).resolve().parents[1]

KEY = "weekly_review_2026-W38"


def profile(uid, email="a@b.com", **extra):
    return {"id": uid, "email": email, "display_name": "Ada Lovelace", **extra}


def book(pid, owner, mode="paper", created="2026-08-01", slug=None):
    return {
        "id": pid, "slug": slug or pid, "display_name": pid.upper(),
        "owner_user_id": owner, "mode": mode, "created_at": created,
    }


class WeekKeyTests(unittest.TestCase):
    def test_iso_week_of_the_run(self):
        self.assertEqual(w.week_key(datetime(2026, 9, 14, 8, tzinfo=timezone.utc)), KEY)

    def test_iso_year_not_calendar_year_at_the_boundary(self):
        """3 Jan 2027 is a Sunday in ISO week 53 of 2026. A calendar-year key
        would let a Monday rerun on 4 Jan send the same review twice."""
        self.assertEqual(
            w.week_key(datetime(2027, 1, 3, tzinfo=timezone.utc)), "weekly_review_2026-W53"
        )

    def test_tuesday_rerun_shares_mondays_key(self):
        mon = w.week_key(datetime(2026, 9, 14, tzinfo=timezone.utc))
        tue = w.week_key(datetime(2026, 9, 15, tzinfo=timezone.utc))
        self.assertEqual(mon, tue)


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
            {("u1", "weekly_review_2026-W37")}, KEY,
        )
        self.assertEqual(len(plan), 1)

    def test_opted_out_user_is_skipped_for_good(self):
        plan = w.plan_sends(
            [profile("u1", weekly_review_emails=False)], [book("p1", "u1")], {"p1": 3},
            set(), KEY,
        )
        self.assertEqual(plan, [])

    def test_pre_migration_profile_without_the_flag_is_opted_in(self):
        """Fail-soft on a schema without migration 092: a missing key is not
        an opt-out."""
        plan = w.plan_sends([profile("u1")], [book("p1", "u1")], {"p1": 3}, set(), KEY)
        self.assertEqual(len(plan), 1)

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


class WeekNumbersTests(unittest.TestCase):
    def test_uses_the_time_weighted_index_so_a_deposit_is_not_a_gain(self):
        snaps = [
            {"snapshot_date": "2026-09-07", "total_value_usd": 10000, "twr_index": 1.05},
            {"snapshot_date": "2026-09-13", "total_value_usd": 15000, "twr_index": 1.05},
        ]
        self.assertAlmostEqual(w.window_change_pct(snaps), 0.0)

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

    def test_week_line_reads_as_one_sentence(self):
        line = w.week_line(1037823.93, -1.24, 0.8, 3.78, 16)
        self.assertEqual(
            line,
            "Value $1,037,824. 16 positions. -1.2% on the week (S&P 500 +0.8%). "
            "+3.8% since inception.",
        )
        self.assertEqual(w.week_line(None, None, None, None, None), "")
        self.assertIn("1 position.", w.week_line(None, None, None, None, 1))


REVIEWS = [
    {
        "name": "Scrappy Fightback!",
        "slug": "portfolio-2",
        "review": "PODD is the weak spot.\n\nThe mandate says <fallen> leaders & the book agrees.",
        "week_line": "Value $1,037,824. -1.2% on the week.",
    }
]


class EmailTests(unittest.TestCase):
    def test_text_carries_name_link_numbers_review_and_provenance(self):
        text = w.email_text("Ada", REVIEWS, "gemini-3.1-pro-preview")
        self.assertIn("Hi Ada —", text)
        self.assertIn("Scrappy Fightback! — https://www.alphamolt.ai/portfolios/portfolio-2", text)
        self.assertIn("Value $1,037,824. -1.2% on the week.", text)
        self.assertIn("PODD is the weak spot.", text)
        self.assertIn("written by gemini-3.1-pro-preview", text)
        self.assertIn("Copy for AI review", text)
        self.assertIn("nothing here is advice about real money", text)
        self.assertIn('Reply "no more reviews"', text)
        self.assertTrue(text.rstrip().endswith("stop these."))

    def test_html_escapes_the_models_prose(self):
        body = w.email_html("Ada", REVIEWS, "gemini-3.1-pro-preview")
        self.assertIn("&lt;fallen&gt; leaders &amp; the book", body)
        self.assertNotIn("<fallen>", body)
        self.assertIn('href="https://www.alphamolt.ai/portfolios/portfolio-2"', body)
        self.assertEqual(body.count("<p>PODD is the weak spot.</p>"), 1)

    def test_no_name_still_greets(self):
        self.assertTrue(w.email_text(None, REVIEWS, "m").startswith("Hi —"))
        self.assertTrue(w.email_html(None, REVIEWS, "m").startswith("<p>Hi &mdash;</p>"))

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

    def test_prompt_asks_for_the_body_only_and_never_real_money_advice(self):
        for phrase in ("no greeting", "no sign-off", "never give advice about real money",
                       "closing marks", "weakest thesis", "match the mandate"):
            self.assertIn(phrase, w.REVIEW_SYSTEM)


class WriteReviewTests(unittest.TestCase):
    CFG = {"provider": "google", "model": "m", "fallback_model": "f", "thinking_level": "medium"}

    def test_returns_text_and_the_model_that_actually_answered(self):
        long = "x" * 300
        with mock.patch.object(
            w, "call_llm", return_value=LLMResponse(text=f"  {long} ", model="f", provider="google")
        ) as m:
            text, model = w.write_review("pack", date(2026, 9, 13), self.CFG)
        self.assertEqual((text, model), (long, "f"))
        kwargs = m.call_args.kwargs
        self.assertEqual(kwargs["system"], w.REVIEW_SYSTEM)
        self.assertEqual(kwargs["fallback_model"], "f")
        self.assertEqual(kwargs["thinking_level"], "medium")
        self.assertIn("pack", kwargs["user"])

    def test_a_stub_answer_is_an_error_not_an_email(self):
        with mock.patch.object(
            w, "call_llm", return_value=LLMResponse(text="Looks fine.", model="m", provider="google")
        ):
            with self.assertRaises(LLMProviderError):
                w.write_review("pack", date(2026, 9, 13), self.CFG)

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


class RendererTests(unittest.TestCase):
    def test_renderer_output_is_keyed_by_slug_and_fails_per_book(self):
        out = w.parse_render_output('{"a": {"markdown": "# A"}, "b": {"error": "boom"}}',
                                    ["a", "b", "c"])
        self.assertEqual(out["a"], {"markdown": "# A"})
        self.assertEqual(out["b"], {"error": "boom"})
        self.assertIn("error", out["c"])
        out = w.parse_render_output("not json", ["a"])
        self.assertIn("unparseable", out["a"]["error"])

    def test_renderer_builds_the_same_pack_as_the_button(self):
        """The email must be fed the document the page's button produces —
        the same builder over the same query — not a re-derivation."""
        src = pathlib.Path(w.RENDERER).read_text()
        self.assertTrue(pathlib.Path(w.RENDERER).exists())
        for module in ("portfolios-query.ts", "portfolio-export-query.ts", "portfolio-export.ts"):
            self.assertIn(module, src)
        self.assertIn("buildPortfolioExport", src)
        self.assertIn("getPortfolioExportData", src)

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
        self.assertIn('cron: "0 8 * * 1"', wf)


if __name__ == "__main__":
    unittest.main()
