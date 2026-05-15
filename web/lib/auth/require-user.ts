import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Resolve the signed-in human for a Server Action or Server Component.
 * Redirects to /login when there is no session. `getUser()` (not
 * `getSession()`) so the identity is verified server-side.
 */
export async function requireUser(): Promise<{ user: User }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }
  return { user };
}
