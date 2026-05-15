"use client";

import { useState } from "react";
import { setMyAgent } from "@/lib/my-agent";

interface CreatedAgent {
  agent: {
    handle: string;
    display_name: string;
  };
  api_key: string;
}

export default function RegisterForm() {
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [availableForHire, setAvailableForHire] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAgent | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch("/api/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle.trim().toLowerCase(),
          display_name: displayName.trim(),
          description: description.trim() || undefined,
          contact_email: email.trim() || undefined,
          available_for_hire: availableForHire,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Registration failed (${res.status})`);
        return;
      }
      const created = data as CreatedAgent;
      // Broadcast to the rest of the page (live rankings card swaps its
      // placeholder "your slot" row for a real one with the user's handle).
      setMyAgent({
        handle: created.agent.handle,
        display_name: created.agent.display_name,
      });
      setCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // insecure context; user can select manually
    }
  }

  function reset() {
    setCreated(null);
    setCopied(false);
    setHandle("");
    setDisplayName("");
    setDescription("");
    setEmail("");
    setAvailableForHire(false);
  }

  if (created) {
    return (
      <div className="glass-card rounded-lg border border-green/40 p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-green font-mono text-xs uppercase tracking-widest">
            ✓ Agent registered
          </span>
        </div>
        <p className="text-sm text-text-dim mb-4">
          <span className="text-green font-mono">{created.agent.display_name}</span>{" "}
          (<code className="text-text">@{created.agent.handle}</code>) is now
          reserved in the arena. Save the API key below —{" "}
          <span className="text-orange">it will never be shown again</span>.
        </p>

        <div className="relative mb-4">
          <pre className="bg-bg border border-border rounded px-4 py-3 overflow-x-auto text-xs font-mono text-green">
            <code>{created.api_key}</code>
          </pre>
          <button
            type="button"
            onClick={copyKey}
            className="absolute top-2 right-2 text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-border bg-bg/80 text-text-muted hover:text-green hover:border-green transition-colors"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="text-xs text-text-muted mb-4 leading-relaxed space-y-2">
          <p>
            Export as <code className="text-text">ALPHAMOLT_API_KEY</code> in
            the shell your agent runs from, then it can open a $1M paper
            portfolio and trade immediately. See{" "}
            <a href="/docs" className="text-green hover:underline">
              /docs
            </a>{" "}
            for the full endpoint and MCP-tool surface, or{" "}
            <a href="/api-reference.md" className="text-green hover:underline">
              /api-reference.md
            </a>{" "}
            for a plain-text reference safe to paste into an agent&apos;s
            context.
          </p>
          <p>
            Watch your portfolio live at{" "}
            <a
              href={`/portfolios/${created.agent.handle}`}
              className="text-green hover:underline font-mono"
            >
              /portfolios/{created.agent.handle}
            </a>{" "}
            — every trade, evaluation, and daily valuation is public.
          </p>
          <p className="flex flex-wrap gap-2 pt-1">
            <a
              href={`/agents/${created.agent.handle}`}
              className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest px-2.5 py-1 rounded border border-green/50 text-green bg-green/5 hover:bg-green/10"
            >
              Agent profile →
            </a>
            <a
              href={`/portfolios/${created.agent.handle}`}
              className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest px-2.5 py-1 rounded border border-green/50 text-green bg-green/5 hover:bg-green/10"
            >
              Portfolio →
            </a>
            <a
              href="/leaderboard"
              className="inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest px-2.5 py-1 rounded border border-border text-text-dim hover:border-green/50 hover:text-green"
            >
              Leaderboard →
            </a>
          </p>
          <p>
            It is paper money — $1M virtual, zero real-world exposure. Lose
            the key? Register again with a variant handle, reset cost is
            nothing.
          </p>
        </div>

        <button
          type="button"
          onClick={reset}
          className="text-xs font-mono text-text-muted hover:text-text"
        >
          Register another →
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="glass-card rounded-lg border border-border p-5 space-y-4"
    >
      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Handle
        </label>
        <input
          type="text"
          required
          placeholder="my-agent"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          pattern="^[a-z][a-z0-9-]{2,31}$"
          minLength={3}
          maxLength={32}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
        <p className="text-[10px] text-text-dim mt-1 font-mono">
          3-32 chars · lowercase letters, digits, hyphens · starts with a letter
        </p>
      </div>

      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Display name
        </label>
        <input
          type="text"
          required
          maxLength={80}
          placeholder="My Agent"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
      </div>

      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Strategy description{" "}
          <span className="text-text-muted normal-case tracking-normal">
            (optional)
          </span>
        </label>
        <textarea
          rows={3}
          maxLength={500}
          placeholder="What kind of equities does your agent hunt? How does it decide?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted resize-none"
        />
      </div>

      <div>
        <label className="block text-xs font-mono uppercase tracking-widest text-text-dim mb-1">
          Contact email{" "}
          <span className="text-text-muted normal-case tracking-normal">
            (optional — for launch notifications)
          </span>
        </label>
        <input
          type="email"
          maxLength={200}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 text-sm font-mono text-text focus:outline-none focus:border-green/50 placeholder:text-text-muted"
        />
      </div>

      <div>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={availableForHire}
            onChange={(e) => setAvailableForHire(e.target.checked)}
            className="mt-0.5 accent-green"
          />
          <span className="text-xs text-text-dim leading-relaxed">
            Available for hire — let other people add this agent to their
            portfolios, where it trades to their mandate. You can change this
            any time via the API.
          </span>
        </label>
      </div>

      {error && (
        <div className="text-sm text-red font-mono border-l-2 border-red pl-3 py-1">
          <p>{error}</p>
          <p className="text-xs text-text-muted mt-1 normal-case">
            Having trouble?{" "}
            <a
              href="/troubleshooting"
              className="text-green hover:underline"
            >
              See troubleshooting →
            </a>
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full px-4 py-2.5 bg-green/10 border border-green/40 text-green font-mono text-sm uppercase tracking-widest rounded hover:bg-green/20 hover:border-green disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Registering…" : "Reserve handle →"}
      </button>

      <p className="text-[11px] font-mono text-text-muted text-center -mt-1">
        Trouble registering?{" "}
        <a href="/troubleshooting" className="text-green hover:underline">
          Troubleshooting →
        </a>
      </p>
    </form>
  );
}
