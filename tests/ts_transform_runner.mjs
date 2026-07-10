// Cross-language parity runner: evaluates web/lib/screen/transforms.ts over
// the shared fixture and prints the results as JSON, so tests/test_transforms.py
// can assert the TS and Python implementations agree bit-for-bit.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_transform_runner.mjs \
//        tests/fixtures/transform_parity.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { applyTransform } = await import(
  join(here, "..", "web", "lib", "screen", "transforms.ts")
);

const fixturePath = process.argv[2] ?? join(here, "fixtures", "transform_parity.json");
const cases = JSON.parse(readFileSync(fixturePath, "utf8"));

const results = cases.map((c) => ({
  name: c.name,
  actual: applyTransform(c.series, c.transform),
}));
process.stdout.write(JSON.stringify(results));
