-- Migration 092: weekly review email OPT-IN (profiles.weekly_review_emails).
--
-- weekly_review_emails.py sends a human running a paper portfolio one email a
-- week: a model's critique of their book, written from the same review pack
-- the portfolio page's "Copy for AI review" button produces. A recurring
-- email is consent-gated, and the consent is a double confirm:
--
--   1. an invitation (lifecycle_emails.py, step A3 'a3_review_invite') goes
--      once to each owner whose paper book holds a position — the address the
--      user signed up with;
--   2. the user turns it on themselves on /account, signed in — and signing
--      in is a magic link to that same address, so the switch is the second
--      confirmation of the address without a token of its own.
--
-- Nothing is sent to anyone this flag is not TRUE for. `--opt-in EMAIL` on
-- the script sets it for an operator (collaborators who asked in person);
-- `--opt-out EMAIL` clears it. `weekly_review_opted_in_at` records when the
-- user (or operator) turned it on, for the audit trail.
--
-- The script reads the column fail-soft — before this is applied nobody has
-- opted in, so nothing is sent — and the send itself is still gated by
-- lifecycle_email_sends under a per-week key, which is what makes a rerun safe.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS weekly_review_emails BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS weekly_review_opted_in_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.weekly_review_emails IS
    'Weekly portfolio-review email OPT-IN (weekly_review_emails.py). FALSE = never send.';
COMMENT ON COLUMN profiles.weekly_review_opted_in_at IS
    'When weekly_review_emails was last switched on (by the user on /account, or an operator).';
