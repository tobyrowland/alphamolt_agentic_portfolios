-- Migration 092: weekly review email opt-out (profiles.weekly_review_emails).
--
-- weekly_review_emails.py sends every human running a paper portfolio one
-- email a week: a model's critique of their book, written from the same
-- review pack the portfolio page's "Copy for AI review" button produces.
-- A recurring email needs a standing opt-out, which the one-shot lifecycle
-- emails (migration 050) never did — their "reply and I'll stop" ask was
-- honoured by hand because each of them sends once. This flag is that
-- opt-out: FALSE and the weekly job skips the user for good.
--
-- The script reads the column fail-soft (everyone opted in, with a warning)
-- until this has been applied, so merging it before running the migration
-- costs nothing but the ability to opt out. `--opt-out EMAIL` sets it.
--
-- The send itself is still gated by lifecycle_email_sends under a per-week
-- key ('weekly_review_2026-W38'), which is what makes a rerun safe.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS weekly_review_emails BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN profiles.weekly_review_emails IS
    'Weekly portfolio-review email opt-in (weekly_review_emails.py). FALSE = never send.';
