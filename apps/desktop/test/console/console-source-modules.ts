// The desktop source the architecture tier reads.
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
// STYLESHEETS ARE A SIBLING, not a flag. `consoleStylesheets` answers the same roots
// with the same sorting in the same shape, because the tier asks two questions about
// one tree — which modules import a sheet, which sheets exist — and a caller wants one
// list or the other and never a mixed one. What they share is the walk, which is the
// part that was being rewritten per gate.
//
// TESTS ARE A PARAMETER, not a fork. One gate — the daemon-call reach scan — governs
// the tests too, because a test outside the bridge family stands in for a surface and
// a surface goes through the door. Expressing that as `{ tests: true }` here is what
// keeps it from being written as a fifth walk with its own idea of what a test file
// is: the two walks it replaced disagreed with this one and with each other on
// `.test-support.*`, so one gate scanned `fixture-bridge.test-support.ts` and another
// did not, with nothing reporting the difference.
//
// THE ROOTS ARE A PARAMETER TOO, and one gate's subject is the whole package. A
// stacked documentation block is an editing accident rather than a console one, so
// `DESKTOP_PROSE_ROOTS` names `src/` and `test/` and the walk resolves a display base
// per root — see `displayBaseFor`. Nothing else about the walk changes: it is the same
// recursion, the same file test, and the same `tests` answer, which is exactly why the
// widening cost a root list rather than a fifth walk.
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
const DESKTOP_PACKAGE_ROOT = resolve(HERE, "..", "..");
const RENDERER_SOURCE_ROOT = join(DESKTOP_PACKAGE_ROOT, "src", "renderer", "src");

/** The Meridian console. Always present. */
export const CONSOLE_DIRECTORY: string = join(RENDERER_SOURCE_ROOT, "console");

/** The shell that composes console seats. Present on the branches that author it. */
export const SHELL_DIRECTORY: string = join(RENDERER_SOURCE_ROOT, "shell");

/** The two roots a console source-text tripwire scans, in scan order. */
export const CONSOLE_SOURCE_ROOTS: readonly string[] = [CONSOLE_DIRECTORY, SHELL_DIRECTORY];

/**
 * Every hand-written module in the package, in scan order.
 *
 * The roots for a gate whose subject is PROSE rather than console structure. A stacked
 * documentation block is an editing accident, not a console one: it lands wherever a
 * declaration was inserted under a block or a block was copied with its declaration,
 * and both happen in `src/main/`, in a co-located test, and — most of all — in a
 * `.test-support.*` module, which is where a block gets copied along with the helper
 * it describes. Scoping such a gate to the console left the two largest homes of the
 * defect unscanned, and the tests it did not scan outnumber the modules it did.
 *
 * Paired with `{ tests: true }` at every call site, which is what reaches the
 * `.test-support.*` half; the roots alone would still subtract it.
 */
export const DESKTOP_PROSE_ROOTS: readonly string[] = [
  join(DESKTOP_PACKAGE_ROOT, "src"),
  join(DESKTOP_PACKAGE_ROOT, "test"),
];

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

/** The walk both entry points share: the roots, the recursion, and the display path. */
function walkRoots(
  roots: readonly string[],
  admits: (relativePath: string) => boolean,
): readonly ConsoleSourceModule[] {
  const found: ConsoleSourceModule[] = [];
  for (const directory of roots) {
    if (!existsSync(directory)) {
      continue;
    }
    const rootName = relative(displayBaseFor(directory), directory).split("\\").join("/");
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      const absolutePath = join(entry.parentPath, entry.name);
      const relativePath = relative(directory, absolutePath);
      if (!entry.isFile() || !admits(relativePath)) {
        continue;
      }
      found.push({
        directory,
        relativePath,
        displayPath: `${rootName}/${relativePath.split("\\").join("/")}`,
        absolutePath,
      });
    }
  }
  return found.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

/**
 * What a display path is measured from, so one file has one name however it was found.
 *
 * The console roots sit inside `src/renderer/src/`, and their modules have been named
 * `console/…` and `shell/…` since the first tripwire — every gate's failure text and
 * every {@link moduleNamed} lookup spells them that way. The package-wide roots sit
 * above that anchor, where the same rule would produce `../../…`, so they measure from
 * the package instead and read `src/main/…` and `test/console/…`.
 *
 * Two vocabularies rather than one because renaming into a single one would rewrite
 * the lookups in every gate that has a subject inside the console — the cost is that
 * a console module found through the package-wide roots is named the long way, which
 * is still exactly where it lives.
 */
function displayBaseFor(directory: string): string {
  const insideRenderer = relative(RENDERER_SOURCE_ROOT, directory);
  return insideRenderer.startsWith("..") ? DESKTOP_PACKAGE_ROOT : RENDERER_SOURCE_ROOT;
}

/**
 * Every stylesheet under the roots given, sorted, on the same walk as the modules.
 *
 * A SIBLING OF {@link consoleSourceModules} AND NOT A FLAG ON IT. A caller wants one
 * or the other and never a mixed list: a source-text tripwire that received a `.css`
 * entry would parse it as TypeScript, and a stylesheet gate that received a `.ts` one
 * would read declarations as rules. What the two share is the walk itself — the roots,
 * the recursion, the display path — which is the part that was being rewritten per
 * gate and the part a rename of a root has to move in one place.
 */
export function consoleStylesheets(
  scan: Pick<ConsoleSourceScan, "roots"> = {},
): readonly ConsoleSourceModule[] {
  return walkRoots(scan.roots ?? CONSOLE_SOURCE_ROOTS, (relativePath) =>
    relativePath.endsWith(".css"),
  );
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

/** One module and the text it was read as, paired so a scan carries both. */
export interface ConsoleModuleText {
  readonly module: ConsoleSourceModule;
  /** What a failure message names the module by — {@link ConsoleSourceModule.displayPath}. */
  readonly displayPath: string;
  readonly source: string;
}

/** What one reading of the tree answers: the modules, and every one of them read. */
export interface ConsoleSourceReading {
  readonly modules: readonly ConsoleSourceModule[];
  readonly texts: readonly ConsoleModuleText[];
}

/**
 * The tree, walked and read ONCE for a file, behind a throwing accessor.
 *
 * A ROLE RATHER THAN A HELPER, which is why it lives beside the walk it pays for. A
 * source-text gate asks several questions of one tree, and the shape that answers them
 * cheaply is always the same: walk once, read every module once, hold the pair, and
 * assert the count so the hoist is a claim rather than a structure that looks right. A
 * gate that splits into two files needs it in both, which is the second use this is
 * hoisted on.
 *
 * BEHIND A PRIVATE FIELD WITH A THROWING ACCESSOR rather than a mutable binding a case
 * could read as `undefined`: a `beforeAll` that failed would otherwise surface as a
 * type error in whichever case ran first, which names the wrong thing.
 *
 * A GATE THAT FOLDS ITS READING IMMEDIATELY IS NOT A SECOND COPY OF THIS. The censuses
 * in `glyph-size-home.test.ts` and `one-doc-per-declaration.test.ts` walk and read the
 * same way and then keep a DERIVED answer — a set of sizes, a list of stranded blocks —
 * and never hold the texts at all. What they share with this is the walk and the
 * per-module read, and those they already share, from this module.
 */
export class ConsoleSourceTree {
  readonly #scan: ConsoleSourceScan;
  #reading: ConsoleSourceReading | undefined = undefined;
  #readCount = 0;

  /** @param scan Which roots to walk and whether tests count, as {@link consoleSourceModules} takes it. */
  public constructor(scan: ConsoleSourceScan = {}) {
    this.#scan = scan;
  }

  /** How many times the tree has been walked, for the control that it is once. */
  public get readCount(): number {
    return this.#readCount;
  }

  /** The one reading this file paid for. Throws if a case asks before the hook ran. */
  public get reading(): ConsoleSourceReading {
    if (this.#reading === undefined) {
      throw new Error("the console reading was asked for before the hook filled it in");
    }
    return this.#reading;
  }

  /** Walk the roots and read every module. Called once, from a `beforeAll`. */
  public read(): void {
    this.#readCount += 1;
    const modules = consoleSourceModules(this.#scan);
    this.#reading = {
      modules,
      texts: modules.map((module) => ({
        module,
        displayPath: module.displayPath,
        source: readConsoleSourceModule(module),
      })),
    };
  }
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
