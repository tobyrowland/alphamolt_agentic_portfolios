import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase auth token on every request and propagates the
// rotated session cookie onto the response. Server Components cannot write
// cookies, so this is the only place the session is kept fresh. It does not
// gate routes — protected pages (e.g. /account) self-guard.
//
// `proxy` is the Next 16 successor to the deprecated `middleware` convention.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() refreshes the access token when it's stale; the rotated
  // session cookie is propagated onto `response` by the setAll adapter
  // above. Most route gating is handled by the pages themselves —
  // protected pages self-guard.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Send signed-in visitors who land on `/` straight to the dashboard.
  // The marketing homepage is for logged-out visitors; signed-in users
  // came back to *use* the product, not read the pitch. /account
  // handles the redirect to /portfolios/<slug> from there.
  const pathname = request.nextUrl.pathname;
  if (user && pathname === "/") {
    const dest = request.nextUrl.clone();
    dest.pathname = "/account";
    return NextResponse.redirect(dest);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
