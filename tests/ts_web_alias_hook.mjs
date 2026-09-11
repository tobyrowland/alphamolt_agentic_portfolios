// Makes `web/lib/**` importable from a plain node test runner.
//
// Next.js resolves two things node does not: the `@/` path alias (tsconfig
// `paths`) and extensionless relative imports of `.ts` files. A module using
// either — `web/lib/screen/config.ts` uses both — is otherwise unreachable
// from a runner, which is why the pure modules under test are kept
// import-free wherever possible. Import this module FIRST in a runner that
// needs one of the others.
//
// Registering hooks is not enough on its own: the importing module must still
// find its npm dependencies (config.ts needs zod), so a runner that uses this
// has to tolerate the import failing — the CI test job installs pip packages
// only, never npm.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = pathToFileURL(`${here}/../web/`).href;

registerHooks({
  resolve(spec, ctx, next) {
    let s = spec.startsWith("@/") ? WEB + spec.slice(2) : spec;
    if ((s.startsWith("file:") || s.startsWith(".")) && !/\.[a-z]+$/.test(s)) {
      const base = s.startsWith("file:") ? s : new URL(s, ctx.parentURL).href;
      if (existsSync(fileURLToPath(`${base}.ts`))) s = `${base}.ts`;
    }
    return next(s, ctx);
  },
});
