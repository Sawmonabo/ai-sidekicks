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
// TESTS ARE A PARAMETER, not a fork. One gate — the daemon-call reach scan — governs
// the tests too, because a test outside the bridge family stands in for a surface and
// a surface goes through the door. Expressing that as `{ tests: true }` here is what
// keeps it from being written as a fifth walk with its own idea of what a test file
// is: the two walks it replaced disagreed with this one and with each other on
// `.test-support.*`, so one gate scanned `fixture-bridge.test-support.ts` and another
// did not, with nothing reporting the difference.
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

/** What a caller asks the walk for. Every field has a default; `{}` is the common case. */
export interface ConsoleSourceScan {
  /**
   * Which roots to walk. Defaults to both.
   *
   * A caller scanning one root passes it, so a chokepoint whose claim is scoped to
   * the console does not silently start reporting on the shell the day that subtree
   * lands.
   */
  readonly roots?: readonly string[];
  /**
   * Whether co-located tests and their support modules count as source.
   *
   * Defaults to `false` — see this module's header for why that is the common answer
   * and why the exception is a parameter rather than a second walk.
   */
  readonly tests?: boolean;
}

/**
 * Every source module under the roots given, sorted, declarations always excluded.
 */
export function consoleSourceModules(scan: ConsoleSourceScan = {}): readonly ConsoleSourceModule[] {
  const roots = scan.roots ?? CONSOLE_SOURCE_ROOTS;
  const tests = scan.tests ?? false;
  const modules: ConsoleSourceModule[] = [];
  for (const directory of roots) {
    if (!existsSync(directory)) {
      continue;
    }
    const rootName = directory.slice(RENDERER_SOURCE_ROOT.length + 1);
    for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
      if (!isSourceModulePath(entry, tests)) {
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

/**
 * One named module out of a scan, or a failure that says which name was not found.
 *
 * The other half of the walk, and it was written three times before it lived here —
 * with three signatures, one of them an inline `find` and a `throw`. A gate whose
 * "the scan reached this module" failure reads differently in three files is three
 * gates a reader has to learn separately, and the divergence is invisible until one
 * of them reports nothing useful on the day it fires.
 *
 * `what` names the module in a person's terms where the path alone would not say why
 * the gate cared. It is optional because in a gate whose whole subject is that one
 * path, the path IS the sentence.
 */
export function moduleNamed(
  modules: readonly ConsoleSourceModule[],
  displayPath: string,
  what?: string,
): ConsoleSourceModule {
  const found = modules.find((module) => module.displayPath === displayPath);
  if (found === undefined) {
    throw new Error(
      what === undefined
        ? `the scan did not reach ${displayPath}`
        : `the scan did not reach ${what} at ${displayPath}`,
    );
  }
  return found;
}

function isSourceModulePath(entry: string, tests: boolean): boolean {
  if (entry.endsWith(".d.ts")) {
    return false;
  }
  if (!tests && isTestModulePath(entry)) {
    return false;
  }
  return entry.endsWith(".ts") || entry.endsWith(".tsx");
}

/** A co-located test or the support module one imports. One answer, for both walks. */
function isTestModulePath(entry: string): boolean {
  return (
    entry.endsWith(".test.ts") ||
    entry.endsWith(".test.tsx") ||
    entry.endsWith(".test-support.ts") ||
    entry.endsWith(".test-support.tsx")
  );
}
