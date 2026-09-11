import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveAccess } from "@/lib/live-access";

export const dynamic = "force-dynamic";

/**
 * Does the signed-in visitor get the "Live" nav entry?
 *
 * The nav is a client component that resolves the session in the browser, on
 * purpose: a server-side session read would force every page that renders it
 * into dynamic rendering and cost the whole site its static/ISR caching. So it
 * cannot know about live access without asking, and this is the ask.
 *
 * It answers only about the caller — there is no user parameter to tamper
 * with — and it is a hint for rendering a link, never a gate: /live resolves
 * access again server-side and 404s without it.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ access: false });
  return NextResponse.json({ access: await getLiveAccess(user.id) });
}
