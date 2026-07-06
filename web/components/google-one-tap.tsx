"use client";

import { useEffect, useRef } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Google One Tap — the floating "Sign in as <you>" prompt, no redirect.
// Google Identity Services runs on-page and hands back an ID token, which
// signInWithIdToken exchanges for a Supabase session directly. This is the
// flow that requires the site to be listed under "Authorized JavaScript
// origins" on the Google OAuth client (the redirect button only needs the
// Supabase callback as a redirect URI).
//
// Renders nothing itself; no-ops unless NEXT_PUBLIC_GOOGLE_CLIENT_ID is set.
// One Tap is best-effort by design — Google suppresses it after a dismissal
// (exponential cooldown), in incognito, or when no Google session exists —
// so the login form's explicit button remains the guaranteed path.

type GoogleCredentialResponse = { credential: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: Record<string, unknown>) => void;
          prompt: () => void;
        };
      };
    };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";

// Google receives the SHA-256 of the nonce; Supabase receives the raw nonce
// and checks that its hash matches the one baked into the ID token.
async function generateNonce(): Promise<[string, string]> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const nonce = btoa(String.fromCharCode(...random));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(nonce),
  );
  const hashedNonce = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return [nonce, hashedNonce];
}

export default function GoogleOneTap({ next }: { next?: string }) {
  const started = useRef(false);

  useEffect(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || started.current) return;
    started.current = true;

    const safeNext =
      next && next.startsWith("/") && !next.startsWith("//")
        ? next
        : "/account/portfolio";

    let cancelled = false;

    async function start() {
      // Signed-in users shouldn't get the prompt.
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getSession();
      if (cancelled || data.session) return;

      const [nonce, hashedNonce] = await generateNonce();
      if (cancelled) return;

      const init = () => {
        if (cancelled || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response: GoogleCredentialResponse) => {
            const { error } = await supabase.auth.signInWithIdToken({
              provider: "google",
              token: response.credential,
              nonce,
            });
            // Full navigation (not router.push) so the server sees the new
            // session cookie on first render.
            if (!error) window.location.assign(safeNext);
          },
          nonce: hashedNonce,
          use_fedcm_for_prompt: true,
        });
        window.google.accounts.id.prompt();
      };

      if (window.google?.accounts?.id) {
        init();
        return;
      }
      let script = document.querySelector<HTMLScriptElement>(
        `script[src="${GSI_SRC}"]`,
      );
      if (!script) {
        script = document.createElement("script");
        script.src = GSI_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", init, { once: true });
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [next]);

  return null;
}
