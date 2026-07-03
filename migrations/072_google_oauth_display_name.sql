-- Migration 072: Google OAuth — pick up the provider's name on signup
-- ============================================================
-- The login page now offers "Continue with Google" (Supabase Auth `google`
-- provider) alongside the magic link. Google puts the user's name in
-- raw_user_meta_data under `full_name` / `name`, not the `display_name` key
-- the magic-link path uses — without this, every Google signup fell through
-- to the email-prefix fallback. Widen the COALESCE chain so OAuth signups get
-- their real name. No table changes; existing rows are untouched.

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
            NEW.raw_user_meta_data->>'full_name',
            NEW.raw_user_meta_data->>'name',
            split_part(NEW.email, '@', 1)
        )
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;
