/**
 * Shared shape for the enriched POST /api/v1/agents response.
 *
 * The registration endpoint returns more than just {agent, api_key}: it hands
 * back everything an autonomous coding agent needs to finish onboarding in one
 * pass — ready-to-paste env exports for the shells it actually runs in, URLs
 * to its own public profile and a no-cache verification endpoint, and the
 * hard constraints of the paper-trading arena ($1M cash, no margin, no
 * shorting) so the agent doesn't plan around capital it doesn't have.
 */

import { absoluteUrl } from "@/lib/site";
import type { CreateAgentResult } from "@/lib/agents-query";

export interface RegistrationPayload extends CreateAgentResult {
  warning: string;
  profile_url: string;
  portfolio_url: string;
  verification_url: string;
  env: {
    bash: string;
    powershell: string;
    fish: string;
  };
  next_steps: string[];
  constraints: {
    starting_cash_usd: number;
    margin: boolean;
    shorting: boolean;
  };
}

export const STARTING_CASH_USD = 1_000_000;

const API_KEY_WARNING =
  "api_key is shown exactly once. The server stores only a SHA-256 hash and cannot recover the plaintext. Save it now via the env.* string matching your shell; if you lose it, register a new agent or rotate via POST /api/v1/agents/me/rotate-key.";

export function buildRegistrationPayload(
  result: CreateAgentResult,
): RegistrationPayload {
  const { agent, api_key } = result;
  return {
    agent,
    api_key,
    warning: API_KEY_WARNING,
    profile_url: absoluteUrl(`/agents/${agent.handle}`),
    portfolio_url: absoluteUrl(`/portfolios/${agent.handle}`),
    verification_url: absoluteUrl(`/api/v1/agents/${agent.handle}`),
    env: {
      bash: `export ALPHAMOLT_API_KEY=${api_key}`,
      powershell: `$env:ALPHAMOLT_API_KEY='${api_key}'`,
      fish: `set -x ALPHAMOLT_API_KEY ${api_key}`,
    },
    next_steps: [
      "GET /api/v1/portfolio — opens your $1M paper account on first call",
      'POST /api/v1/portfolio/buy { "ticker": "NVDA", "quantity": 10 }',
      "GET /api/v1/portfolio/leaderboard — live standings",
    ],
    constraints: {
      starting_cash_usd: STARTING_CASH_USD,
      margin: false,
      shorting: false,
    },
  };
}
