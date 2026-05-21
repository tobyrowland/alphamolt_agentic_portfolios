import {
  STAGE1_SYSTEM_PROMPT,
  STAGE1_USER_TEMPLATE,
  STAGE2_SYSTEM_PROMPT,
  STAGE2_USER_TEMPLATE,
} from "@/lib/llm-prompts";

/**
 * Verbatim prompt panel for an llm_pick agent's profile page.
 *
 * Shows the exact templates each model is given. Placeholders like
 * {snapshot_date} and {universe_json} are filled at heartbeat time from
 * the daily universe snapshot — see /universe for the data side.
 *
 * Server component (no "use client"): native <details> handles toggle,
 * no JS needed.
 */
export default function LlmPromptsPanel({
  pickerMode,
}: {
  pickerMode?: string;
}) {
  const showTwoStage = (pickerMode ?? "two_stage") === "two_stage";

  return (
    <details className="rounded-2xl border border-white/10 bg-white/[0.02] mb-10 [&[open]_.chevron]:rotate-90">
      <summary className="cursor-pointer px-5 py-4 flex items-center justify-between font-mono text-xs font-bold uppercase tracking-widest text-text-dim list-none [&::-webkit-details-marker]:hidden hover:text-text transition-colors">
        <span>Prompts (verbatim)</span>
        <span className="chevron text-text-muted transition-transform">▸</span>
      </summary>
      <div className="px-5 pb-5 pt-3 border-t border-white/10 space-y-6">
        <p className="text-sm text-text-dim leading-relaxed">
          Every <code className="text-text">llm_pick</code> agent receives the
          same prompts — only the model differs. Placeholders like{" "}
          <code className="text-text">{`{snapshot_date}`}</code> and{" "}
          <code className="text-text">{`{universe_json}`}</code> are filled at
          heartbeat time from the{" "}
          <a href="/universe" className="text-green hover:underline">
            daily universe snapshot
          </a>
          .
        </p>

        {showTwoStage ? (
          <>
            <PromptBlock
              title="Stage 1 — shortlist (system)"
              body={STAGE1_SYSTEM_PROMPT}
            />
            <PromptBlock
              title="Stage 1 — shortlist (user)"
              body={STAGE1_USER_TEMPLATE}
            />
            <PromptBlock
              title="Stage 2 — final picks (system)"
              body={STAGE2_SYSTEM_PROMPT}
            />
            <PromptBlock
              title="Stage 2 — final picks (user)"
              body={STAGE2_USER_TEMPLATE}
            />
          </>
        ) : (
          <>
            <PromptBlock
              title="Single-pass picker (system)"
              body={STAGE2_SYSTEM_PROMPT}
            />
            <PromptBlock
              title="Single-pass picker (user)"
              body={STAGE2_USER_TEMPLATE}
            />
          </>
        )}
      </div>
    </details>
  );
}

function PromptBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-[11px] font-mono uppercase tracking-widest text-text-muted mb-2">
        {title}
      </p>
      <pre className="text-xs font-mono text-text-dim bg-bg-hover/50 border border-white/10 rounded p-3 whitespace-pre-wrap leading-relaxed overflow-x-auto">
        {body}
      </pre>
    </div>
  );
}
