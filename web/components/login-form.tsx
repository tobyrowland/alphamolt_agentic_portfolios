"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Same-origin relative paths only — /auth/callback re-validates, but don't
  // even send anything else.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "";
  const callbackUrl = () =>
    `${window.location.origin}/auth/callback${
      safeNext ? `?next=${encodeURIComponent(safeNext)}` : ""
    }`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: callbackUrl(),
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

  async function handleGoogle() {
    setError(null);
    setGoogleSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: callbackUrl(),
        },
      });
      if (error) {
        setError(error.message);
        setGoogleSubmitting(false);
      }
      // On success the browser navigates to Google — leave the button disabled.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setGoogleSubmitting(false);
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 space-y-4">
      <button
        type="button"
        onClick={handleGoogle}
        disabled={googleSubmitting || submitting}
        className="w-full inline-flex items-center justify-center gap-2.5 px-5 py-2.5 rounded-lg border border-white/15 bg-white/[0.04] text-sm font-semibold text-text tracking-tight transition-colors hover:bg-white/[0.08] disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-cyan)]/40"
      >
        <GoogleLogo />
        {googleSubmitting ? "Redirecting…" : "Continue with Google"}
      </button>

      <div className="flex items-center gap-3" aria-hidden>
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
          or
        </span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden className="shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
