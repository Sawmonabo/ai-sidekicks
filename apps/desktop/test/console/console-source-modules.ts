// The renderer source the architecture tier reads.
//
// Not a test file — no `include` glob reaches it; the architecture tier imports it,
// the way the browser tiers import `console-harness.tsx`. It exists because three
// source-text tripwires now walk the same two directories, and `apps/desktop`
// AGENTS.md hoists a helper on its second use: three copies of a recursive read with
// three slightly different ideas of what counts as source is how one tripwire comes
// to scan `.d.ts` files and another does not, with nothing reporting the difference.
//
// WHAT COUNTS AS SOURCE, decided once. A FILE — asked of the directory entry, not
// inferred from the name, because Vitest names a screenshot tier's committed
// reference directory after its spec (`__screenshots__/frame.test.tsx` is a
// directory) and a walk deciding by extension handed that back as a module and
// threw on the read — in TypeScript or TSX, excluding declaration files (nothing
// runs) and co-located tests. Tests are excluded for the reason the
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
import { dirname, join, relative, resolve } from "node:path";
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
  const tests = scan.tests ?? false;
  return walkRoots(scan.roots ?? CONSOLE_SOURCE_ROOTS, (relativePath) =>
    isSourceModulePath(relativePath, tests),
  );
}

/** The one enumeration under both public walks: which roots, and which files inside them. */
function walkRoots(
  roots: readonly string[],
  admits: (relativePath: string) => boolean,
): readonly ConsoleSourceModule[] {
  const modules: ConsoleSourceModule[] = [];
  for (const directory of roots) {
    if (!existsSync(directory)) {
      continue;
    }
    const rootName = relative(RENDERER_SOURCE_ROOT, directory).split("\\").join("/");
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      const absolutePath = join(entry.parentPath, entry.name);
      const relativePath = relative(directory, absolutePath);
      if (!entry.isFile() || !admits(relativePath)) {
        continue;
      }
      modules.push({
        directory,
        relativePath,
        displayPath: `${rootName}/${relativePath.split("\\").join("/")}`,
        absolutePath,
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
 * Every stylesheet under the roots given, sorted, in the same shape a module takes.
 *
 * A SECOND FILE KIND ON ONE WALK, not a second walk. The stylesheet-edges gate asks
 * two questions about the same tree — which modules import a sheet, and which sheets
 * exist — and the second is a directory listing that the module walk deliberately
 * does not answer, since a `.css` file is not a source module. Answered here, beside
 * the walk it shares its roots and its sorting with, so that gate holds no
 * `readdirSync` of its own and no second opinion about where the console is.
 */
export function consoleStylesheets(scan: ConsoleSourceScan = {}): readonly ConsoleSourceModule[] {
  return walkRoots(scan.roots ?? CONSOLE_SOURCE_ROOTS, (relativePath) =>
    relativePath.endsWith(".css"),
  );
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
