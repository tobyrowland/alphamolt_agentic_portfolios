"use server";

/**
 * Server Action for saving a screen (brief v2 §10 — "Save produces a working
 * link"). Saving is gated behind login; viewing/sharing is not. Same auth
 * model as the other mutations: verify the SSR cookie session, then write with
 * the service-role client (owner_user_id stamped explicitly).
 */

import { getSupabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { slugify } from "@/lib/slug";
import { screenConfigSchema, type ScreenConfig } from "@/lib/screen/config";

export type SaveResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

async function uniqueScreenSlug(name: string): Promise<string> {
  const supabase = getSupabase();
  const root = slugify(name);
  let candidate = root;
  for (let n = 2; n < 1000; n++) {
    const { data } = await supabase
      .from("saved_screens")
      .select("slug")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${root.slice(0, 34)}-${n}`;
  }
  return `${root.slice(0, 28)}-${Date.now().toString(36)}`;
}

export async function saveScreen(input: {
  name: string;
  config: ScreenConfig;
}): Promise<SaveResult> {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    return { ok: false, error: "Sign in to save a screen." };
  }

  const name = (input.name || "").trim().slice(0, 80) || "My screen";
  let config: ScreenConfig;
  try {
    config = screenConfigSchema.parse(input.config);
  } catch {
    return { ok: false, error: "Invalid screen config." };
  }

  const slug = await uniqueScreenSlug(name);
  const supabase = getSupabase();
  const { error } = await supabase
    .from("saved_screens")
    .insert({ owner_user_id: user.id, slug, name, config });
  if (error) return { ok: false, error: error.message };
  return { ok: true, slug };
}
