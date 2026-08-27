// Runner for the money-move routing core (web/lib/money-move.ts).
//
// The hub offered three operations with three mental models (percentage
// steppers with an Apply step, Credit, Debit); this module is what lets the UI
// offer ONE — from, to, amount — and pick the server action underneath. The
// rules that are easy to get wrong live here: which route a pair implies, and
// how much may leave a bucket, which depends on the ROUTE and not the bucket.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_money_move_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  UNASSIGNED_ID,
  routeMove,
  maxMovable,
  moveRefusal,
  previewAfter,
  moveExplainer,
  accountHeadline,
} = await import(join(here, "..", "web", "lib", "money-move.ts"));

// The production account: one funded sleeve, one empty, and the pot.
const POT = { id: UNASSIGNED_ID, name: "Not assigned", value: 12149.18, cash: 12149.18 };
const SCRAPPY = { id: "p-scrappy", name: "Scrappy Fightback!", value: 27599.99, cash: 1360.48 };
const HOUSE = { id: "p-house", name: "Alphamolt (House)", value: 0, cash: 0 };

process.stdout.write(
  JSON.stringify({
    routes: {
      potToStrategy: routeMove(POT.id, SCRAPPY.id),
      strategyToPot: routeMove(SCRAPPY.id, POT.id),
      strategyToStrategy: routeMove(SCRAPPY.id, HOUSE.id),
      sameBucket: routeMove(SCRAPPY.id, SCRAPPY.id),
      potToPot: routeMove(POT.id, POT.id),
      empty: routeMove("", SCRAPPY.id),
    },
    ceilings: {
      outOfPot: maxMovable(POT, SCRAPPY),
      strategyToPot: maxMovable(SCRAPPY, POT),
      strategyToStrategy: maxMovable(SCRAPPY, HOUSE),
      emptyStrategy: maxMovable(HOUSE, SCRAPPY),
    },
    refusals: {
      fine: moveRefusal(POT, SCRAPPY, 5000),
      nothingTyped: moveRefusal(POT, SCRAPPY, NaN),
      overPot: moveRefusal(POT, SCRAPPY, 20000),
      overCashToPot: moveRefusal(SCRAPPY, POT, 5000),
      inKindWithinEquity: moveRefusal(SCRAPPY, HOUSE, 5000),
      fromEmpty: moveRefusal(HOUSE, SCRAPPY, 100),
      sameBucket: moveRefusal(SCRAPPY, SCRAPPY, 100),
      noneChosen: moveRefusal(null, SCRAPPY, 100),
    },
    preview: previewAfter(POT, SCRAPPY, 5000),
    previewNoAmount: previewAfter(POT, SCRAPPY, 0),
    headline: {
      known: accountHeadline(27599.99, 12149.18),
      unknown: accountHeadline(27599.99, null),
      emptyPot: accountHeadline(27599.99, 0),
    },
    explainers: {
      credit: moveExplainer(POT, SCRAPPY),
      debit: moveExplainer(SCRAPPY, POT),
      transfer: moveExplainer(SCRAPPY, HOUSE),
    },
  }),
);
