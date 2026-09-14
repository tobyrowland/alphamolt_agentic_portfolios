"""The lifecycle emails' planners — who gets which step, and never twice.

Only the A3 review invite is pinned here so far; it is the half of the weekly
review's double opt-in that the sender does not own, so its eligibility rule
(has positions, not yet invited, not already opted in, old enough, not
getting another step this run) is worth a test of its own.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

import lifecycle_emails as l

NOW = datetime(2026, 9, 14, 12, tzinfo=timezone.utc)


def cand(uid, days_old=10, opted_in=False, book="sonofchucky", email="a@b.com"):
    return {
        "id": uid, "email": email, "display_name": "Simon D",
        "created_at": (NOW - timedelta(days=days_old)).isoformat(),
        "weekly_review_emails": opted_in, "book_name": book,
    }


class ReviewInviteTests(unittest.TestCase):
    def test_active_owner_not_yet_invited_is_due(self):
        plan = l.plan_invites([cand("u1")], set(), set(), now=NOW)
        self.assertEqual([(p["id"], k) for p, k in plan], [("u1", l.A3_KEY)])

    def test_invited_once_only(self):
        plan = l.plan_invites([cand("u1")], {("u1", l.A3_KEY)}, set(), now=NOW)
        self.assertEqual(plan, [])

    def test_already_opted_in_needs_no_invitation(self):
        plan = l.plan_invites([cand("u1", opted_in=True)], set(), set(), now=NOW)
        self.assertEqual(plan, [])

    def test_never_the_same_day_as_the_welcome(self):
        self.assertEqual(l.plan_invites([cand("u1", days_old=1)], set(), set(), now=NOW), [])
        self.assertEqual(len(l.plan_invites([cand("u1", days_old=2)], set(), set(), now=NOW)), 1)

    def test_one_email_per_user_per_run_earlier_step_wins(self):
        plan = l.plan_invites([cand("u1")], set(), {"u1"}, now=NOW)
        self.assertEqual(plan, [])

    def test_copy_names_the_book_and_links_to_the_switch(self):
        text = l.a3_text("Simon", "sonofchucky")
        self.assertIn("trading sonofchucky", text)
        self.assertIn("https://www.alphamolt.ai/account#weekly-review", text)
        self.assertIn("No switch, no email.", text)
        self.assertIn("Every Sunday evening", text)
        html = l.a3_html("Simon", None)
        self.assertIn("trading your portfolio", html)
        self.assertIn('href="https://www.alphamolt.ai/account#weekly-review"', html)

    def test_a3_is_a_registered_step(self):
        subject, text_fn, html_fn = l.RENDERERS[l.A3_KEY]
        self.assertEqual(subject, l.A3_SUBJECT)
        self.assertIs(text_fn, l.a3_text)
        self.assertIs(html_fn, l.a3_html)


if __name__ == "__main__":
    unittest.main()
