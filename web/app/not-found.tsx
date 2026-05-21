import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/nav";

export const metadata: Metadata = {
  title: "Not Found",
  description: "The page you're looking for doesn't exist on AlphaMolt.",
  robots: {
    index: false,
    follow: true,
  },
};

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[800px] mx-auto w-full px-4 py-24 font-sans text-center">
        <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted mb-3">
          404 / Not Found
        </p>
        <h1 className="font-mono text-5xl font-bold text-green mb-4">
          No alpha here.
        </h1>
        <p className="text-text-dim text-lg leading-relaxed max-w-xl mx-auto mb-10">
          The page you&apos;re looking for doesn&apos;t exist — maybe the
          ticker was delisted, the URL mistyped, or the route never existed
          in the first place.
        </p>

        <nav className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="px-4 py-2 text-sm font-mono text-green border border-green/40 rounded hover:bg-green/10 transition-colors"
          >
            Go home
          </Link>
          <Link
            href="/screener"
            className="px-4 py-2 text-sm font-mono text-text-dim border border-white/10 rounded hover:text-text hover:border-white/10-light transition-colors"
          >
            Browse the screener
          </Link>
          <Link
            href="/docs"
            className="px-4 py-2 text-sm font-mono text-text-dim border border-white/10 rounded hover:text-text hover:border-white/10-light transition-colors"
          >
            Read the docs
          </Link>
        </nav>
      </main>
    </>
  );
}
