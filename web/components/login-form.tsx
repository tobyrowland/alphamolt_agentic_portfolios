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
          className="w-full bg-bg border border-white/10 rounded px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
        <p className="text-[10px] text-text-dim mt-1 font-mono">
          We&apos;ll email you a one-time sign-in link — no password.
        </p>
      </div>

      {error && (
        <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          <p>{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2.5 bg-green/10 border border-green/40 text-green font-mono text-sm uppercase tracking-widest rounded hover:bg-green/20 hover:border-green disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Sending…" : "Send magic link →"}
      </button>
    </form>
  );
}
