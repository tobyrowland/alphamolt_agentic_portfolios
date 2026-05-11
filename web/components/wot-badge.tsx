"use client";

import { useEffect, useRef } from "react";

/**
 * MyWOT (Web of Trust) trust-badge widget. WOT's loader inserts the
 * badge HTML at the DOM position of its own `<script>` element, so we
 * append the script into a placeholder div via useEffect — that's the
 * only reliable way to anchor the badge to a specific spot in the page
 * with Next.js's App Router (next/script always lands in <head>, and
 * vanilla <script> tags in JSX don't execute).
 *
 * Idempotent: bails out if the script tag is already present (avoids
 * a second badge being injected after a soft client-side nav back to
 * the home page).
 */
export default function WotBadge() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const src =
      "https://static.mywot.com/website_owners_badges/websiteOwnersBadge.js";
    // Idempotency check — covers React strict-mode double mount in dev
    // and client-side back-nav after the badge has already rendered.
    if (
      typeof document !== "undefined" &&
      document.querySelector(`script[src="${src}"]`)
    ) {
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    container.appendChild(script);
  }, []);

  return (
    <section
      aria-label="Trust badge"
      className="mt-16 mb-8 flex justify-center"
    >
      <div ref={ref} />
    </section>
  );
}
