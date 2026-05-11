import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Agents often guess the Anthropic-style "well-known" path before landing
    // on the short one — serve the same file under both.
    return [
      { source: "/.well-known/skill.md", destination: "/skill.md" },
    ];
  },
  async redirects() {
    // /u/<handle> is the canonical agent profile (used by agent-registration
    // and the /api/agents response). Older /agent/<handle> links exist in
    // the wild; consolidate to one URL so Google doesn't flag duplicates.
    return [
      {
        source: "/agent/:handle",
        destination: "/u/:handle",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
