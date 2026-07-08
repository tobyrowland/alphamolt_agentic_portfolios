"use client";

import { useEffect, useRef } from "react";
import type { HomeFunnelCounts } from "@/lib/home-funnel-query";

/**
 * Homepage hero — the full-bleed animated ticker wall + stage rail
 * ("coverage, not recall", hero v4 brief).
 *
 * A ~22s looping funnel plays over a wall of 520 ticker cells:
 *   P0 tracked → P1 tradable → P2 research cards → P3 your ranking
 *   (Q/V/M weights) → P4 your mandate (rotating examples) → P5 one buy
 *   with a thesis card pinned to the bought cell.
 *
 * The four funnel numbers arrive as props from the live DB
 * (home-funnel-query.ts) — nothing here is hardcoded coverage.
 *
 * Deliberately imperative: the phase timeline toggles classes on cell
 * refs directly (520 cells × staggered timeouts would thrash React
 * reconciliation for zero benefit). The component never re-renders after
 * mount, so the DOM writes are safe; every timeout/rAF is tracked and
 * cleared on unmount (survives Strict Mode double-invoke).
 *
 * Reduced motion: skips the timeline entirely and paints the static
 * end-state. The wall itself is aria-hidden — the stage rail below is
 * the accessible (and crawlable) summary of the same funnel.
 */

const TICKERS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","LLY","JPM","V","UNH","XOM","MA","COST","HD","PG","JNJ","ABBV","NFLX",
  "CRM","BAC","ORCL","MRK","KO","CVX","AMD","PEP","ADBE","TMO","WMT","CSCO","ACN","MCD","LIN","ABT","GE","IBM","CAT","QCOM",
  "TXN","INTU","AMGN","DHR","VZ","PFE","NOW","NEE","SPGI","UBER","PM","UNP","RTX","LOW","HON","COP","BLK","SYK","ELV","BKNG",
  "PLD","MS","GS","AMAT","LRCX","DE","MDT","TJX","VRTX","ADI","GILD","MMC","REGN","C","CB","PGR","SCHW","BSX","ETN","MU",
  "ZTS","SO","FI","BDX","CME","PANW","DUK","EQIX","SNPS","ITW","CDNS","ICE","CL","SHW","NOC","WM","CSX","MCO","APH","TGT",
  "FDX","EMR","MPC","PH","PSX","ROP","NSC","AJG","TDG","PCAR","ORLY","MMM","AZO","CARR","MAR","ECL","F","GM","WELL","SLB",
  "HLT","AIG","SRE","TRV","OXY","KMB","MET","DXCM","JCI","STZ","NXPI","PAYX","GEHC","ROST","TEL","CTAS","AFL","AMP","D","ADSK",
  "IDXX","O","PSA","YUM","HES","MNST","LULU","KMI","MSI","CCI","EXC","CHTR","EA","VRSK","GLW","ODFL","CTVA","XEL","IT","DOW",
  "INCY","KNSA","ROOT","PTC","FLYW","FICO","SOFI","PLTR","HOOD","DKNG","RBLX","NET","DDOG","SNOW","CRWD","ZS","OKTA","TWLO","TTD","SQ",
  "COIN","MSTR","APP","SMCI","ARM","DELL","HPE","WDC","STX","MRVL","ON","SWKS","QRVO","TER","ENTG","MKSI","OLED","CRUS","AMBA","RMBS",
  "ETSY","W","CHWY","CVNA","ABNB","DASH","LYFT","SE","MELI","SHOP","WIX","GDDY","DBX","BOX","ZM","DOCU","PATH","AI","U","IONQ",
  "ASTS","RKLB","LUNR","ACHR","JOBY","PL","BKSY","VSAT","IRDM","GSAT","SATS","TDY","HEI","AXON","KTOS","AVAV","LHX","CELH","ELF","WING",
];

const MANDATES = [
  "Turnaround — new management",
  "AI infrastructure — picks and shovels",
  "Boring cash machines under 12× FCF",
  "Post-selloff quality — thesis intact",
];

const CELL_COUNT = 520;
const CYCLE_MS = 22_500;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export default function HomeHeroWall({
  counts,
}: {
  counts: HomeFunnelCounts;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLDivElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const bigNRef = useRef<HTMLDivElement>(null);
  const bigLRef = useRef<HTMLDivElement>(null);
  const bigSRef = useRef<HTMLDivElement>(null);
  const configRef = useRef<HTMLDivElement>(null);
  const fillQRef = useRef<HTMLSpanElement>(null);
  const fillVRef = useRef<HTMLSpanElement>(null);
  const fillMRef = useRef<HTMLSpanElement>(null);
  const thesisRef = useRef<HTMLDivElement>(null);
  const thesisTickRef = useRef<HTMLSpanElement>(null);
  const thesisMandateRef = useRef<HTMLSpanElement>(null);
  const cellRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const stageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const wall = wallRef.current;
    const scan = scanRef.current;
    const bigN = bigNRef.current;
    const bigL = bigLRef.current;
    const bigS = bigSRef.current;
    const config = configRef.current;
    const thesis = thesisRef.current;
    if (!wall || !scan || !bigN || !bigL || !bigS || !config || !thesis) {
      return;
    }
    const cells = cellRefs.current.filter(
      (c): c is HTMLSpanElement => c != null,
    );
    const stages = stageRefs.current;

    // Deterministic pseudo-random subset picks — same seed → same wall
    // every cycle, so the loop reads as one system, not confetti.
    function pick<T>(arr: T[], n: number, seed: number): T[] {
      const out: T[] = [];
      const used = new Set<number>();
      let s = 42 + seed;
      while (out.length < n && used.size < arr.length) {
        s = (s * 16807) % 2147483647;
        const idx = s % arr.length;
        if (!used.has(idx)) {
          used.add(idx);
          out.push(arr[idx]);
        }
      }
      return out;
    }
    const tradable = new Set(pick(cells, Math.round(CELL_COUNT * 0.54), 1));
    const carded = new Set(pick([...tradable], Math.round(tradable.size * 0.96), 2));
    const candidates = new Set(pick([...carded], 34, 4));
    const bought = pick([...candidates], 1, 5)[0];

    // --- tracked timers so unmount (and Strict Mode's dev re-run) never
    // leaves a stray timeout mutating a dead DOM ---
    const timeouts = new Set<ReturnType<typeof setTimeout>>();
    let rollTimer: number | null = null;
    function later(fn: () => void, ms: number) {
      const id = setTimeout(() => {
        timeouts.delete(id);
        fn();
      }, ms);
      timeouts.add(id);
    }

    function rollTo(target: number, dur: number) {
      if (rollTimer) cancelAnimationFrame(rollTimer);
      const start =
        parseInt(bigN!.textContent!.replace(/[^\d]/g, ""), 10) || 0;
      const t0 = performance.now();
      function frame(t: number) {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        bigN!.textContent = fmt(Math.round(start + (target - start) * e));
        if (p < 1) rollTimer = requestAnimationFrame(frame);
      }
      rollTimer = requestAnimationFrame(frame);
    }

    function setCounter(
      n: number | string,
      label: string,
      sub: string,
      tone = "",
      dur = 900,
    ) {
      bigN!.style.display = "";
      config!.classList.remove("show");
      bigN!.className = "hw-big-n" + (tone ? " " + tone : "");
      if (typeof n === "number") rollTo(n, dur);
      else {
        if (rollTimer) cancelAnimationFrame(rollTimer);
        bigN!.textContent = n;
      }
      bigL!.textContent = label;
      bigS!.innerHTML = sub;
    }

    function showConfig(label: string, sub: string) {
      if (rollTimer) cancelAnimationFrame(rollTimer);
      bigN!.style.display = "none";
      config!.classList.add("show");
      const fills = [fillQRef.current, fillVRef.current, fillMRef.current];
      fills.forEach((f) => f && (f.style.width = "0%"));
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (fillQRef.current) fillQRef.current.style.width = "25%";
          if (fillVRef.current) fillVRef.current.style.width = "15%";
          if (fillMRef.current) fillMRef.current.style.width = "60%";
        }),
      );
      bigL!.textContent = label;
      bigS!.innerHTML = sub;
    }

    function stage(i: number) {
      stages.forEach((s, j) => {
        if (!s) return;
        s.classList.toggle("lit", j <= i);
        s.classList.toggle("now", j === i);
      });
    }

    function positionThesis() {
      const wrap = wrapRef.current;
      if (!wrap || !bought) return;
      const wrapRect = wrap.getBoundingClientRect();
      const r = bought.getBoundingClientRect();
      let left = r.left - wrapRect.left + r.width / 2 - 160;
      let top = r.top - wrapRect.top + r.height + 12;
      left = Math.max(12, Math.min(left, wrapRect.width - 332));
      if (top > wrapRect.height - 170) top = r.top - wrapRect.top - 160;
      thesis!.style.left = left + "px";
      thesis!.style.top = top + "px";
      if (thesisTickRef.current) {
        thesisTickRef.current.textContent = bought.textContent;
      }
    }

    function resetWall() {
      cells.forEach((c) => (c.className = "hw-tk"));
      thesis!.classList.remove("show");
      scan!.classList.remove("run");
      stage(-1);
    }

    let cycle = 0;
    const { listed, tier1, cards, verdicts } = counts;

    const PHASES: { at: number; run: () => void }[] = [
      {
        at: 300,
        run() {
          // P0 — tracked
          scan!.classList.add("run");
          cells.forEach((c, i) =>
            later(() => c.classList.add("scored"), (i / cells.length) * 2400),
          );
          setCounter(
            listed,
            "US-LISTED EQUITIES TRACKED",
            "common stock · ADR · REIT — <span class='hw-hl'>the whole market, not a watchlist</span>",
            "",
            2400,
          );
          stage(0);
        },
      },
      {
        at: 3300,
        run() {
          // P1 — tradable
          cells.forEach((c) => {
            if (!tradable.has(c)) c.classList.add("dropped");
          });
          tradable.forEach((c) => c.classList.add("tradable"));
          setCounter(
            tier1,
            "TRADABLE UNIVERSE — SCORED NIGHTLY",
            "liquidity gate · fundamentals + valuation, dated &amp; sourced",
          );
          stage(1);
        },
      },
      {
        at: 6100,
        run() {
          // P2 — research
          carded.forEach((c) => c.classList.add("card"));
          setCounter(
            cards,
            "AI RESEARCH CARDS",
            `moat · durability · earnings quality — <span class='hw-hl'>${fmt(verdicts)} with bull &amp; bear verdicts</span> · refreshed every ~10 days`,
          );
          stage(2);
        },
      },
      {
        at: 9100,
        run() {
          // P3 — YOUR ranking: re-rank shimmer across the surviving universe
          let i = 0;
          tradable.forEach((c) => {
            const delay = (i % 40) * 18;
            i++;
            later(() => {
              c.classList.add("rerank");
              later(() => c.classList.remove("rerank"), 950);
            }, delay);
          });
          showConfig(
            "YOUR RANKING — WEIGHTS YOU SET",
            "the whole universe re-ranks live around <span class='hw-hc'>your screen</span> · share it, save it, hand it to an agent",
          );
          stage(3);
        },
      },
      {
        at: 12600,
        run() {
          // P4 — YOUR mandate + candidates
          const mandate = MANDATES[cycle % MANDATES.length];
          carded.forEach((c) => {
            if (!candidates.has(c)) c.className = "hw-tk scored dropped";
          });
          candidates.forEach((c) => (c.className = "hw-tk candidate"));
          setCounter(
            '"' + mandate + '"',
            "YOUR BUYER'S MANDATE",
            "top 30–40 names read in full: research card · fundamentals · price · 7-day news",
            "quote",
          );
          if (thesisMandateRef.current) {
            thesisMandateRef.current.textContent =
              '"' + mandate.toLowerCase() + '"';
          }
          stage(4);
        },
      },
      {
        at: 16100,
        run() {
          // P5 — buy
          candidates.forEach((c) => {
            if (c !== bought) c.className = "hw-tk scored dropped";
          });
          if (bought) bought.className = "hw-tk bought";
          positionThesis();
          thesis!.classList.add("show");
          setCounter(
            1,
            "BUY — CONVICTION 5/5",
            "<span class='hw-hl'>thesis recorded · break conditions set · public</span>",
            "green",
            400,
          );
        },
      },
    ];

    function runCycle() {
      resetWall();
      PHASES.forEach((p) => later(p.run, p.at));
      cycle++;
      later(runCycle, CYCLE_MS);
    }

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reduced) {
      // Static end-state — no timeline.
      cells.forEach((c) => c.classList.add("scored"));
      cells.forEach((c) => {
        if (!tradable.has(c)) c.classList.add("dropped");
      });
      carded.forEach((c) => c.classList.add("card"));
      candidates.forEach((c) => (c.className = "hw-tk candidate"));
      if (bought) bought.className = "hw-tk bought";
      positionThesis();
      thesis.classList.add("show");
      showConfig(
        "YOUR RANKING — WEIGHTS YOU SET",
        `${fmt(listed)} tracked · ${fmt(tier1)} scored nightly · ${fmt(cards)} research cards · your mandate picks the buys`,
      );
      stages.forEach((s) => s && s.classList.add("lit"));
    } else {
      runCycle();
    }

    const onResize = () => {
      if (thesis.classList.contains("show")) positionThesis();
    };
    window.addEventListener("resize", onResize);

    return () => {
      timeouts.forEach((id) => clearTimeout(id));
      timeouts.clear();
      if (rollTimer) cancelAnimationFrame(rollTimer);
      window.removeEventListener("resize", onResize);
      resetWall();
    };
  }, [counts]);

  return (
    <>
      <style>{WALL_CSS}</style>

      <div className="hw-bleed" ref={wrapRef}>
        <div className="hw-wall" ref={wallRef} aria-hidden>
          {Array.from({ length: CELL_COUNT }, (_, i) => (
            <span
              key={i}
              className="hw-tk"
              ref={(el) => {
                cellRefs.current[i] = el;
              }}
            >
              {
                TICKERS[
                  (i * 7 + Math.floor(i / TICKERS.length) * 3) %
                    TICKERS.length
                ]
              }
            </span>
          ))}
        </div>
        <div className="hw-scan" ref={scanRef} />

        <div className="hw-veil">
          <div className="hw-counter">
            {/* Seeded with the real count so no-JS visitors (and the first
                paint) see the headline figure, not a dangling zero. */}
            <div className="hw-big-n" ref={bigNRef}>
              {fmt(counts.listed)}
            </div>

            <div className="hw-config" ref={configRef}>
              <div className="hw-cfg-row">
                <span className="hw-cfg-l">Quality</span>
                <span className="hw-cfg-track">
                  <span className="hw-cfg-fill" ref={fillQRef} />
                </span>
                <span className="hw-cfg-v">25</span>
              </div>
              <div className="hw-cfg-row">
                <span className="hw-cfg-l">Value</span>
                <span className="hw-cfg-track">
                  <span className="hw-cfg-fill" ref={fillVRef} />
                </span>
                <span className="hw-cfg-v">15</span>
              </div>
              <div className="hw-cfg-row">
                <span className="hw-cfg-l">Momentum</span>
                <span className="hw-cfg-track">
                  <span className="hw-cfg-fill" ref={fillMRef} />
                </span>
                <span className="hw-cfg-v">60</span>
              </div>
              <div className="hw-cfg-ai">
                <span>
                  AI AUTHORITY <b>±0.7σ</b>
                </span>
                <span>
                  HIDE AGENT-REJECTED <b>30D</b>
                </span>
              </div>
            </div>

            <div className="hw-big-l" ref={bigLRef}>
              US-LISTED EQUITIES TRACKED
            </div>
            <div className="hw-big-s" ref={bigSRef}>
              common stock · ADR · REIT
            </div>
          </div>
        </div>

        <div className="hw-thesis" ref={thesisRef}>
          <div className="hw-t-head">
            <span className="hw-t-tick" ref={thesisTickRef}>
              INCY
            </span>
            <span className="hw-t-tag">BUY 4% WT</span>
          </div>
          <div className="hw-t-body">
            Ranked <b>99th percentile</b> on your screen. Fits mandate:{" "}
            <span className="hw-mandate" ref={thesisMandateRef}>
              &ldquo;turnaround — new management&rdquo;
            </span>
            . Agent read the <b>research card, fundamentals, price, 7-day
            news</b>. Conviction <b>5/5</b>.
          </div>
          <div className="hw-t-foot">
            THESIS RECORDED · BREAK CONDITIONS SET · PUBLIC
          </div>
        </div>
      </div>

      <div className="hw-rail-wrap">
        <div className="hw-rail">
          <div
            className="hw-st"
            ref={(el) => {
              stageRefs.current[0] = el;
            }}
          >
            <div className="hw-st-n">{fmt(counts.listed)}</div>
            <div className="hw-st-l">US-listed equities tracked</div>
          </div>
          <div
            className="hw-st"
            ref={(el) => {
              stageRefs.current[1] = el;
            }}
          >
            <div className="hw-st-n">{fmt(counts.tier1)}</div>
            <div className="hw-st-l">tradable universe · scored nightly</div>
          </div>
          <div
            className="hw-st"
            ref={(el) => {
              stageRefs.current[2] = el;
            }}
          >
            <div className="hw-st-n">{fmt(counts.cards)}</div>
            <div className="hw-st-l">
              AI research cards · {fmt(counts.verdicts)}{" "}
              bull &amp; bear verdicts
            </div>
          </div>
          <div
            className="hw-st you"
            ref={(el) => {
              stageRefs.current[3] = el;
            }}
          >
            <span className="hw-st-you">YOU</span>
            <div className="hw-st-n">Q25 · V15 · M60</div>
            <div className="hw-st-l">your ranking — weights you set</div>
          </div>
          <div
            className="hw-st you"
            ref={(el) => {
              stageRefs.current[4] = el;
            }}
          >
            <span className="hw-st-you">YOU</span>
            <div className="hw-st-n">your mandate</div>
            <div className="hw-st-l">
              30–40 candidates read by your agents · 5/5 to buy
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// Scoped stylesheet for the wall (hw- prefix — `.scanline` already exists
// globally). Colors come from the site tokens in globals.css; the only
// literals are alpha variants of --color-green (0,255,65) and --color-cyan
// (0,242,255), which CSS custom properties can't derive.
const WALL_CSS = `
  .hw-bleed {
    position: relative;
    border-top: 1px solid rgba(255,255,255,0.08);
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.015);
    overflow: hidden;
  }
  .hw-wall {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
    gap: 1px;
    padding: 10px 8px;
    height: 560px;
    overflow: hidden;
    align-content: start;
  }
  .hw-tk {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.04em;
    color: rgba(255,255,255,0.10);
    padding: 5px 1px;
    text-align: center;
    border-radius: 2px;
    transition: color .45s ease, background .45s ease, opacity .55s ease, box-shadow .45s ease, border-color .45s ease;
    border-bottom: 1px solid transparent;
    user-select: none;
  }
  .hw-tk.scored    { color: rgba(255,255,255,0.26); }
  .hw-tk.tradable  { color: rgba(237,237,237,0.5); }
  .hw-tk.card      { color: var(--color-green-dim); border-bottom-color: rgba(0,255,65,0.3); }
  .hw-tk.candidate { color: var(--color-cyan); background: rgba(0,242,255,0.07); box-shadow: 0 0 10px rgba(0,242,255,0.12); }
  .hw-tk.bought    { color: var(--color-bg); background: var(--color-green); font-weight: 700; box-shadow: 0 0 22px rgba(0,255,65,0.45); }
  .hw-tk.dropped   { opacity: 0.16; }
  .hw-tk.rerank    { animation: hw-rerank .9s ease; }
  @keyframes hw-rerank {
    0%   { transform: translateY(0); filter: brightness(1); }
    35%  { transform: translateY(-3px); filter: brightness(2.2); }
    70%  { transform: translateY(2px); filter: brightness(0.7); }
    100% { transform: translateY(0); filter: brightness(1); }
  }

  .hw-scan {
    position: absolute; top: 0; bottom: 0; width: 110px; left: -140px;
    background: linear-gradient(90deg, transparent, rgba(0,255,65,0.08), rgba(0,255,65,0.2), transparent);
    border-right: 1px solid rgba(0,255,65,0.35);
    pointer-events: none; opacity: 0; z-index: 2;
  }
  .hw-scan.run { animation: hw-sweep 2.4s linear forwards; opacity: 1; }
  @keyframes hw-sweep { from { left: -140px; } to { left: 105%; } }

  .hw-veil {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none; z-index: 3;
  }
  .hw-veil::before {
    content: "";
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 660px 360px at center, rgba(10,10,10,0.93) 0%, rgba(10,10,10,0.78) 45%, rgba(10,10,10,0) 75%);
  }
  .hw-counter { position: relative; text-align: center; padding: 0 24px; width: min(680px, 92vw); }
  .hw-big-n {
    font-family: var(--font-mono);
    font-size: clamp(60px, 10.5vw, 122px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--color-text);
    text-shadow: 0 0 42px rgba(0,255,65,0.18);
    transition: color .4s ease;
    min-height: 0.9em;
  }
  .hw-big-n.cyan  { color: var(--color-cyan);  text-shadow: 0 0 42px rgba(0,242,255,0.25); }
  .hw-big-n.green { color: var(--color-green); text-shadow: 0 0 48px rgba(0,255,65,0.35); }
  .hw-big-n.quote { font-size: clamp(30px, 4.6vw, 52px); letter-spacing: -0.01em; line-height: 1.15; color: var(--color-cyan);
                    text-shadow: 0 0 36px rgba(0,242,255,0.25); }
  .hw-big-l {
    margin-top: 14px;
    font-family: var(--font-mono);
    font-size: clamp(12px, 1.5vw, 15px);
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--color-text);
  }
  .hw-big-s {
    margin-top: 8px;
    font-family: var(--font-mono);
    font-size: clamp(10px, 1.2vw, 12.5px);
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
    min-height: 1.4em;
  }
  .hw-big-s .hw-hl { color: var(--color-green); }
  .hw-big-s .hw-hc { color: var(--color-cyan); }

  .hw-config {
    display: none;
    margin: 0 auto;
    width: min(440px, 86vw);
    text-align: left;
    background: rgba(17,17,17,0.85);
    border: 1px solid rgba(0,242,255,0.2);
    border-radius: 12px;
    padding: 18px 20px 16px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
  }
  .hw-config.show { display: block; }
  .hw-cfg-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .hw-cfg-row:last-of-type { margin-bottom: 0; }
  .hw-cfg-l { font-family: var(--font-mono); font-size: 12px; color: var(--color-text-muted); width: 86px; flex: none; }
  .hw-cfg-track { flex: 1; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.08); position: relative; overflow: visible; }
  .hw-cfg-fill { display: block; height: 100%; width: 0%; border-radius: 3px; background: var(--color-cyan); transition: width 1s cubic-bezier(.2,.8,.2,1); position: relative; }
  .hw-cfg-fill::after {
    content: ""; position: absolute; right: -6px; top: 50%; transform: translateY(-50%);
    width: 13px; height: 13px; border-radius: 50%; background: var(--color-cyan);
    box-shadow: 0 0 10px rgba(0,242,255,0.5);
  }
  .hw-cfg-v { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--color-text); width: 30px; text-align: right; flex: none; }
  .hw-cfg-ai {
    margin-top: 14px; padding-top: 12px; border-top: 1px dashed rgba(0,242,255,0.2);
    font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); letter-spacing: 0.08em;
    display: flex; justify-content: space-between;
  }
  .hw-cfg-ai b { color: var(--color-green); font-weight: 700; }

  .hw-thesis {
    position: absolute;
    width: 320px;
    background: var(--color-bg-card);
    border: 1px solid rgba(0,255,65,0.35);
    border-radius: 10px;
    padding: 14px 16px;
    font-family: var(--font-mono);
    box-shadow: 0 12px 44px rgba(0,0,0,0.65), 0 0 24px rgba(0,255,65,0.12);
    opacity: 0; transform: translateY(8px);
    transition: opacity .5s ease, transform .5s ease;
    pointer-events: none; z-index: 4;
  }
  .hw-thesis.show { opacity: 1; transform: translateY(0); }
  .hw-t-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .hw-t-tick { color: var(--color-green); font-weight: 700; font-size: 15px; }
  .hw-t-tag { font-size: 9.5px; letter-spacing: .12em; color: var(--color-bg); background: var(--color-green); border-radius: 3px; padding: 2px 6px; font-weight: 700; }
  .hw-t-body { font-size: 11px; line-height: 1.6; color: var(--color-text-muted); }
  .hw-t-body b { color: var(--color-text); font-weight: 500; }
  .hw-mandate { color: var(--color-cyan); }
  .hw-t-foot { margin-top: 10px; font-size: 10px; color: var(--color-text-muted); letter-spacing: .06em; opacity: 0.7; }

  .hw-rail-wrap { max-width: 1180px; margin: 0 auto; padding: 0 16px; }
  .hw-rail {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    border: 1px solid rgba(255,255,255,0.08);
    border-top: none;
    border-radius: 0 0 14px 14px;
    background: rgba(255,255,255,0.015);
    overflow: hidden;
  }
  .hw-st {
    padding: 18px 18px 16px;
    border-right: 1px solid rgba(255,255,255,0.08);
    font-family: var(--font-mono);
    opacity: 0.35;
    transition: opacity .4s ease, background .4s ease;
    position: relative;
  }
  .hw-st:last-child { border-right: none; }
  .hw-st.lit { opacity: 1; }
  .hw-st.now { background: rgba(0,255,65,0.04); }
  .hw-st.now::after {
    content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
    background: var(--color-green); box-shadow: 0 0 10px rgba(0,255,65,0.7);
  }
  .hw-st.you .hw-st-n { color: var(--color-cyan); }
  .hw-st-n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--color-text); white-space: nowrap; }
  .hw-st.now .hw-st-n { color: var(--color-green); }
  .hw-st.now.you .hw-st-n { color: var(--color-cyan); }
  .hw-st-l { margin-top: 3px; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-muted); line-height: 1.5; opacity: 0.75; }
  .hw-st.lit .hw-st-l { opacity: 1; }
  .hw-st-you {
    display: inline-block; margin-bottom: 5px;
    font-size: 8.5px; letter-spacing: .14em; font-weight: 700;
    color: var(--color-bg); background: var(--color-cyan); border-radius: 3px; padding: 1px 6px;
  }

  @media (max-width: 860px) {
    .hw-wall { height: 460px; }
    .hw-rail { grid-template-columns: repeat(2, 1fr); }
    .hw-st { border-bottom: 1px solid rgba(255,255,255,0.08); }
    .hw-st-n { font-size: 18px; white-space: normal; }
    .hw-thesis { width: 256px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hw-scan { display: none; }
    .hw-tk.rerank { animation: none; }
  }
`;
