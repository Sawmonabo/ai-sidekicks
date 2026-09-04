// The renderer source the architecture tier reads.
//
// Not a test file — no `include` glob reaches it; the architecture tier imports it,
// the way the browser tiers import `console-harness.tsx`. It exists because three
// source-text tripwires now walk the same two directories, and `apps/desktop`
// AGENTS.md hoists a helper on its second use: three copies of a recursive read with
// three slightly different ideas of what counts as source is how one tripwire comes
// to scan `.d.ts` files and another does not, with nothing reporting the difference.
//
// WHAT COUNTS AS SOURCE, decided once. TypeScript and TSX, excluding declaration
// files (nothing runs) and co-located tests. Tests are excluded for the reason the
// byte-scaling chokepoint states for its own scan: a test asserting that a rule bites
// has to write the thing the rule forbids, and a tripwire that forbade that would
// forbid testing itself.
//
// THE SHELL SUBTREE IS LISTED AND MAY BE ABSENT. `src/renderer/src/shell/` is a
// console tier — it composes console seats and runs under the same fixture define —
// and it is where the composer's own surfaces live. It does not exist on every
// branch, so a missing root contributes nothing rather than throwing. That is a
// vacuity hole by construction, which is why every caller asserts a floor on the
// count it got back rather than trusting the walk.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_SOURCE_ROOT = resolve(HERE, "..", "..", "src", "renderer", "src");

/** The Meridian console. Always present. */
export const CONSOLE_DIRECTORY: string = join(RENDERER_SOURCE_ROOT, "console");

/** The shell that composes console seats. Present on the branches that author it. */
export const SHELL_DIRECTORY: string = join(RENDERER_SOURCE_ROOT, "shell");

/** The two roots a console source-text tripwire scans, in scan order. */
export const CONSOLE_SOURCE_ROOTS: readonly string[] = [CONSOLE_DIRECTORY, SHELL_DIRECTORY];

/** One source module, named by the root it was found under. */
export interface ConsoleSourceModule {
  readonly directory: string;
  /** The path inside `directory`, as `readdir` reports it. */
  readonly relativePath: string;
  /** What a failure message names the module by. */
  readonly displayPath: string;
  readonly absolutePath: string;
}

/**
 * Every source module under the roots given, sorted, tests and declarations excluded.
 *
 * Defaults to both console roots. A caller scanning one root passes it, so a
 * chokepoint whose claim is scoped to the console does not silently start reporting
 * on the shell the day that subtree lands.
 */
export function consoleSourceModules(
  roots: readonly string[] = CONSOLE_SOURCE_ROOTS,
): readonly ConsoleSourceModule[] {
  const modules: ConsoleSourceModule[] = [];
  for (const directory of roots) {
    if (!existsSync(directory)) {
      continue;
    }
    const rootName = directory.slice(RENDERER_SOURCE_ROOT.length + 1);
    for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
      if (!isSourceModulePath(entry)) {
        continue;
      }
      modules.push({
        directory,
        relativePath: entry,
        displayPath: `${rootName}/${entry.split("\\").join("/")}`,
        absolutePath: join(directory, entry),
      });
    }
  }
  return modules.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

/** Read one module's text. Separate from the walk so a caller can filter first. */
export function readConsoleSourceModule(module: ConsoleSourceModule): string {
  return readFileSync(module.absolutePath, "utf8");
}

function isSourceModulePath(entry: string): boolean {
  if (entry.endsWith(".d.ts")) {
    return false;
  }
  if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
    return false;
  }
  if (entry.endsWith(".test-support.ts") || entry.endsWith(".test-support.tsx")) {
    return false;
  }
  return entry.endsWith(".ts") || entry.endsWith(".tsx");
}
