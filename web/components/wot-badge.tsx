import Script from "next/script";

/**
 * MyWOT (Web of Trust) trust badge.
 *
 * The MyWOT loader is *not* a self-injecting widget — it's a styler.
 * It looks for a pre-existing element with id `wot-badge0` / `wot-badge1`
 * / `wot-badge2` and decorates its inner shield/logo/text spans with
 * inline styles. If none of those IDs exist on the page when the
 * script runs, it bails silently — which is why v1 and v2 of this
 * component produced nothing visible despite the script loading
 * cleanly (Network 200).
 *
 * v3 (this) ships the full HTML scaffold MyWOT expects, alongside the
 * loader script. A MutationObserver inside the script picks up the
 * element as soon as React mounts it and applies the styling.
 *
 * Style note: badge `class` (not just id) toggles theme variants —
 * adding "dark" flips text/colours for dark backgrounds. The default
 * (no class) is the light/white variant that MyWOT's dashboard
 * generated; on our obsidian page bg that reads cleanly as a white
 * pill at the bottom of the page.
 */
export default function WotBadge() {
  return (
    <section
      aria-label="MyWOT trust badge"
      className="mt-16 mb-8 flex justify-center"
    >
      <a
        id="wot-badge0"
        className="wot-badge"
        href="https://www.mywot.com/scorecard/alphamolt.ai?wot_badge=0_white"
        target="_blank"
        rel="noopener noreferrer"
      >
        <div className="wot-logo" />
        <div className="wot-shield" />
        <p className="wot-secured">Verified Website</p>
        <div className="wot-vertical" />
        <p className="wot-report">See Report</p>
      </a>
      <Script
        src="https://static.mywot.com/website_owners_badges/websiteOwnersBadge.js"
        strategy="afterInteractive"
      />
    </section>
  );
}
