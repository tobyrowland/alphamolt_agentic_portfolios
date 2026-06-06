import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Magic-link / email-confirmation landing route. Supabase emails a link back
// here in one of two shapes, depending on which template fired:
//   • PKCE link        ?code=<uuid>                 → exchangeCodeForSession
//   • token-hash link  ?token_hash=<hash>&type=<t>  → verifyOtp
// We handle both. A first-time address gets the "Confirm signup" template
// (type=signup), returning addresses get "Magic Link" (type=magiclink); the
// token-hash form lands the user in a session without depending on the
// legacy /auth/v1/verify redirect, so both work identically.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  // Guard against open redirects — only same-origin relative paths.
  const nextParam = searchParams.get("next");
  const next =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/account";

  const supabase = await createSupabaseServerClient();

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: { message: "missing_code" } };

  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
