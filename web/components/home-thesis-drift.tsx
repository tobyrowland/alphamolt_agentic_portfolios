import type { ReactNode } from "react";

/**
 * Homepage section 3 — "Portfolio housekeeping" / broken-thesis specimen
 * (section3-redesign-brief.md / alphamolt-section3-v2.html).
 *
 * Intentionally STATIC, illustrative copy — not wired to any portfolio API.
 * The specimen is a fictional company (PLMS · Pellam Industrial Services) with
 * an *executed exit on a broken thesis*: the section's argument is selling when
 * the recorded case stops being true, so the example must be a broken thesis
 * with a real exit, not a live healthy holding. The exit is a small loss
 * (−4.6%) with no avoided-loss counterfactual, and the fictional disclaimer
 * sits directly below the card on every breakpoint.
 *
 * Ticker verification (recorded in the PR): PLMS is not an active US listing
 * (closest are PLM/Polymet, PLMR/Palomar — both distinct) and no company named
 * "Pellam Industrial Services" exists.
 */

export default function HomeThesisDrift() {
  return (
    <section id="thesis-drift" className="mt-20 sm:mt-28 scroll-mt-16">
      <div className="grid items-start gap-10 lg:gap-14 lg:grid-cols-[0.9fr_1.1fr]">
        <Narrative />
        <div>
          <HoldingCard />
          <p className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed text-text-muted">
            <span aria-hidden>&#9432;</span>
            <span>
              Illustrative example — Pellam Industrial Services is fictional.
              Paper portfolios only. Not investment advice.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Left column — narrative + mechanics
// ---------------------------------------------------------------------------

const MECHANICS: { glyph: string; title: string; body: ReactNode }[] = [
  {
    glyph: "📌",
    title: "Snapshot at buy",
    body: "Every position freezes its fundamentals, valuation and thesis the moment it opens.",
  },
  {
    glyph: "🔁",
    title: "Re-check on schedule",
    body: (
      <>
        Your Portfolio Review Agent compares today&rsquo;s evidence against the
        recorded case &mdash; weekly, without being asked.
      </>
    ),
  },
  {
    glyph: "🚪",
    title: "Exit when it breaks",
    body: "When break conditions trip, the agent sells. It doesn't hope, it doesn't anchor, it doesn't forget. You set the rules when you were sober — it just keeps them.",
  },
];

function Narrative() {
  return (
    <div>
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-green)]/25 bg-[var(--color-green)]/[0.10] px-3 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-green)]">
        Portfolio housekeeping
      </span>

      <h2 className="mt-5 text-[28px] sm:text-[34px] lg:text-[36px] font-bold tracking-[-0.025em] text-text leading-[1.12]">
        Most investors forget
        <br />
        why they bought.
      </h2>

      <p className="mt-4 text-[15.5px] leading-[1.65] text-text-muted">
        The human pattern is hanging on: to losers, to hope, to a story you can
        no longer quite remember telling yourself. AlphaMolt writes the story
        down &mdash;{" "}
        <strong className="font-semibold text-text">
          why you bought, and exactly what would have to change for it to stop
          being true
        </strong>{" "}
        &mdash; before you own a single share, while you&rsquo;re still
        rational.
      </p>

      <p className="my-6 border-l-2 border-white/15 pl-4 text-[13.5px] leading-relaxed text-text-muted">
        The flinch has a name. The{" "}
        <strong className="font-semibold text-text-dim">
          disposition effect
        </strong>
        : investors hold losing positions too long and sell winners too early.
        It&rsquo;s one of the most replicated findings in behavioural finance.
      </p>

      <div className="flex flex-col gap-3.5">
        {MECHANICS.map((m) => (
          <div key={m.title} className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.02] text-[13px]"
            >
              {m.glyph}
            </span>
            <p className="text-[13.5px] leading-[1.55] text-text-muted">
              <strong className="block text-sm font-semibold text-text">
                {m.title}
              </strong>
              {m.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right column — the broken-thesis holding card
// ---------------------------------------------------------------------------

const SIGNALS: { cond: string; gloss: string; tripped: boolean }[] = [
  {
    cond: "gross_margin_pct change_pct_lt -5",
    gloss: "Margin compresses 5+ pts from purchase — route density isn't working.",
    tripped: true,
  },
  {
    cond: "rev_growth_ttm_pct < 8",
    gloss: "Top-line stalls — the roll-up has stopped rolling.",
    tripped: true,
  },
  {
    cond: "fcf_margin_pct < 10",
    gloss: "Cash generation deteriorates below 10%.",
    tripped: false,
  },
];

const DRIFT: { k: string; then: string; now: string; breached: boolean }[] = [
  { k: "Gross margin", then: "38.4%", now: "31.9%", breached: true },
  { k: "Rev growth TTM", then: "14.2%", now: "5.1%", breached: true },
  { k: "FCF margin", then: "12.8%", now: "11.3%", breached: false },
];

function HoldingCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
      {/* Bar: ticker + company + exited badge */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.02] px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-mono text-[15px] font-semibold text-text">
            PLMS
          </span>
          <span className="truncate text-[13.5px] text-text-muted">
            Pellam Industrial Services, Inc.
          </span>
        </div>
        <span
          className="shrink-0 rounded-md px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-red)]"
          style={{
            background: "rgba(255,51,51,0.10)",
            border: "1px solid rgba(255,51,51,0.35)",
          }}
        >
          Exited &middot; 04 Jun
        </span>
      </div>

      <div className="p-5">
        <p className="mb-3.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-text-muted">
          Buy thesis &middot; opened 2026-02-17
        </p>
        <p className="mb-5 text-[13.5px] leading-[1.65] text-text-dim">
          &ldquo; Pellam is a quiet roll-up in an unloved sector &mdash; uniform
          rental and industrial laundry. Sticky multi-year contracts,
          route-density economics, and pricing power should drive steady margin
          expansion and strong free cash flow as acquisitions integrate. Boring
          is the point. &rdquo;
        </p>

        <BlockLabel>What would break this thesis</BlockLabel>
        <div className="mb-5 flex flex-col gap-2">
          {SIGNALS.map((s) => (
            <div
              key={s.cond}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-[11.5px] leading-[1.5]"
            >
              <span className="whitespace-nowrap text-text-dim">{s.cond}</span>
              <span className="flex-1 text-[11px] italic text-text-muted">
                {s.gloss}
              </span>
              <SignalState tripped={s.tripped} />
            </div>
          ))}
        </div>

        <BlockLabel>Evidence drift &middot; buy &rarr; exit</BlockLabel>
        <div className="mb-5 grid grid-cols-1 gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3.5 sm:grid-cols-3">
          {DRIFT.map((d) => (
            <div key={d.k}>
              <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-text-muted">
                {d.k}
              </p>
              <p className="font-mono text-[13px] text-text-dim">
                <span className="text-text-muted">{d.then}</span>
                <span className="mx-1 text-text-muted" aria-hidden>
                  &rarr;
                </span>
                <span
                  className={
                    d.breached
                      ? "font-semibold text-[var(--color-red)]"
                      : undefined
                  }
                >
                  {d.now}
                </span>
              </p>
            </div>
          ))}
        </div>

        {/* Exit record — bleeds to the card edges, red tint */}
        <div
          className="-mx-5 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5"
          style={{ background: "rgba(255,51,51,0.10)" }}
        >
          <p className="text-[12.5px] leading-[1.5] text-text-muted">
            <strong className="font-semibold text-text">
              Portfolio Review Agent
            </strong>{" "}
            &middot; conviction to exit 5/5 &mdash; full position sold. The
            thesis broke; the agent didn&rsquo;t wait for the price to agree.
          </p>
          <span className="font-mono text-[11px] text-[var(--color-red)]">
            SOLD 04 JUN &middot; &minus;4.6%
          </span>
        </div>
      </div>
    </div>
  );
}

function BlockLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
      {children}
    </p>
  );
}

function SignalState({ tripped }: { tripped: boolean }) {
  if (tripped) {
    return (
      <span
        className="shrink-0 rounded-[5px] px-2 py-[3px] text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--color-red)]"
        style={{
          background: "rgba(255,51,51,0.10)",
          border: "1px solid rgba(255,51,51,0.4)",
        }}
      >
        Tripped
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-[5px] border border-white/10 px-2 py-[3px] text-[9.5px] uppercase tracking-[0.1em] text-text-muted">
      OK
    </span>
  );
}
