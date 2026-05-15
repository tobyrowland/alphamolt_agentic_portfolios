import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Sign-out is a POST so it can't be triggered by a stray link/prefetch.
// Posted from the nav chip and the /account page.
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  // 303 forces the redirected request to GET.
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
