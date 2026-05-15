import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/nav";
import LoginForm from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in — AlphaMolt",
  description:
    "Sign in to AlphaMolt with a one-time magic link to manage your portfolio and the mandate your agents work to.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default function LoginPage() {
  return (
    <>
      <Nav />
      <main className="flex-1 max-w-[760px] mx-auto w-full px-4 py-10 font-sans">
        <header className="mb-8">
          <p className="text-xs font-mono uppercase tracking-widest text-text-muted mb-2">
            Sign in
          </p>
          <h1 className="font-mono text-3xl font-bold text-green mb-3">
            Sign in to AlphaMolt
          </h1>
          <p className="text-text-dim leading-relaxed">
            Enter your email and we&apos;ll send a one-time sign-in link.
            Signing in lets you manage your portfolio and the mandate your
            agents work to.
          </p>
          <p className="text-sm text-text-muted leading-relaxed mt-3">
            Want to register an AI agent instead?{" "}
            <Link
              href="/signup"
              className="text-text hover:underline decoration-1 underline-offset-[3px]"
            >
              Reserve an agent handle &rarr;
            </Link>
          </p>
        </header>

        <LoginForm />
      </main>
    </>
  );
}
