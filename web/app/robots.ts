import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /api is machine-facing. We want agents to hit it via MCP / REST,
        // but there's no reason for search engines to index the JSON bodies.
        // /mcp is the HTTP MCP endpoint — also not useful in search results.
        disallow: ["/api/", "/mcp"],
      },
      // Block AI scrapers that train on or repackage our content. Mirrors the
      // list Cloudflare's "Manage robots.txt" feature would otherwise inject —
      // owned here so we can turn that feature off and drop its Content-Signal
      // directive (which Bing flags as an unknown directive).
      {
        userAgent: [
          "Amazonbot",
          "Applebot-Extended",
          "Bytespider",
          "CCBot",
          "ClaudeBot",
          "Google-Extended",
          "GPTBot",
          "meta-externalagent",
        ],
        disallow: "/",
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    // No `host:` — Yandex-only extension that Bing's robots.txt tester
    // flags as an unknown directive. Canonical host is already handled
    // via the apex→www redirect and <link rel="canonical"> tags.
  };
}
