/**
 * GET /screener/run?config={encoded}
 *
 * "Run this screen as a portfolio" from the screener signpost / cut banner.
 * Applies the screen as the signed-in owner's portfolio selection recipe
 * (portfolios.screen_config) and redirects to that portfolio's page — NOT the
 * old /account control room.
 *
 * - Not signed in → /login?next=… so the apply completes after auth.
 * - Signed in, no portfolio yet → /account (the create flow), carrying the
 *   config so it can be applied once a portfolio exists.
 * - Signed in with a paper portfolio → set screen_config (owner-gated), then
 *   land on /portfolios/<slug>.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabase } from "@/lib/supabase";
import { getPortfolioForUser } from "@/lib/portfolios-query";
import { screenConfigSchema } from "@/lib/screen/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function decodeConfig(encoded: string): unknown | null {
  try {
    const pad = encoded.length % 4 === 0 ? "" : "=".repeat(4 - (encoded.length % 4));
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const encoded = url.searchParams.get("config") ?? "";
  const self = `/screener/run?config=${encoded}`;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(`/login?next=${encodeURIComponent(self)}`, req.url),
    );
  }

  const portfolio = await getPortfolioForUser(user.id);
  if (!portfolio) {
    // No portfolio yet — send to the create flow, keeping the config around.
    return NextResponse.redirect(
      new URL(`/account?from=screen&config=${encoded}`, req.url),
    );
  }

  // Validate before writing; a bad/hand-edited param just skips the apply.
  const parsed = screenConfigSchema.safeParse(decodeConfig(encoded));
  if (parsed.success) {
    const svc = getSupabase();
    const { error } = await svc
      .from("portfolios")
      .update({ screen_config: parsed.data })
      .eq("id", portfolio.id)
      .eq("owner_user_id", user.id);
    if (error) console.error("apply screen_config failed:", error.message);
  }

  return NextResponse.redirect(
    new URL(`/portfolios/${portfolio.slug}?screen=applied`, req.url),
  );
}
