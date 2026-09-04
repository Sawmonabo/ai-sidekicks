// The one place a tier enumerates the console's source modules.
//
// Three architecture tests make the same shape of claim — "this token appears in
// exactly one console module, or in none" — and each of them needs the same
// subject: every `.ts` and `.tsx` file under `console/` that is not a test. That
// walk was written twice before this file existed, once in
// `architecture/cap-single-home.test.ts` and once in
// `architecture/wire-figure-chokepoint.test.ts`, and `apps/desktop/AGENTS.md`
// hoists a helper on its second use. A third copy is what this module replaces.
//
// THE SUBJECT IS WIDE AND THE NARROWING BELONGS TO THE CALLER. `*.test-support.ts`
// modules are console source: they are compiled, they ship in the fixture build,
// and a chokepoint claim that skipped them would have a hole exactly where a
// fixture author works. So they are IN the set here, and a caller whose claim
// deliberately excludes them — a rule about what a hand-written test may plant —
// filters them at its own call site, where the reason for the narrowing lives.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The console tree every caller scans, resolved from this file rather than a cwd. */
const CONSOLE_DIRECTORY = resolve(HERE, "..", "..", "src", "renderer", "src", "console");

/**
 * Every console source module, as a path relative to `CONSOLE_DIRECTORY`, sorted.
 *
 * Co-located tests and ambient declarations are excluded: a test that plants a
 * would-be offender has to be able to write one, and a `.d.ts` declares rather
 * than spells.
 */
export function consoleSourceModules(): readonly string[] {
  return readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx") &&
        !entry.endsWith(".d.ts"),
    )
    .sort();
}

/** The text of one module named by `consoleSourceModules()`. */
export function readConsoleSource(module: string): string {
  return readFileSync(join(CONSOLE_DIRECTORY, module), "utf8");
}
