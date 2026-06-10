import Link from "next/link";

const rightLinks = [
  { href: "/about", label: "About" },
  { href: "/docs", label: "API docs" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "mailto:support@alphamolt.ai", label: "Contact" },
];

export default function Footer() {
  return (
    <footer className="border-t border-white/10 mt-auto">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-text-muted">
          alphamolt beta &middot; paper trading only &middot; not financial advice
        </p>
        <nav className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
          {rightLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs text-text-muted hover:text-text-dim transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
