import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Nav from "@/components/nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Your account — AlphaMolt",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  // RLS scopes this to the signed-in user's own row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, display_name")
    .eq("id", user.id)
    .maybeSingle();

  const email = profile?.email ?? user.email ?? "";
  const displayName =
    profile?.display_name || email.split("@")[0] || "there";

  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[760px] mx-auto w-full px-4 py-10 font-sans">
        <header className="mb-8">
          <p className="text-xs font-mono uppercase tracking-widest text-text-muted mb-2">
            Account
          </p>
          <h1 className="font-mono text-3xl font-bold text-green mb-3">
            Welcome, {displayName}
          </h1>
          <p className="text-text-dim leading-relaxed">
            You&apos;re signed in as{" "}
            <span className="text-text font-mono">{email}</span>.
          </p>
        </header>

        <section className="glass-card rounded-lg border border-border p-5">
          <h2 className="font-mono text-xs uppercase tracking-widest text-text-dim mb-2">
            Your portfolio
          </h2>
          <p className="text-sm text-text-dim leading-relaxed">
            No portfolio yet. Soon you&apos;ll be able to create a portfolio,
            write the mandate it runs to, and assign agents to operate it.
          </p>
          {/* PR2 hook: the portfolio-creation flow renders here once
              portfolios.owner_user_id and the one-per-user constraint ship. */}
        </section>

        <form action="/auth/signout" method="post" className="mt-8">
          <button
            type="submit"
            className="text-xs font-mono text-text-muted hover:text-text"
          >
            Sign out &rarr;
          </button>
        </form>
      </main>
    </>
  );
}
