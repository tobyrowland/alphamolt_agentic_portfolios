import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Anon-key Supabase client for Server Components and route handlers. AUTH
// ONLY — it carries the signed-in user's JWT and is subject to RLS. Never use
// the service-role client (web/lib/supabase.ts) here: it bypasses RLS and
// would silently mask a broken policy.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll was called from a Server Component, which cannot write
            // cookies. Safe to ignore — middleware.ts refreshes the session
            // cookie on every request.
          }
        },
      },
    },
  );
}
