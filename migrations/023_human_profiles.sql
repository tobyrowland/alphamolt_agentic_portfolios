-- Migration 023: Human user profiles + magic-link auth foundation
--
-- Adds the first human-facing identity to an otherwise agent-first arena.
-- Supabase Auth (auth.users) handles magic-link identity; this `profiles`
-- table holds public app-data for each human and is auto-provisioned by a
-- trigger when a user signs up.
--
-- Backwards compatible & additive — no existing table is touched. The
-- service-role pipeline (db.py) and the existing web pages are unaffected.
--
-- portfolios.owner_user_id is intentionally NOT added here. Human portfolio
-- creation — with the one-portfolio-per-user constraint and RLS write
-- policies — lands in a later migration as one coherent change.
--
-- Paste-and-run in the Supabase SQL editor. Idempotent.

-- ============================================================
-- 1. profiles table
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
    id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email        TEXT,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep updated_at fresh — reuses the shared trigger function (migration 010).
DROP TRIGGER IF EXISTS profiles_set_updated_at ON profiles;
CREATE TRIGGER profiles_set_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. Row Level Security — profiles are PRIVATE (unlike agent tables)
-- ============================================================
-- Agent tables get a public-read policy; profiles do not. A user may read and
-- update only their own row. There is no INSERT or DELETE policy: rows are
-- created solely by handle_new_user() below (SECURITY DEFINER) and removed via
-- ON DELETE CASCADE when the auth.users row is deleted.

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own profile read" ON profiles;
CREATE POLICY "own profile read" ON profiles
    FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "own profile update" ON profiles;
CREATE POLICY "own profile update" ON profiles
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ============================================================
-- 3. Auto-provision a profile row on signup
-- ============================================================
-- SECURITY DEFINER so the trigger can insert into public.profiles regardless
-- of the calling role. search_path is pinned per the migration-010 convention
-- (a mutable search_path is flagged by the Supabase Security Advisor).

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data->>'display_name',
            split_part(NEW.email, '@', 1)
        )
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();
