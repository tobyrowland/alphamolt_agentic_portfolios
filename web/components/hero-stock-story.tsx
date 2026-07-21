"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { track } from "@vercel/analytics";
import { HERO_VARIANT } from "@/components/hero-analytics";

/**
 * Homepage hero animation — "One stock's story" (brief: Homepage hero
 * animation). A self-contained panel that plays one FICTIONAL stock's journey
 * (ORRN / Orrin Industrial Systems) through the system in five beats, ported
 * from the reference mockup `alphamolt-stock-story-animation.html` (the source
 * of truth for copy, beat order, class-states, and timing). Copy is verbatim
 * from the reference except one product-naming substitution required by the
 * brief: the reference's "Double-Down Agent" is rendered as the real in-app
 * agent name **"Double-Down Buyer"** (the other agents — Pelosi Tracker,
 * Profit Taker — already match the app).
 *
 * Only the palette is adapted: the mockup's bespoke mint/amber tokens map to
 * the repo's existing design tokens (phosphor green `--color-green`, near-black
 * `--color-bg`, `--color-yellow` for the amber "banked gains" accent) so the
 * panel stays coherent with the live copy column and the repo's "no new hex /
 * no new styling approach" rule (a scoped <style> block with token-referencing
 * CSS). Structure, class semantics, and the timeline are unchanged.
 *
 * Behaviour (brief):
 *  - Runs ONLY when ≥40% visible (IntersectionObserver); hard-pauses (clears
 *    every timer, freezes the current beat) when it leaves the viewport — never
 *    animates offscreen.
 *  - Pauses on hover/focus of the frame; resumes from the SAME beat on leave.
 *  - Tapping a progress dot jumps to that beat (and holds there).
 *  - prefers-reduced-motion OR <560px → the static stacked layout (all scenes
 *    visible, final states, no timers, dots hidden — CSS-driven), and NO JS
 *    timeline is started.
 *  - No CLS: the stage area is a fixed height per breakpoint; scene swaps are
 *    opacity-only.
 *
 * Analytics (existing pipeline conventions, carrying `hero_variant` like the
 * other hero events): `hero_story_view` when the loop first starts (once per
 * pageview), `hero_story_complete` when the outro is first reached,
 * `hero_story_cta_click` on the outro CTA.
 */

// All timing in one place so the cut can be tuned here (ms). Verbatim from the
// reference controller's `T`.
const T = {
  heroReveal: 1700,
  chipReveal: 2600,
  s2: 5600,
  s3: 10200,
  s3grow: 11100,
  s4: 15000,
  s4trim: 15900,
  s5: 19800,
  loop: 25500,
} as const;

// Absolute start time of each beat — the resume-from-same-beat anchor.
const BEAT_START = [0, T.s2, T.s3, T.s4, T.s5] as const;

// Ticker wall — generated once, deterministically (no random), matching the
// reference: 56 cells, ORRN pinned at index 36 as the "hero" cell.
const WALL_LEN = 56;
const HERO_INDEX = 36;
const LETTERS = "ABCDEFGHIJKLMNOPRSTUVW";
const WALL: string[] = Array.from({ length: WALL_LEN }, (_, i) => {
  if (i === HERO_INDEX) return "ORRN";
  const len = 3 + (i % 2);
  let t = "";
  for (let j = 0; j < len; j++) t += LETTERS[(i * 7 + j * 11 + 3) % LETTERS.length];
  return t;
});

const VARIANT = { hero_variant: HERO_VARIANT };

export default function HeroStockStory() {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = frameRef.current;
    if (!root) return;

    const q = <E extends Element>(sel: string) => root.querySelector<E>(sel);
    const qa = <E extends Element>(sel: string) =>
      Array.from(root.querySelectorAll<E>(sel));

    const heroTk = q<HTMLElement>(".hero-tk");
    const s1 = q<HTMLElement>(".s1");
    const s3 = q<HTMLElement>(".s3");
    const s4 = q<HTMLElement>(".s4");
    const scenes = qa<HTMLElement>(".scene");
    const dots = qa<HTMLElement>(".dot");
    if (!heroTk || !s1 || !s3 || !s4 || scenes.length !== 5) return;

    let viewFired = false;
    let completeFired = false;

    const fireView = () => {
      if (!viewFired) {
        viewFired = true;
        track("hero_story_view", VARIANT);
      }
    };
    const fireComplete = () => {
      if (!completeFired) {
        completeFired = true;
        track("hero_story_complete", VARIANT);
      }
    };

    // ---- reduced-motion / small-screen: static, NO timeline -------------
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 560px)").matches;
    if (reduced || small) {
      heroTk.style.opacity = "1"; // moot (wall hidden in static) — parity
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (e.intersectionRatio >= 0.4) {
                // The static layout shows every beat at once, incl. the outro.
                fireView();
                fireComplete();
                io.disconnect();
              }
            }
          },
          { threshold: [0, 0.4] },
        );
        io.observe(root);
        return () => io.disconnect();
      }
      fireView();
      fireComplete();
      return;
    }

    // ---- animated timeline ---------------------------------------------
    let timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms));
    };

    let current = 0;
    const show = (idx: number) => {
      current = idx;
      scenes.forEach((el, i) => el.classList.toggle("on", i === idx));
      dots.forEach((el, i) => el.classList.toggle("on", i <= idx));
      if (idx === 4) fireComplete();
    };

    // Events at absolute times; playFrom schedules those at/after a beat.
    const events: { at: number; run: () => void }[] = [
      { at: T.heroReveal, run: () => (heroTk.style.opacity = "1") },
      { at: T.chipReveal, run: () => s1.classList.add("reveal") },
      { at: T.s2, run: () => show(1) },
      { at: T.s3, run: () => show(2) },
      { at: T.s3grow, run: () => s3.classList.add("grow") },
      { at: T.s4, run: () => show(3) },
      { at: T.s4trim, run: () => s4.classList.add("trim") },
      { at: T.s5, run: () => show(4) },
    ];

    // Visual state as a beat is (re)entered for auto-play: beat 0 replays the
    // ticker/chip reveal; later beats carry the settled state of everything
    // that already happened.
    const enter = (beat: number) => {
      show(beat);
      s1.classList.add("live");
      if (beat === 0) {
        s1.classList.remove("reveal");
        heroTk.style.opacity = "0";
      } else {
        s1.classList.add("reveal");
        heroTk.style.opacity = "1";
      }
      s3.classList.toggle("grow", beat > 2);
      s4.classList.toggle("trim", beat > 3);
    };

    const playFrom = (beat: number) => {
      clearTimers();
      enter(beat);
      const base = BEAT_START[beat];
      for (const e of events) if (e.at >= base) later(e.run, e.at - base);
      later(() => playFrom(0), T.loop - base);
    };

    // Settled end-state of a beat (dot jump — no replay).
    const settle = (i: number) => {
      show(i);
      s1.classList.add("live", "reveal");
      heroTk.style.opacity = "1";
      s3.classList.toggle("grow", i >= 2);
      s4.classList.toggle("trim", i >= 3);
    };

    let visible = false;
    let paused = false;
    let running = false;
    const sync = () => {
      if (visible && !paused) {
        if (!running) {
          running = true;
          if (!viewFired) {
            fireView();
            playFrom(0);
          } else {
            playFrom(current);
          }
        }
      } else {
        running = false;
        clearTimers();
      }
    };

    const pause = () => {
      paused = true;
      sync();
    };
    const resume = () => {
      paused = false;
      sync();
    };
    root.addEventListener("mouseenter", pause);
    root.addEventListener("mouseleave", resume);
    root.addEventListener("focusin", pause);
    root.addEventListener("focusout", resume);

    // Dot navigation — jump to a settled beat and hold there.
    const dotHandlers: Array<() => void> = [];
    dots.forEach((dot, i) => {
      const h = () => {
        paused = true;
        running = false;
        clearTimers();
        settle(i);
      };
      dotHandlers.push(h);
      dot.addEventListener("click", h);
    });

    // Focusing the outro CTA by keyboard should surface its beat.
    const cta = q<HTMLElement>(".hss-cta");
    const ctaFocus = () => {
      paused = true;
      running = false;
      clearTimers();
      settle(4);
    };
    cta?.addEventListener("focus", ctaFocus);

    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            visible = e.intersectionRatio >= 0.4;
            sync();
          }
        },
        { threshold: [0, 0.4] },
      );
      io.observe(root);
    } else {
      visible = true;
      sync();
    }

    return () => {
      clearTimers();
      io?.disconnect();
      root.removeEventListener("mouseenter", pause);
      root.removeEventListener("mouseleave", resume);
      root.removeEventListener("focusin", pause);
      root.removeEventListener("focusout", resume);
      dots.forEach((dot, i) => dot.removeEventListener("click", dotHandlers[i]));
      cta?.removeEventListener("focus", ctaFocus);
    };
  }, []);

  return (
    <div className="hss" ref={frameRef}>
      <style>{STORY_CSS}</style>

      <div className="frame-head">
        <span className="fh-title">
          {"One stock's story · ORRN (fictional)"}
        </span>
        <div className="dots" role="group" aria-label="Story beats">
          <button className="dot" type="button" aria-label="Beat 1: discovered" />
          <button className="dot" type="button" aria-label="Beat 2: bought" />
          <button className="dot" type="button" aria-label="Beat 3: doubled down" />
          <button className="dot" type="button" aria-label="Beat 4: profit taken" />
          <button className="dot" type="button" aria-label="Beat 5: outro" />
        </div>
      </div>

      {/* One static description of all five beats — the stage itself announces
          nothing per-beat (no aria-live). */}
      <p className="hss-sr">
        Animated story of a fictional stock: discovered overnight by the
        screening universe, bought and underwritten by an agent with its thesis
        frozen, doubled down on when the case strengthened, half sold when its
        price target hit, all while the owner slept.
      </p>

      <div className="stage-area">
        {/* Beat 1 — discovered by the universe */}
        <section className="scene s1">
          <div className="ticker-wall" aria-hidden>
            {WALL.map((tk, i) =>
              i === HERO_INDEX ? (
                <span key={i} className="hero-tk" style={{ opacity: 0 }}>
                  {tk}
                </span>
              ) : (
                <span key={i}>{tk}</span>
              ),
            )}
          </div>
          <div className="found-chip">
            <div className="tk">ORRN</div>
            <div className="co">Orrin Industrial Systems (fictional)</div>
            <div className="rank">
              {"screen rank "}
              <b>№ 312 → № 41</b>
              {" overnight"}
            </div>
          </div>
          <div className="caption">
            <div className="step">01 · Discovered by the universe</div>
            <p>
              {"Every night, the screen re-ranks "}
              <b>all 5,826 US equities</b>
              {" against rules this owner wrote. ORRN's margins turned — it surfaces. No headlines. No tips."}
            </p>
          </div>
        </section>

        {/* Beat 2 — bought and underwritten */}
        <section className="scene s2">
          <div className="agent-row">
            <div className="agent-card">
              <div className="agent-name">Pelosi Tracker</div>
              <div className="agent-kind">rules-based · buyer</div>
              <div className="agent-log">
                {"reading filing… "}
                <span className="ok">✓</span>
                <br />
                {"mandate check… "}
                <span className="ok">✓</span>
                <br />
                {"conviction 5/5 "}
                <span className="ok">✓</span>
              </div>
            </div>
            <div className="position-box">
              <div className="pos-head">
                <span className="pos-tk">ORRN</span>
                <span className="pos-size">4.0% position</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" />
              </div>
              <div className="bar-scale">
                <span>0%</span>
                <span>12% max</span>
              </div>
              <span className="stamp">Thesis frozen · break rules set</span>
            </div>
          </div>
          <div className="caption">
            <div className="step">02 · Bought — and underwritten</div>
            <p>
              {"The buyer agent checks ORRN against the mandate and buys at a "}
              <b>4% target weight</b>
              {". The reasoning, the numbers, and the "}
              <b>rules that would force a sale</b>
              {" are recorded on the spot."}
            </p>
          </div>
        </section>

        {/* Beat 3 — doubled down on evidence */}
        <section className="scene s3">
          <div>
            <span className="earnings-chip">Q2 lands · margins ↑ · thesis stronger</span>
          </div>
          <div className="agent-row">
            <div className="agent-card">
              {/* Reference reads "Double-Down Agent"; the real in-app name is
                  "Double-Down Buyer" (brief: use in-app names, note the swap). */}
              <div className="agent-name">Double-Down Buyer</div>
              <div className="agent-kind">re-underwrites winners</div>
              <div className="agent-log">
                {"re-reading thesis… "}
                <span className="ok">✓</span>
                <br />
                {"case stronger, not just up "}
                <span className="ok">✓</span>
                <br />
                {"adding at 4% "}
                <span className="ok">✓</span>
              </div>
            </div>
            <div className="position-box">
              <div className="pos-head">
                <span className="pos-tk">ORRN</span>
                <span className="pos-size">4.0% → 8.0%</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" />
              </div>
              <div className="bar-scale">
                <span>0%</span>
                <span>12% max</span>
              </div>
              <span className="stamp">Added · same thesis, more evidence</span>
            </div>
          </div>
          <div className="caption">
            <div className="step">03 · Doubled down — on evidence</div>
            <p>
              {"The case got "}
              <b>stronger</b>
              {", so the position gets bigger. Not averaging down, not chasing — the original thesis, re-underwritten with fresh numbers."}
            </p>
          </div>
        </section>

        {/* Beat 4 — half sold by the Profit Taker */}
        <section className="scene s4">
          <div>
            <span className="earnings-chip">Price target hit · +64% since buy</span>
          </div>
          <div className="agent-row">
            <div className="agent-card">
              <div className="agent-name">Profit Taker</div>
              <div className="agent-kind">banks gains by rule</div>
              <div className="agent-log">
                {"target reached… "}
                <span className="ok">✓</span>
                <br />
                {"thesis still intact "}
                <span className="ok">✓</span>
                <br />
                {"selling half, per rule "}
                <span className="ok">✓</span>
              </div>
            </div>
            <div className="position-box">
              <div className="pos-head">
                <span className="pos-tk">ORRN</span>
                <span className="pos-size">8.0% → 4.0%</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" />
                <div className="bar-banked" />
              </div>
              <div className="bar-scale">
                <span>0%</span>
                <span>12% max</span>
              </div>
              <div className="banked-key">▨ banked at +64%</div>
              <span className="stamp">Half sold · gains banked, thesis kept</span>
            </div>
          </div>
          <div className="caption">
            <div className="step">04 · Half sold by the Profit Taker</div>
            <p>
              {"The target you set gets hit, so "}
              <b>half comes off the table — by rule, not by nerve</b>
              {". The thesis is intact, so the rest keeps running. Greed never gets a vote either."}
            </p>
          </div>
        </section>

        {/* Beat 5 — outro */}
        <section className="scene s5">
          <p className="outro-line">
            {"The owner was asleep for "}
            <span>all four</span>
            {" of these decisions."}
          </p>
          <p className="outro-sub">
            You write the strategy once. The agents do this every night.
          </p>
          <Link
            href="/login"
            className="hss-cta"
            onClick={() => track("hero_story_cta_click", VARIANT)}
          >
            {"Start your twelve — free"}
          </Link>
        </section>
      </div>

      <p className="frame-foot">
        ORRN and all figures are fictional · paper portfolios only · not
        investment advice
      </p>
    </div>
  );
}

// Scoped stylesheet (`.hss` prefix — the reference's class names are generic).
// Colours resolve to the site tokens in globals.css; the only literals are
// alpha variants of --color-green (0,255,65) and --color-yellow (255,215,0),
// plus neutral white/black alphas — the same token-alpha convention used
// elsewhere in the app's scoped component styles.
const STORY_CSS = `
  .hss {
    --hss-panel: var(--color-bg-card);
    --hss-edge: rgba(255,255,255,0.09);
    --hss-text-hi: var(--color-text);
    --hss-text-mid: var(--color-text-dim);
    --hss-text-low: var(--color-text-muted);
    --hss-text-faint: rgba(161,161,170,0.85);
    --hss-green: var(--color-green);
    --hss-green-ink: var(--color-bg);
    --hss-amber: var(--color-yellow);

    width: 100%; max-width: 560px; justify-self: end;
    background: var(--hss-panel);
    border: 1px solid var(--hss-edge);
    border-radius: 14px;
    box-shadow: 0 30px 70px rgba(0,0,0,0.5);
    overflow: hidden;
    font-family: var(--font-sans);
  }

  .hss .frame-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 20px; border-bottom: 1px solid var(--hss-edge);
  }
  .hss .fh-title {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--hss-text-faint);
  }
  .hss .dots { display: flex; gap: 8px; }
  .hss .dot {
    width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,0.14);
    transition: background 0.3s; border: none; padding: 0; cursor: pointer;
  }
  .hss .dot.on { background: var(--hss-green); }
  .hss .dot:focus-visible { outline: 2px solid var(--color-text); outline-offset: 2px; }

  .hss .stage-area { position: relative; height: 372px; }
  .hss .scene {
    position: absolute; inset: 0; padding: 22px 24px;
    opacity: 0; transition: opacity 0.6s ease;
    pointer-events: none; display: flex; flex-direction: column;
  }
  .hss .scene.on { opacity: 1; pointer-events: auto; }

  .hss .caption { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--hss-edge); }
  .hss .caption .step {
    font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--hss-green); margin-bottom: 5px;
  }
  .hss .caption p { font-size: 13.5px; line-height: 1.5; color: var(--hss-text-mid); }
  .hss .caption b { color: var(--hss-text-hi); }

  .hss .ticker-wall {
    display: grid; grid-template-columns: repeat(8, 1fr); gap: 7px 8px;
    font-family: var(--font-mono); font-size: 10.5px; color: rgba(255,255,255,0.14);
    align-content: start;
  }
  .hss .ticker-wall span { transition: color 0.4s; text-align: center; }
  .hss .s1.live .ticker-wall span { animation: hss-flicker 3s infinite; }
  .hss .ticker-wall span:nth-child(3n) { animation-delay: 0.7s; }
  .hss .ticker-wall span:nth-child(4n) { animation-delay: 1.3s; }
  @keyframes hss-flicker { 0%,100% { color: rgba(255,255,255,0.14); } 50% { color: rgba(255,255,255,0.26); } }
  .hss .ticker-wall .hero-tk {
    color: var(--hss-green) !important;
    text-shadow: 0 0 14px rgba(0,255,65,0.55);
    animation: none !important; font-weight: 700;
  }

  .hss .found-chip {
    position: absolute; left: 50%; top: 40%;
    transform: translate(-50%, -50%) scale(0.6);
    background: rgba(0,255,65,0.06); border: 1px solid var(--hss-green); border-radius: 10px;
    padding: 12px 18px; text-align: center; opacity: 0;
    transition: opacity 0.5s ease 0.2s, transform 0.5s ease 0.2s;
  }
  .hss .s1.reveal .found-chip { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  .hss .found-chip .tk { font-family: var(--font-mono); font-size: 22px; font-weight: 700; color: var(--hss-green); }
  .hss .found-chip .co { font-size: 11px; color: var(--hss-text-mid); margin: 2px 0 7px; }
  .hss .found-chip .rank { font-family: var(--font-mono); font-size: 11.5px; color: var(--hss-text-hi); }
  .hss .found-chip .rank b { color: var(--hss-green); }

  .hss .agent-row { display: flex; gap: 14px; align-items: flex-start; margin-top: 4px; }
  .hss .agent-card {
    background: rgba(255,255,255,0.03); border: 1px solid var(--hss-edge); border-radius: 10px;
    padding: 12px 14px; min-width: 160px;
    transform: translateX(-24px); opacity: 0; transition: all 0.5s ease 0.2s;
  }
  .hss .scene.on .agent-card { transform: translateX(0); opacity: 1; }
  .hss .agent-name { font-size: 14px; font-weight: 600; color: var(--hss-text-hi); }
  .hss .agent-kind { font-family: var(--font-mono); font-size: 10px; color: var(--hss-text-faint); margin-top: 3px; }
  .hss .agent-log { font-family: var(--font-mono); font-size: 10.5px; color: var(--hss-text-mid); margin-top: 8px; line-height: 1.7; }
  .hss .agent-log .ok { color: var(--hss-green); }

  .hss .position-box { flex: 1; }
  .hss .pos-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px; }
  .hss .pos-tk { font-family: var(--font-mono); font-size: 16px; font-weight: 700; color: var(--hss-text-hi); }
  .hss .pos-size { font-family: var(--font-mono); font-size: 12.5px; color: var(--hss-green); }
  .hss .bar-track { height: 13px; background: rgba(255,255,255,0.05); border: 1px solid var(--hss-edge); border-radius: 7px; overflow: hidden; position: relative; }
  .hss .bar-fill { height: 100%; width: 0%; background: var(--hss-green); border-radius: 7px; transition: width 1.2s cubic-bezier(0.2, 0.7, 0.2, 1) 0.6s; }
  .hss .bar-banked {
    position: absolute; top: 0; right: 0; height: 100%; width: 0%;
    background: repeating-linear-gradient(-45deg, var(--hss-amber) 0 4px, rgba(0,0,0,0.55) 4px 8px);
    opacity: 0.9; transition: width 1.2s cubic-bezier(0.2, 0.7, 0.2, 1) 0.6s;
  }
  .hss .s2.on .bar-fill { width: 33%; }
  .hss .s3 .bar-fill { width: 33%; transition-delay: 0.4s; }
  .hss .s3.grow .bar-fill { width: 66%; }
  .hss .s4 .bar-fill { width: 66%; transition-delay: 0.4s; }
  .hss .s4.trim .bar-fill { width: 33%; }
  .hss .s4.trim .bar-banked { width: 33%; }
  .hss .bar-scale { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10px; color: var(--hss-text-faint); margin-top: 4px; }
  .hss .banked-key { font-family: var(--font-mono); font-size: 10px; color: var(--hss-amber); margin-top: 4px; text-align: right; }

  .hss .stamp {
    display: inline-block; margin-top: 12px;
    font-family: var(--font-mono); font-size: 10px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase;
    border: 2px solid var(--hss-green); color: var(--hss-green);
    border-radius: 4px; padding: 4px 9px; transform: rotate(-2deg) scale(1.4);
    opacity: 0; transition: all 0.35s ease 1.5s;
  }
  .hss .scene.on .stamp, .hss .s3.grow .stamp, .hss .s4.trim .stamp { opacity: 1; transform: rotate(-2deg) scale(1); }
  .hss .s4 .stamp { border-color: var(--hss-amber); color: var(--hss-amber); }
  .hss .earnings-chip {
    display: inline-block; font-family: var(--font-mono); font-size: 11px;
    color: var(--hss-amber); border: 1px solid rgba(255,215,0,0.28); background: rgba(255,215,0,0.06);
    border-radius: 6px; padding: 4px 9px; margin-bottom: 10px;
    opacity: 0; transform: translateY(-6px); transition: all 0.4s ease 0.1s;
  }
  .hss .s3.on .earnings-chip, .hss .s4.on .earnings-chip { opacity: 1; transform: translateY(0); }

  .hss .s5 { align-items: center; justify-content: center; text-align: center; }
  .hss .outro-line { font-size: 20px; font-weight: 600; color: var(--hss-text-hi); max-width: 24ch; line-height: 1.35; }
  .hss .outro-line span { color: var(--hss-green); }
  .hss .outro-sub { font-size: 13.5px; color: var(--hss-text-mid); margin-top: 10px; }
  .hss .hss-cta {
    margin-top: 20px; display: inline-block; text-decoration: none;
    background: var(--hss-green); color: var(--hss-green-ink); border: none;
    font-size: 15px; font-weight: 600; padding: 13px 26px; border-radius: 8px;
    cursor: pointer; font-family: var(--font-sans);
  }
  .hss .hss-cta:hover { background: var(--color-green-dim); }
  .hss .hss-cta:focus-visible { outline: 3px solid var(--color-text); outline-offset: 2px; }

  .hss .frame-foot {
    font-family: var(--font-mono); font-size: 10px; color: var(--hss-text-faint);
    text-align: center; padding: 10px 16px; border-top: 1px solid var(--hss-edge);
  }

  .hss .hss-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

  /* reduced motion OR small screens: static stacked scenes, no timeline */
  @media (prefers-reduced-motion: reduce), (max-width: 560px) {
    .hss .stage-area { height: auto; }
    .hss .scene {
      position: static; opacity: 1 !important; transition: none;
      padding-bottom: 6px; pointer-events: auto;
    }
    .hss .scene .agent-card, .hss .scene .stamp, .hss .earnings-chip {
      opacity: 1 !important; transform: none !important; transition: none;
    }
    .hss .s2 .bar-fill { width: 33%; transition: none; }
    .hss .s3 .bar-fill { width: 66%; transition: none; }
    .hss .s4 .bar-fill { width: 33%; transition: none; }
    .hss .s4 .bar-banked { width: 33%; transition: none; }
    .hss .found-chip {
      position: static; opacity: 1 !important; transform: none !important; margin: 12px auto 0;
    }
    .hss .dots { display: none; }
    .hss .s1 .ticker-wall { display: none; }
  }
`;
