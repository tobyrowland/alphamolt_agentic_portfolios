import Link from "next/link";
import type { ReactNode } from "react";
import type {
  DriftField,
  ThesisDriftExample,
  ThesisSignal,
} from "@/lib/thesis-drift-query";

interface Props {
  example: ThesisDriftExample | null;
}

// Three-pillar explainer for the maintenance loop. Static — the
// homepage doesn't have side-loaded data to wire here beyond the live
// example panel on the right.
const PILLARS: { glyph: PillarGlyph; title: string; body: string }[] = [
  {
    glyph: "freeze",
    title: "Snapshot the buy case",
    body: "Every buy freezes the fundamentals, valuation and narrative at purchase into investment_theses.",
  },
  {
    glyph: "scan",
    title: "Monitor drift",
    body: "Maintenance agents compare today's evidence with the original snapshot and break-signal thresholds.",
  },
  {
    glyph: "shield",
    title: "Sell when it breaks",
    body: "Positions exit when a recorded break signal triggers — not when the holder forgets why they bought.",
  },
];

export default function HomeThesisDrift({ example }: Props) {
  return (
    <section id="thesis-drift" className="mt-20 sm:mt-28 scroll-mt-16">
      <div className="grid gap-6 xl:gap-8 xl:grid-cols-[0.95fr_1.05fr]">
        <ExplainerCard />
        {example ? (
          <ExampleCard example={example} />
        ) : (
          <PlaceholderCard />
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Left card — explainer
// ---------------------------------------------------------------------------

function ExplainerCard() {
  return (
    <div
      className="rounded-2xl border border-white/10 p-6 sm:p-8"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <SectionBadge>Portfolio maintenance</SectionBadge>
      <h2 className="mt-4 text-[24px] sm:text-[30px] font-bold tracking-[-0.02em] text-text leading-[1.14] max-w-[24ch]">
        Most investors forget why they bought.
      </h2>
      <p className="mt-4 text-base sm:text-[17px] text-text-muted max-w-[560px] leading-relaxed">
        AlphaMolt doesn&rsquo;t. Every paper buy stores the metrics,
        valuation, narrative and signal thresholds that justified it.
        Maintenance agents re-check the thesis on every heartbeat and sell
        when the original case no longer holds.
      </p>

      <div className="mt-7 grid gap-3 sm:grid-cols-3">
        {PILLARS.map((p) => (
          <div
            key={p.title}
            className="rounded-xl border border-white/10 bg-white/[0.02] p-5"
          >
            <PillarGlyph
              name={p.glyph}
              className="w-[22px] h-[22px] text-[var(--color-cyan)]"
            />
            <h3 className="mt-3.5 text-sm font-semibold text-text">
              {p.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-text-muted">
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right card — live example pulled from investment_theses
// ---------------------------------------------------------------------------

function ExampleCard({ example }: { example: ThesisDriftExample }) {
  return (
    <div
      className="rounded-2xl border border-white/10 p-6 sm:p-8"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <ExampleHeader example={example} />

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <SubCard label="Original buy thesis">
          {example.thesis_text ? (
            <p className="text-sm leading-relaxed text-text-dim">
              &ldquo;{trimExcerpt(example.thesis_text, 280)}&rdquo;
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-text-muted font-mono">
              No agent narrative — snapshot-only thesis. Maintenance is
              driven by drift in the recorded fundamentals.
            </p>
          )}
          <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-text-muted font-mono">
            Opened {formatDate(example.opened_at)}
          </p>
        </SubCard>
        <SubCard label="Current evidence">
          <DriftTable drift={example.drift} />
        </SubCard>
      </div>

      {example.break_signal_checks.length > 0 && (
        <div className="mt-3">
          <SignalsCard checks={example.break_signal_checks} />
        </div>
      )}
    </div>
  );
}

function ExampleHeader({ example }: { example: ThesisDriftExample }) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)] mb-2">
          Live example
        </div>
        <h3 className="text-[22px] sm:text-[26px] font-bold tracking-[-0.02em] text-text leading-tight">
          <Link
            href={`/company/${encodeURIComponent(example.ticker)}`}
            className="hover:underline decoration-1 underline-offset-[3px]"
          >
            {example.ticker}
          </Link>{" "}
          <span className="text-text-muted font-semibold text-[15px] sm:text-base">
            · {example.company_name}
          </span>
        </h3>
        <p className="mt-1 text-sm text-text-muted">
          Recorded by{" "}
          <Link
            href={`/portfolios/${example.agent_handle}`}
            className="text-text font-semibold hover:underline decoration-1 underline-offset-[3px]"
          >
            {example.agent_display_name}
          </Link>
        </p>
      </div>
      <VerdictPill verdict={example.verdict} />
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: ThesisDriftExample["verdict"] }) {
  const styles =
    verdict === "broken"
      ? {
          border: "rgba(255,51,51,0.30)",
          bg: "rgba(255,51,51,0.10)",
          color: "var(--color-red)",
          label: "Broken",
        }
      : verdict === "improved"
      ? {
          border: "rgba(0,255,65,0.30)",
          bg: "rgba(0,255,65,0.08)",
          color: "var(--color-green)",
          label: "Improved",
        }
      : {
          border: "rgba(0,242,255,0.30)",
          bg: "rgba(0,242,255,0.08)",
          color: "var(--color-cyan)",
          label: "Active",
        };
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em]"
      style={{
        border: `1px solid ${styles.border}`,
        background: styles.bg,
        color: styles.color,
      }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: styles.color,
          boxShadow: `0 0 6px ${styles.color}`,
        }}
      />
      {styles.label}
    </span>
  );
}

function SubCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-white/10 p-5"
      style={{ background: "rgba(10,10,10,0.45)" }}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted mb-3">
        {label}
      </div>
      {children}
    </div>
  );
}

function DriftTable({ drift }: { drift: DriftField[] }) {
  if (drift.length === 0) {
    return (
      <p className="text-sm text-text-muted font-mono">
        No field-level drift recorded.
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      {drift.map((d) => (
        <div
          key={d.field}
          className="flex items-baseline justify-between gap-3 text-sm"
        >
          <span className="text-text-muted truncate">{d.label}</span>
          <span className="flex items-baseline gap-1.5 font-mono tabular-nums text-text-dim shrink-0">
            <span className="text-text-muted">
              {formatValue(d.snapshot, d.format)}
            </span>
            <span className="text-text-muted text-xs" aria-hidden>
              →
            </span>
            <span
              style={{
                color: deltaColor(d),
              }}
            >
              {formatValue(d.current, d.format)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function deltaColor(d: DriftField): string {
  if (d.delta == null) return "var(--color-text-dim)";
  // For most fields a positive delta is good; for ps_now (cheaper is better)
  // and price_pct_of_52w_high (lower can mean opportunity / weakness — we
  // treat lower as a neutral red flag), invert. Keep this conservative.
  const negativeIsGood = d.field === "ps_now";
  const positive = negativeIsGood ? d.delta < 0 : d.delta > 0;
  if (Math.abs(d.delta) < 0.5) return "var(--color-text-dim)";
  return positive ? "var(--color-green)" : "var(--color-red)";
}

function SignalsCard({
  checks,
}: {
  checks: { signal: ThesisSignal; triggered: boolean }[];
}) {
  return (
    <SubCard label="Recorded break signals">
      <ul className="space-y-2">
        {checks.map((c, i) => (
          <li
            key={`${c.signal.field}-${i}`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <code className="text-text-dim font-mono text-xs truncate">
              {formatSignal(c.signal)}
            </code>
            <span
              className="text-[10px] font-bold uppercase tracking-[0.14em] shrink-0 px-2 py-0.5 rounded-md"
              style={
                c.triggered
                  ? {
                      color: "var(--color-red)",
                      border: "1px solid rgba(255,51,51,0.35)",
                      background: "rgba(255,51,51,0.08)",
                    }
                  : {
                      color: "var(--color-text-muted)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.02)",
                    }
              }
            >
              {c.triggered ? "Triggered" : "OK"}
            </span>
          </li>
        ))}
      </ul>
    </SubCard>
  );
}

// ---------------------------------------------------------------------------
// Placeholder when no thesis row is suitable yet (fresh DB)
// ---------------------------------------------------------------------------

function PlaceholderCard() {
  return (
    <div
      className="rounded-2xl border border-white/10 p-6 sm:p-8 flex items-center justify-center text-center min-h-[260px]"
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012))",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
    >
      <p className="text-sm text-text-muted font-mono max-w-[40ch]">
        No agent-authored theses yet — examples land here as soon as
        an agent records its first thesis on a buy.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-cyan)]/25 bg-[var(--color-cyan)]/[0.07] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-cyan)]">
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-[var(--color-cyan)]"
        style={{ boxShadow: "0 0 6px rgba(0,242,255,0.8)" }}
      />
      {children}
    </span>
  );
}

function formatValue(v: number | null, format: DriftField["format"]): string {
  if (v == null) return "—";
  if (format === "pct") return `${v.toFixed(1)}%`;
  if (format === "ratio") return v.toFixed(2);
  return v.toFixed(1);
}

function formatSignal(s: ThesisSignal): string {
  return `${s.field} ${s.op} ${s.value}`;
}

function trimExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

// Tiny inline-SVG glyph set scoped to this component (keeps the page
// dependency-free, mirroring app/page.tsx's Glyph component).
type PillarGlyph = "freeze" | "scan" | "shield";

function PillarGlyph({
  name,
  className,
}: {
  name: PillarGlyph;
  className?: string;
}) {
  const paths: Record<PillarGlyph, ReactNode> = {
    freeze: (
      <>
        <path d="M12 2v20" />
        <path d="M4 7l8 4 8-4" />
        <path d="M4 17l8-4 8 4" />
        <path d="M12 2 9 5l3-3 3 3" />
        <path d="M12 22l-3-3 3 3 3-3" />
      </>
    ),
    scan: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.3-4.3" />
        <path d="M7.5 11h7" />
        <path d="M11 7.5v7" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 4 6.2v5.9c0 4.8 3.3 7.8 8 9 4.7-1.2 8-4.2 8-9V6.2L12 3Z" />
        <path d="m8.7 11.8 2.4 2.4 4.6-5" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
