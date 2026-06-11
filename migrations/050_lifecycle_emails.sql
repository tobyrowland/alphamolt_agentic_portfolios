-- Migration 050: Lifecycle email send log (lifecycle_email_sends).
--
-- Send-once ledger for the automated lifecycle emails sent by
-- lifecycle_emails.py (the onboarding/retention sequence). One row per
-- (user, email_key) — the composite PK is what enforces "never send the
-- same lifecycle email to the same user twice", so the sender script can
-- be rerun / overlap / crash mid-batch safely.
--
-- email_key vocabulary (additive — later sequence steps reuse this table):
--   'a1_welcome'   — the signup welcome (implemented)
--   'a2_*'/'a3_*'… — reserved for the stuck-nudges / milestone emails
--
-- Contains user email addresses → NEVER public. RLS is enabled with no
-- policies on purpose: anon/authenticated roles see nothing; the
-- service-role key (which bypasses RLS) is the only reader/writer.

CREATE TABLE IF NOT EXISTS lifecycle_email_sends (
    user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    email_key  TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, email_key)
);

ALTER TABLE lifecycle_email_sends ENABLE ROW LEVEL SECURITY;
