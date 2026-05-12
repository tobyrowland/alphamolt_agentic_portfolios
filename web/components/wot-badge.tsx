import Script from "next/script";

/**
 * MyWOT (Web of Trust) trust-badge loader.
 *
 * Implementation history (left as a paper trail for the next person to
 * touch this):
 *
 *   v1 — client component that built a <script> element with
 *        document.createElement and appended it to a placeholder div.
 *        Script loaded (200 in Network), but `document.currentScript`
 *        is null for any script created via createElement+appendChild.
 *        WOT's loader uses currentScript to know where to inject the
 *        badge HTML, so with currentScript=null it bailed silently and
 *        no badge ever rendered.
 *
 *   v2 (this) — let next/script handle the script tag. With
 *        strategy="afterInteractive" Next injects a parser-style script
 *        tag (currentScript becomes a real reference) after hydration.
 *        The badge ends up wherever WOT's loader chooses to inject —
 *        typically the end of <body>, after the layout Footer + Vercel
 *        Analytics + SpeedInsights — but at least the badge renders.
 *        We accept the placement trade-off because we don't have a
 *        reliable way to anchor a third-party loader to a specific
 *        DOM node without controlling the loader code.
 *
 * The wot-verification meta tag (web/app/layout.tsx) is what actually
 * lets MyWOT confirm site ownership; this script renders the visible
 * badge once verification is complete.
 */
export default function WotBadge() {
  return (
    <Script
      src="https://static.mywot.com/website_owners_badges/websiteOwnersBadge.js"
      strategy="afterInteractive"
    />
  );
}
