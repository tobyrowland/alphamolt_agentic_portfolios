/**
 * POST /api/compile-brief  (brief v2 §2/§6)
 *
 * The DESIGN-TIME LLM translation: a plain-English brief → a proposed
 * `{filters, weights, aiMultiplier}` screen config. Called only when the user
 * hits "Compile to screen" — NEVER per render and NEVER in the daily ranking
 * loop (that stays pure deterministic computation). The user sees and edits
 * the result; the compiled config is the source of truth.
 *
 * Powered by Gemini 2.5 Flash (cheap/fast, design-time only). Output is
 * validated + clamped against the same zod schema the deterministic scorer
 * uses, so a hallucinated field/op can never reach the ranking.
 */

import { errorResponse, jsonResponse } from "@/lib/api-utils";
import {
  FILTER_FIELDS,
  FILTER_OPS,
  filterSchema,
  weightsSchema,
  type Filter,
} from "@/lib/screen/config";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const compiledSchema = z.object({
  filters: z.array(filterSchema).max(20).default([]),
  weights: weightsSchema,
  aiMultiplier: z.boolean().default(true),
});

const SYSTEM = `You translate a plain-English stock-screen brief into a strict JSON screen config. You are a DESIGN-TIME translator only — never a stock picker.

Allowed filter fields (numbers are percentages or multiples as noted):
- sector, country        (text; use op "==" or "!=")
- ps                     (price/sales multiple)
- rev_growth_ttm         (revenue growth %, TTM)
- gross_margin, fcf_margin, net_margin, operating_margin   (%)
- rule_of_40             (number)
- ret_52w                (trailing 52-week price return %)
- price                  ($)
Allowed ops: ${FILTER_OPS.join(", ")}.

Common US GICS-ish sectors you may reference for sector filters: "Health Technology", "Technology Services", "Electronic Technology", "Finance", "Retail Trade", "Consumer Services", "Producer Manufacturing", "Energy Minerals", "Commercial Services".

weights: integers for "quality", "value", "momentum" that sum to ~100. Quality = margins/Rule-of-40 strength; value = cheapness on P/S; momentum = 52-week price strength. Tilt them to match the brief's emphasis.

aiMultiplier: true unless the brief says to ignore AI bull/bear signals.

Return ONLY strict JSON of shape {"filters":[{"field","op","value"}],"weights":{"quality","value","momentum"},"aiMultiplier"}. No prose, no markdown.`;

const bodySchema = z.object({ brief: z.string().min(1).max(2000) });

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return errorResponse("GEMINI_API_KEY not configured", 503);

  let brief: string;
  try {
    brief = bodySchema.parse(await req.json()).brief;
  } catch {
    return errorResponse("Body must be { brief: string }", 400);
  }

  try {
    const resp = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: `BRIEF:\n${brief}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (!resp.ok) {
      return errorResponse(`Gemini error ${resp.status}`, 502);
    }
    const data = await resp.json();
    const text: string =
      data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(text));
    } catch {
      return errorResponse("LLM returned non-JSON", 502);
    }

    // Validate + clamp. Drop any filter that doesn't pass the schema rather
    // than failing the whole compile.
    const raw = parsed as { filters?: unknown[]; weights?: unknown; aiMultiplier?: unknown };
    const filters: Filter[] = [];
    for (const f of raw.filters ?? []) {
      const r = filterSchema.safeParse(f);
      if (r.success && FILTER_FIELDS.includes(r.data.field)) filters.push(r.data);
    }
    const compiled = compiledSchema.parse({
      filters,
      weights: raw.weights,
      aiMultiplier: raw.aiMultiplier ?? true,
    });

    return jsonResponse({ compiled, brief });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compile failed";
    return errorResponse(message, 500);
  }
}

function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}
