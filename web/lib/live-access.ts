import { getSupabase } from "@/lib/supabase";
import { hasLiveAccess, resolveLiveAccess } from "@/lib/live-access-rule";

// Re-exported so callers keep one import for the whole concern.
export { hasLiveAccess, resolveLiveAccess };

/**
 * Resolve access for one signed-in user against the live database.
 *
 * Thin wiring: each read is wrapped so its own failure yields `null` rather
 * than propagating, and `resolveLiveAccess` decides. PostgREST builders are
 * thenable but not real Promises, hence the async wrappers rather than
 * `.catch()`.
 */
export async function getLiveAccess(userId: string): Promise<boolean> {
  const supabase = getSupabase();

  const flag = (async (): Promise<boolean | null> => {
    try {
      const r = await supabase
        .from("profiles")
        .select("live_access")
        .eq("id", userId)
        .maybeSingle();
      if (r.error) throw r.error;
      return Boolean((r.data as { live_access?: boolean } | null)?.live_access);
    } catch (err) {
      console.error("live-access: operator-flag read failed:", err);
      return null;
    }
  })();

  const owned = (async (): Promise<number | null> => {
    try {
      const r = await supabase
        .from("portfolios")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", userId)
        .eq("mode", "live");
      if (r.error) throw r.error;
      return r.count ?? 0;
    } catch (err) {
      console.error("live-access: live-portfolio count failed:", err);
      return null;
    }
  })();

  const [liveAccessFlag, livePortfolioCount] = await Promise.all([flag, owned]);
  return resolveLiveAccess(liveAccessFlag, livePortfolioCount);
}
