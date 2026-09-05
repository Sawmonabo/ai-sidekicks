// Every source-text gate reads the same tree, and the build says so.
//
// WHY THIS FILE EXISTS. Five gates in this directory make claims of the form "no
// module in the console does X". Each claim is only as good as the SET it quantifies
// over, and that set is a directory walk with an opinion about what counts as source.
// Written per gate, those opinions drift silently: before this chokepoint there were
// three copies plus the shared helper, and they already disagreed — two excluded
// `.test-support.*` and one did not, so `bridge/fixture-bridge.test-support.ts` was
// inside one gate's universe and outside another's, with nothing anywhere reporting
// the difference. A gate that scans a smaller tree than its sentence claims is not a
// weaker gate; it is a gate that reports clean for the wrong reason.
//
// So `test/console/console-source-modules.ts` owns the walk, its `tests` option
// expresses the one legitimate divergence, and this file is what keeps a sixth walk
// from appearing beside it. It is the same posture the timer and byte-scaling
// chokepoints take toward the console's own source: name the one module that may do
// the thing, and assert nothing else does.
//
// THE INSTRUMENT IS SOURCE TEXT, and it has to be: "this gate draws its module set
// from the shared walk" is a claim about how a test file is written, which no type
// and no runtime assertion inside those tests can reach.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  CONSOLE_SOURCE_ROOTS,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHITECTURE_TIER_DIRECTORY = HERE;
const SHARED_WALK_MODULE = resolve(HERE, "..", "console-source-modules.ts");

/**
 * The `node:fs` bindings that enumerate a directory.
 *
 * Read from the IMPORT rather than from call text, which is the whole of this claim's
 * strength: three spellings carry no `readdirSync(` anywhere —
 * `import { readdirSync as listEntries }`, `const walkDirectory = readdirSync`, and
 * `globSync(pattern)` — and each was a hole in the text needles this replaced. A binding
 * has to be imported before it can be aliased, so the import list sees all three. It
 * also cannot fire on prose: a header explaining why a gate does NOT walk names the
 * function in a comment, and a comment is not an import.
 *
 * `globSync` is in the list because it was live in this tier when the list was written,
 * not as a hypothetical: `browser-mode-optimize-deps.test.ts` walked the whole of `src/`
 * with it, with its own idea of what counts as source and no exclusion for declaration
 * files.
 */
const DIRECTORY_WALK_BINDINGS: readonly string[] = [
  "readdirSync",
  "readdir",
  "globSync",
  "glob",
  "opendirSync",
  "opendir",
];

/** The module specifiers a directory walk is imported from. */
const FILE_SYSTEM_SPECIFIERS: readonly string[] = [
  "node:fs",
  "fs",
  "node:fs/promises",
  "fs/promises",
];

/** How a module shows it drew its set from the shared walk instead. */
const SHARED_WALK_IMPORT = "console-source-modules.js";

/** How a module shows it reads a file at all. */
const FILE_READ_FORMS: readonly string[] = ["readFileSync(", "readFile("];

/**
 * The path segments a gate composes to reach renderer source, and the shared walk's own
 * exported roots.
 *
 * This is what scopes both claims, and it replaces two hand-written admission lists. The
 * chokepoint is about the console SOURCE walk: a tier gate that enumerates test files to
 * check a project glob, or reads the CI workflow, or reads a harness beside it, holds no
 * opinion about what counts as console source and is outside both claims — while a gate
 * that reaches the renderer tree has to reach it through the one walk.
 *
 * Decided from STRING LITERALS through the parser, never from the file's text: every
 * renderer path in this tier is composed segment by segment, so a gate that reaches
 * renderer source carries a segment while a gate that merely discusses the renderer in
 * prose does not. `ci-tier-coverage.test.ts` is the second of those, and a text scan
 * would have read it as the first. The root constants ride beside the segments because a
 * gate could take `CONSOLE_DIRECTORY` from the shared module and then walk it itself,
 * which carries no segment of its own.
 */
const RENDERER_REACH_SEGMENTS: readonly string[] = ["renderer", "src"];

/** The shared walk's exported roots, which reach the same tree without a path segment. */
const SHARED_WALK_ROOTS: readonly string[] = [
  "CONSOLE_DIRECTORY",
  "SHELL_DIRECTORY",
  "CONSOLE_SOURCE_ROOTS",
];

/** Whether `source` reads a file itself. */
function readsAFile(source: string): boolean {
  return FILE_READ_FORMS.some((form) => source.includes(form));
}

/** Whether `source` composes a path into the renderer source tree. */
function reachesRendererSource(source: string, fileName: string): boolean {
  const literals = stringLiteralsIn(source, fileName);
  return (
    RENDERER_REACH_SEGMENTS.some((segment) => literals.includes(segment)) ||
    SHARED_WALK_ROOTS.some((root) => source.includes(root))
  );
}

/** Every string literal `source` contains, read through the parser and not by regex. */ /** Every string literal `source` contains, read through the parser and not by regex. */
export function stringLiteralsIn(source: string, fileName: string): readonly string[] {
  const literals: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
    }
  });
  return literals;
}

/**
 * The one gate that names the walk API, which is this one.
 *
 * A chokepoint's own declaration of what it forbids is the one place the forbidden
 * text has to appear, and the byte-scaling gate next door draws the same line the
 * same way. The claim below asserts this file still TRIPS the needles, so the
 * admission cannot outlive its cause: a rename of `readdirSync` would leave a
 * constant admitting a file that no longer matches, and the clean result above would
 * stop meaning anything.
 */
const FORM_DECLARING_GATE = "source-walk-chokepoint.test.ts";

/**
 * Every directory-walking binding `source` imports from the file system, or `[]`.
 *
 * The TypeScript parser rather than a regular expression, per the package's own rule for
 * questions about source text: which bindings a module imports is a property of its
 * import declarations, and a regular expression that reads them runs past a declaration
 * boundary the first time a specifier list wraps.
 *
 * A NAMESPACE import of the file system is reported as its own finding rather than
 * resolved through: `import * as fs` puts every walk in the module's reach under a name
 * this scan cannot enumerate, and no gate in this tier needs one — `readFileSync` is a
 * named import everywhere it is used.
 */
export function directoryWalkImports(source: string, fileName: string): readonly string[] {
  const parsed = parseSourceText(fileName, source);
  const found: string[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!FILE_SYSTEM_SPECIFIERS.includes(statement.moduleSpecifier.text)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      found.push(`* as ${bindings.name.text}`);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (DIRECTORY_WALK_BINDINGS.includes(imported)) {
        found.push(imported);
      }
    }
  }
  return found;
}

/** Every gate in this directory, by file name. */
function architectureGateFileNames(): readonly string[] {
  return consoleSourceModules({ roots: [ARCHITECTURE_TIER_DIRECTORY], tests: true })
    .map((module) => module.relativePath)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

function readArchitectureGate(fileName: string): string {
  return readFileSync(join(ARCHITECTURE_TIER_DIRECTORY, fileName), "utf8");
}

describe("source-walk chokepoint — one walk under every source-text claim", () => {
  const gates = architectureGateFileNames();

  it("finds the architecture tier to scan at all", () => {
    // Without this a wrong directory would scan nothing and both claims below would
    // pass over the empty set.
    expect(gates.length).toBeGreaterThan(8);
    expect(gates).toContain("timer-chokepoint.test.ts");
    expect(gates).toContain("source-walk-chokepoint.test.ts");
  });

  it("no gate that reaches renderer source walks a directory of its own", () => {
    const offenders = gates
      .filter(
        (gate) =>
          gate !== FORM_DECLARING_GATE && reachesRendererSource(readArchitectureGate(gate), gate),
      )
      .map((gate) => ({ gate, walks: directoryWalkImports(readArchitectureGate(gate), gate) }))
      .filter((entry) => entry.walks.length > 0)
      .map((entry) => `${entry.gate}: ${entry.walks.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("finds gates on both sides of the scope, so neither claim is vacuous", () => {
    // The scope is what replaced two hand-written admission lists, so both of its sides
    // have to have members or the claims above and below quantify over nothing. Gates
    // that walk and do NOT reach renderer source are the tier's own file enumerations —
    // which project owns a test file, which bounded wait a launched body declares — and
    // they are the reason the claims are scoped rather than absolute.
    const reaching = gates.filter((gate) =>
      reachesRendererSource(readArchitectureGate(gate), gate),
    );
    const walkingOutsideIt = gates.filter(
      (gate) =>
        !reachesRendererSource(readArchitectureGate(gate), gate) &&
        directoryWalkImports(readArchitectureGate(gate), gate).length > 0,
    );
    expect(reaching.length).toBeGreaterThan(1);
    expect(walkingOutsideIt.length).toBeGreaterThan(1);
  });

  it("negative control: the one admitted gate still imports the walk API", () => {
    // See `FORM_DECLARING_GATE`. Without this the admission is a hole rather than a
    // declaration: a renamed walk API would leave the scan matching nothing anywhere,
    // and the clean result above would be clean for that reason instead.
    expect(directoryWalkImports(readArchitectureGate(FORM_DECLARING_GATE), FORM_DECLARING_GATE)) //
      .toStrictEqual(["readdirSync"]);
  });

  it("every gate that reads a file either uses the shared walk or reaches no renderer source", () => {
    // RE-SUBJECTED, because the subject this claim used to take was circular: it read
    // "the gates that name `readConsoleSourceModule`", which is the set of gates that
    // already go through the shared walk. It could only ever find compliant gates. The
    // shape it was written to catch — a gate that hard-codes a list of console paths and
    // reads them itself, a sixth opinion about what counts as source wearing a different
    // shape — names the reader nowhere and was therefore outside its own subject.
    //
    // The subject is now every gate that reads a FILE at all, which is decidable from
    // the read rather than from the gate's compliance, and the escape is DERIVED rather
    // than listed: a gate whose reads reach no renderer path holds no opinion about what
    // counts as console source. The tier gates that read a harness, the CI workflow, or
    // a launched body's own text are that, and they pass without anybody adding them to
    // a list.
    const readers = gates.filter(
      (gate) => gate !== FORM_DECLARING_GATE && readsAFile(readArchitectureGate(gate)),
    );
    expect(readers.length).toBeGreaterThan(2);
    const offenders = readers.filter((gate) => {
      const source = readArchitectureGate(gate);
      return !source.includes(SHARED_WALK_IMPORT) && reachesRendererSource(source, gate);
    });
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the walk scan reads an import and not a mention of one", () => {
    // Both sides of the line, against the predicate rather than against whichever gate
    // happens to name a walk in prose today — this file's own header does.
    expect(directoryWalkImports('import { readdirSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual(["readdirSync"]);
    // The three spellings the text needles missed, each measured passing them.
    expect(
      directoryWalkImports('import { readdirSync as listEntries } from "node:fs";', "probe.ts"),
    ).toStrictEqual(["readdirSync"]);
    expect(directoryWalkImports('import { globSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual(["globSync"]);
    expect(directoryWalkImports('import * as fs from "node:fs";', "probe.ts")) //
      .toStrictEqual(["* as fs"]);
    // And a walk named in prose, or a file read that is not a walk, is not an offence.
    expect(
      directoryWalkImports("// this file used to carry its own `readdirSync(root)`", "probe.ts"),
    ).toStrictEqual([]);
    expect(directoryWalkImports('import { readFileSync } from "node:fs";', "probe.ts")) //
      .toStrictEqual([]);
  });

  it("negative control: the predicates separate their two sides", () => {
    expect(readsAFile('const source = readFileSync(path, "utf8");')).toBe(true);
    expect(readsAFile("await readFile(path);")).toBe(true);
    expect(readsAFile("// a gate that reads a file names the shared walk")).toBe(false);
    // A composed renderer path reaches; the same words in prose do not, which is the
    // whole reason the scope is read from string literals through the parser.
    expect(
      reachesRendererSource('const at = resolve(HERE, "..", "renderer", "src");', "probe.ts"),
    ).toBe(true);
    expect(reachesRendererSource("// the renderer tier is selected twice", "probe.ts")).toBe(false);
    expect(
      reachesRendererSource('const harness = resolve(HERE, "..", "electron-harness.ts");', "p.ts"),
    ).toBe(false);
    // And the shared walk's own roots reach it without composing a segment at all.
    expect(
      reachesRendererSource(
        "const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });",
        "p.ts",
      ),
    ).toBe(true);
  });

  it("negative control: the shared walk itself is the one module that walks", () => {
    // The clean result above is only meaningful if the needles match real code, and
    // the one place they must match is the module that owns the walk. It is outside
    // this directory, so it is not an offender — and asserting it still trips turns a
    // renamed API into a red gate rather than a silent hole.
    expect(
      directoryWalkImports(readFileSync(SHARED_WALK_MODULE, "utf8"), SHARED_WALK_MODULE),
    ).toContain("readdirSync");
  });
});

describe("source-walk chokepoint — the walk answers what its options say", () => {
  it("excludes tests by default and admits them on request", () => {
    const production = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    const withTests = consoleSourceModules({ roots: [CONSOLE_DIRECTORY], tests: true });
    expect(production.length).toBeGreaterThan(20);
    expect(withTests.length).toBeGreaterThan(production.length);
    expect(production.map((module) => module.displayPath)).not.toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    expect(withTests.map((module) => module.displayPath)).toContain(
      "console/bridge/fixture-bridge.test-support.ts",
    );
    // The divergence that made the two hand-rolled walks disagree, asserted as one
    // answer: `.test-support.*` and `.test.*` are the same class to this walk, so no
    // caller can end up with one and not the other.
    expect(withTests.map((module) => module.displayPath)).toContain("console/core/instant.test.ts");
  });

  it("never admits a declaration file on either setting", () => {
    for (const tests of [false, true]) {
      expect(
        consoleSourceModules({ tests }).filter((module) => module.displayPath.endsWith(".d.ts")),
      ).toStrictEqual([]);
    }
  });

  it("defaults to both console roots, and a missing root contributes nothing", () => {
    expect(CONSOLE_SOURCE_ROOTS).toContain(CONSOLE_DIRECTORY);
    expect(consoleSourceModules().length).toBeGreaterThanOrEqual(
      consoleSourceModules({ roots: [CONSOLE_DIRECTORY] }).length,
    );
  });

  it("names the module a caller asked for, and says which name was not found", () => {
    const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });
    expect(moduleNamed(modules, "console/core/instant.ts").displayPath).toBe(
      "console/core/instant.ts",
    );
    expect(readConsoleSourceModule(moduleNamed(modules, "console/core/instant.ts"))).toContain(
      "parseInstant",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts")).toThrow(
      "the scan did not reach console/core/absent.ts",
    );
    expect(() => moduleNamed(modules, "console/core/absent.ts", "the reader")).toThrow(
      "the scan did not reach the reader at console/core/absent.ts",
    );
  });
});

describe("the shared walk — answers files, never a directory with a file's name", () => {
  const screenshotTier = resolve(HERE, "..", "screenshot");

  it("control: the tier holds a DIRECTORY whose name is extension-shaped", () => {
    // Vitest names a screenshot tier's committed reference directory after its spec,
    // so this entry is what a walk deciding by extension would admit as a module.
    const entries = readdirSync(screenshotTier, { recursive: true, encoding: "utf8" }).map(
      (entry) => entry.split("\\").join("/"),
    );
    const directoryNamedLikeASpec = entries.find((entry) =>
      entry.endsWith("__screenshots__/frame.test.tsx"),
    );
    expect(directoryNamedLikeASpec).toBeDefined();
    expect(statSync(join(screenshotTier, directoryNamedLikeASpec ?? "")).isDirectory()).toBe(true);
  });

  it("returns only files from a root that holds such a directory", () => {
    const modules = consoleSourceModules({ roots: [screenshotTier], tests: true });
    expect(modules.length).toBeGreaterThan(0);
    const notFiles = modules.filter((module) => !statSync(module.absolutePath).isFile());
    expect(notFiles.map((module) => module.displayPath)).toStrictEqual([]);
    // The spec itself is still read; only its reference directory is not.
    expect(modules.some((module) => module.relativePath === "frame.test.tsx")).toBe(true);
  });
});
