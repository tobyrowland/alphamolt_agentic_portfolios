import { createBrowserClient } from "@supabase/ssr";

// Anon-key Supabase client for the browser. AUTH ONLY — it carries the
// signed-in user's JWT and is subject to RLS. Never use the service-role
// client (web/lib/supabase.ts) for auth, and never import this module into
// public-data pages.
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
