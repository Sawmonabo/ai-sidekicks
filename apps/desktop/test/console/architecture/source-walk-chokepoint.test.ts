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

/**
 * The gates admitted to walk a directory because they enumerate PATHS and read no text.
 *
 * `vitest-project-globs.test.ts` asks which test-shaped FILES exist anywhere in the
 * package, so that every one of them is matched by exactly one project glob. That is a
 * different universe from console source — it must reach `src/main`, `__tests__`, and
 * every tier at once — and it never opens one of them. The chokepoint this file enforces
 * is about what counts as SOURCE for a source-text claim, and a gate that reads no text
 * makes no such claim. The admission is conditional and the condition is asserted below.
 */
const PATH_ONLY_WALK_GATES: readonly string[] = ["vitest-project-globs.test.ts"];

/** How a module shows it reads a file at all, which is claim 2's subject. */
const FILE_READ_FORMS: readonly string[] = ["readFileSync(", "readFile("];

/**
 * The gates admitted to read a file without drawing a module set from the shared walk.
 *
 * Each reads a CONFIG artifact — the package manifest and the CI workflow — which is not
 * renderer source and which the shared walk has no view of. The admission is narrow and
 * checked: the case below asserts an admitted gate composes no path into the renderer
 * tree, so a gate added here to launder a hard-coded console reader fails on the way in.
 */
const CONFIG_READING_GATES: readonly string[] = ["ci-tier-coverage.test.ts"];

/** The path segment every renderer path in this tier is composed from. */
const RENDERER_PATH_SEGMENT = "renderer";

/** Whether `source` reads a file itself. */
function readsAFile(source: string): boolean {
  return FILE_READ_FORMS.some((form) => source.includes(form));
}

/** Every string literal `source` contains, read through the parser and not by regex. */
export function stringLiteralsIn(source: string, fileName: string): readonly string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
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
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
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

  it("no gate walks a directory of its own", () => {
    const offenders = gates
      .filter((gate) => gate !== FORM_DECLARING_GATE && !PATH_ONLY_WALK_GATES.includes(gate))
      .map((gate) => ({ gate, walks: directoryWalkImports(readArchitectureGate(gate), gate) }))
      .filter((entry) => entry.walks.length > 0)
      .map((entry) => `${entry.gate}: ${entry.walks.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the one admitted gate still imports the walk API", () => {
    // See `FORM_DECLARING_GATE`. Without this the admission is a hole rather than a
    // declaration: a renamed walk API would leave the scan matching nothing anywhere,
    // and the clean result above would be clean for that reason instead.
    expect(directoryWalkImports(readArchitectureGate(FORM_DECLARING_GATE), FORM_DECLARING_GATE)) //
      .toStrictEqual(["readdirSync"]);
  });

  it("every gate that reads a file draws its module set from the shared walk", () => {
    // RE-SUBJECTED, because the subject this claim used to take was circular: it read
    // "the gates that name `readConsoleSourceModule`", which is the set of gates that
    // already go through the shared walk. It could only ever find compliant gates. The
    // shape it was written to catch — a gate that hard-codes a list of console paths and
    // reads them itself, a sixth opinion about what counts as source wearing a different
    // shape — names the reader nowhere and was therefore outside its own subject.
    //
    // The subject is now every gate that reads a FILE at all, which is decidable from
    // the read rather than from the gate's compliance, minus this gate and the module
    // that owns the walk. The escape is `CONFIG_READING_GATES`, and it is asserted
    // rather than trusted.
    const readers = gates.filter(
      (gate) => gate !== FORM_DECLARING_GATE && readsAFile(readArchitectureGate(gate)),
    );
    expect(readers.length).toBeGreaterThan(0);
    const offenders = readers.filter(
      (gate) =>
        !readArchitectureGate(gate).includes(SHARED_WALK_IMPORT) &&
        !CONFIG_READING_GATES.includes(gate),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("every admitted directory walker reads no file's text", () => {
    // The condition the walk admission rests on. A gate added to that list to get past
    // claim 1 while reading source is caught here, so the escape cannot be widened into
    // the sixth opinion about what counts as source that this file exists to refuse.
    for (const gate of PATH_ONLY_WALK_GATES) {
      expect(readsAFile(readArchitectureGate(gate)), `${gate} reads a file's text`).toBe(false);
    }
  });

  it("every admitted config reader builds no path into the renderer tree", () => {
    // What keeps the admission from laundering a hard-coded console reader. The test is
    // on STRING LITERALS through the parser and not on the file's text: every renderer
    // path in this tier is composed segment by segment, so a gate that reaches renderer
    // source carries the literal, while a gate that merely discusses the renderer in
    // prose does not — and `ci-tier-coverage.test.ts` is the second of those, which a
    // text scan would have read as the first.
    for (const gate of CONFIG_READING_GATES) {
      expect(
        stringLiteralsIn(readArchitectureGate(gate), gate),
        `${gate} composes a path into the renderer source tree`,
      ).not.toContain(RENDERER_PATH_SEGMENT);
    }
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

  it("negative control: the file-read and literal predicates separate their two sides", () => {
    expect(readsAFile('const source = readFileSync(path, "utf8");')).toBe(true);
    expect(readsAFile("await readFile(path);")).toBe(true);
    expect(readsAFile("// a gate that reads a file names the shared walk")).toBe(false);
    expect(stringLiteralsIn('const at = resolve(HERE, "renderer", "src");', "probe.ts")).toContain(
      RENDERER_PATH_SEGMENT,
    );
    expect(stringLiteralsIn("// the renderer tier is selected twice", "probe.ts")).not.toContain(
      RENDERER_PATH_SEGMENT,
    );
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
