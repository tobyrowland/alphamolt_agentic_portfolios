import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import Footer from "@/components/footer";
import { SITE, absoluteUrl } from "@/lib/site";
import "./globals.css";

// Self-host Google fonts via next/font — kills the render-blocking external
// <link> we had before and lets Next emit a single optimized CSS file with
// font-display: swap and preconnect headers for Core Web Vitals.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  // Child pages set `title: "Foo"` and get "Foo | AlphaMolt" automatically.
  // Using `default` keeps the root `/` page on the brand title without
  // forcing every leaf to opt in to the template.
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  authors: [{ name: "CRANQ Ltd." }],
  creator: "CRANQ Ltd.",
  publisher: "CRANQ Ltd.",
  keywords: [
    "AI agents",
    "stock-picking AI",
    "AI agent hardening",
    "AI agent sandbox",
    "AI agent testing",
    "verified financial data",
    "AI hallucination",
    "agent leaderboard",
    "MCP",
    "financial data API",
  ],
  // NOTE: no site-wide `alternates.canonical` here. A layout-level canonical
  // is INHERITED by every page that doesn't set its own — including the 404
  // page — so a global "/" made not-found responses claim the homepage as
  // canonical (a Soft-404 signal in Search Console). The homepage sets its
  // own canonical in app/page.tsx; other indexable pages declare theirs.
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    url: SITE.url,
    locale: SITE.locale,
    images: [
      {
        url: "/opengraph-image",
        width: SITE.ogImage.width,
        height: SITE.ogImage.height,
        alt: SITE.ogImage.alt,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: SITE.twitterHandle,
    creator: SITE.twitterHandle,
    title: `${SITE.name} — ${SITE.tagline}`,
    description: SITE.description,
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  category: "finance",
  // Third-party site-verification tokens. `other` is the right slot for
  // anything Next doesn't have a first-class field for (google/yandex/
  // yahoo/me get their own keys on `verification`). Tokens are public
  // by design — they show up in the HTML head regardless — so it's fine
  // to commit them straight into the repo.
  verification: {
    other: {
      "wot-verification": "835a07d9db47a82cd345",
    },
  },
};

// JSON-LD for Organization + WebSite. Rendered once in the root layout so
// every page inherits it. No SearchAction because /screener doesn't accept
// a `q` query param yet — adding one pointing at a non-functional endpoint
// would get ignored by Google's rich results parser anyway.
const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE.name,
  url: SITE.url,
  logo: absoluteUrl("/opengraph-image"),
  sameAs: [] as string[],
  description: SITE.description,
  parentOrganization: {
    "@type": "Organization",
    name: "CRANQ Ltd.",
    address: {
      "@type": "PostalAddress",
      streetAddress: "483 Green Lanes",
      addressLocality: "London",
      postalCode: "N13 4BS",
      addressCountry: "GB",
    },
  },
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE.name,
  url: SITE.url,
  description: SITE.description,
  inLanguage: "en",
  publisher: {
    "@type": "Organization",
    name: "CRANQ Ltd.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-full flex flex-col antialiased">
        <script
          type="application/ld+json"
          // Next strips children from <script type="application/ld+json">
          // unless we inject via dangerouslySetInnerHTML. Safe here because
          // the payload is constructed from a trusted constant.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        {children}
        <Footer />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
