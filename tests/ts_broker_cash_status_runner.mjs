// Runner for the broker-cash status copy (web/lib/live-cash-status.ts).
//
// `fetchBrokerCash` used to collapse three unrelated failures into one `null`
// and log nothing on a non-OK response, so the hub asserted a cause it could
// not know ("This server can't read your broker balance") — which sent a real
// investigation hunting for environment variables that were present and
// correct-looking, while Alpaca was in fact returning a status nobody logged.
//
// The copy IS the diagnostic here, so it is pinned.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_broker_cash_status_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { brokerCashNote, brokerCashTag, creditBlockedReason } = await import(
  join(here, "..", "web", "lib", "live-cash-status.ts")
);

const STATUSES = ["ok", "not_configured", "rejected", "unreachable"];

process.stdout.write(
  JSON.stringify({
    notes: Object.fromEntries(STATUSES.map((s) => [s, brokerCashNote(s)])),
    tags: Object.fromEntries(STATUSES.map((s) => [s, brokerCashTag(s)])),
    creditBlocked: Object.fromEntries(
      STATUSES.map((s) => [s, creditBlockedReason(s)]),
    ),
  }),
);
