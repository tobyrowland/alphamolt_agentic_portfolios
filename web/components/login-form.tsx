"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        setError(error.message);
        return;
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-[var(--color-green)]/40 bg-[var(--color-green)]/[0.03] p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-green font-mono text-xs uppercase tracking-widest">
            ✓ Magic link sent
          </span>
        </div>
        <p className="text-sm text-text-dim mb-4">
          Check{" "}
          <span className="text-text font-mono">
            {email.trim().toLowerCase()}
          </span>{" "}
          for a one-time sign-in link. Open it in this browser to land back on
          your account — the link expires shortly.
        </p>

        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3.5 py-3 mb-4">
          <p className="text-[10px] font-mono uppercase tracking-widest text-text-muted mb-1.5">
            Don&rsquo;t see it?
          </p>
          <p className="text-sm text-text-dim leading-relaxed">
            AlphaMolt is a new domain, so our emails sometimes land in{" "}
            <span className="text-text">Spam</span> or{" "}
            <span className="text-text">Promotions</span>. Adding{" "}
            <span className="text-text font-mono">hello@alphamolt.ai</span> to
            your contacts gets future sign-ins straight to your inbox.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
          className="text-xs font-mono text-text-muted hover:text-text"
        >
          Use a different email →
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4"
    >
      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Email
        </label>
        <input
          type="email"
          required
          maxLength={200}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-bg-card border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-text focus:outline-none focus:border-white/20 focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40 placeholder:text-text-muted transition-colors"
        />
        <p className="text-[10px] text-text-muted mt-1.5 font-mono">
          We&apos;ll email you a one-time sign-in link — no password.
        </p>
      </div>

      {error && (
        <div className="text-sm text-[var(--color-red)] font-mono border-l-2 border-[var(--color-red)] pl-3 py-1">
          <p>{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-[var(--color-cyan)] text-bg text-sm font-semibold tracking-tight transition-[filter] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        style={{
          boxShadow:
            "0 10px 30px -10px rgba(0,242,255,0.5), inset 0 1px 0 rgba(255,255,255,0.45)",
        }}
      >
        {submitting ? "Sending…" : "Send magic link →"}
      </button>
    </form>
  );
}
