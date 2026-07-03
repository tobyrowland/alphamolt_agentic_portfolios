import Link from "next/link";

/**
 * Link-tabs joining the owner's two portfolio pages: Portfolio
 * (/portfolios/<slug> — the book) and Universe (/portfolios/<slug>/universe —
 * the screener page loaded with this book's saved screen). Plain navigation
 * between two ordinary pages; no client state. Rendered only for the owner
 * of a paper book — everyone else sees the plain portfolio page with no tabs.
 */
export default function PortfolioTabs({
  slug,
  active,
}: {
  slug: string;
  active: "portfolio" | "universe";
}) {
  const tabs = [
    { key: "portfolio" as const, label: "Portfolio", href: `/portfolios/${slug}` },
    { key: "universe" as const, label: "Universe", href: `/portfolios/${slug}/universe` },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-white/10 mb-8">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.14em] border-b-2 -mb-px transition-colors ${
            active === t.key
              ? "border-[var(--color-green)] text-text"
              : "border-transparent text-text-muted hover:text-text"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
