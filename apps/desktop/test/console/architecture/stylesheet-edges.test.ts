// Where the console's rules enter the bundle, asserted.
//
// `apps/desktop/AGENTS.md` gives the rule in one line — "a family's CSS is imported
// from that family's barrel and from nowhere else" — and until this file nothing
// checked it. Two families had already grown a second edge: `workflows-destination.css`
// was imported straight from its component while `workflows.css` did not `@import` it,
// so a family had two ways into its own rules and which one won depended on which
// component modules a build happened to reach first. That is not a formatting
// preference. Cascade order decides which rule paints, so a second edge makes the
// paint depend on the module graph.
//
// TWO CLAIMS, AND THEY CATCH DIFFERENT DEFECTS. One: only a family barrel imports a
// stylesheet. Two: every stylesheet in the tree is REACHED — from a barrel, directly
// or through an `@import` chain. The first alone would pass over a sheet nobody
// imports at all, which is rules that were written and never paint; the second alone
// would pass over a sheet reached twice.
//
// THE ONE EXCEPTION IS NAMED, NOT INFERRED. `PhaseGraphCanvas.tsx` imports the graph
// library's `base.css` and this family's `phase-graph.css`, and it is reached only
// through `phase-graph-loader.ts`'s `import()`. Both sheets ride that lazy chunk on
// purpose: pulled into `workflows.css` they would land in the document the operator
// waits for, and `phase-graph.css` would then load BEFORE the `base.css` it overrides
// at equal specificity, so the library's fallback palette would paint. The allowance
// is a path written out below, so a second one is an edit a reviewer sees rather than
// a pattern that quietly admits the next component.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { CONSOLE_SOURCE_DIRECTORY } from "../paths.js";

/**
 * The one module outside a family barrel that may import a stylesheet.
 *
 * A path rather than a rule about lazy chunks: the reason is real but it is not
 * checkable from the text of an import, and a predicate that admitted "anything a
 * dynamic import reaches" would admit every module the graph chunk grows.
 */
const LAZY_CHUNK_IMPORTER = join("panes", "workflow-run", "phase-graph", "PhaseGraphCanvas.tsx");

/** The stylesheets that ride the lazy chunk with the library they override. */
const LAZY_CHUNK_STYLESHEETS: readonly string[] = [
  join("panes", "workflow-run", "phase-graph", "phase-graph.css"),
];

/** A module that imports a stylesheet for its side effect, and the sheet it names. */
const STYLESHEET_IMPORT = /^import\s+"([^"]+\.css)";$/gmu;

/** An `@import` at the head of a stylesheet, and the sheet it pulls in. */
const STYLESHEET_AT_IMPORT = /^@import\s+"([^"]+\.css)";$/gmu;

/**
 * Every stylesheet `source` pulls in, by the specifier it wrote.
 *
 * A pure function over text so the negative controls below can drive it with strings
 * whose verdict is known, rather than perturbing a real module to prove the checker
 * bites.
 */
function stylesheetSpecifiers(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

/** Whether a console-relative module path is a family's barrel. */
function isFamilyBarrel(modulePath: string): boolean {
  return modulePath.endsWith(`${sep}index.ts`);
}

function consoleFiles(extensions: readonly string[]): readonly string[] {
  return readdirSync(CONSOLE_SOURCE_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        extensions.some((extension) => entry.endsWith(extension)) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx"),
    )
    .sort();
}

function readConsoleFile(consoleRelativePath: string): string {
  return readFileSync(join(CONSOLE_SOURCE_DIRECTORY, consoleRelativePath), "utf8");
}

/**
 * A specifier resolved against the file that wrote it, back to a console-relative
 * path — or `undefined` where it names a package rather than a file in this tree.
 *
 * The library's own `base.css` is the case that returns `undefined`: it is a bare
 * specifier, it is not this tree's to place, and the reachability claim below is
 * about sheets this console owns.
 */
function resolveStylesheet(importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const importerDirectory = dirname(importerPath).split(sep).join(posix.sep);
  return posix.normalize(posix.join(importerDirectory, specifier)).split(posix.sep).join(sep);
}

/** Every stylesheet reached from the barrels, following `@import` chains. */
function reachedStylesheets(): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending: string[] = [];
  for (const modulePath of consoleFiles([".ts", ".tsx"])) {
    if (!isFamilyBarrel(modulePath) && modulePath !== LAZY_CHUNK_IMPORTER) {
      continue;
    }
    for (const specifier of stylesheetSpecifiers(readConsoleFile(modulePath), STYLESHEET_IMPORT)) {
      const resolved = resolveStylesheet(modulePath, specifier);
      if (resolved !== undefined) {
        pending.push(resolved);
      }
    }
  }
  while (pending.length > 0) {
    const sheet = pending.pop() ?? "";
    if (reached.has(sheet)) {
      continue;
    }
    reached.add(sheet);
    for (const specifier of stylesheetSpecifiers(readConsoleFile(sheet), STYLESHEET_AT_IMPORT)) {
      const resolved = resolveStylesheet(sheet, specifier);
      if (resolved !== undefined) {
        pending.push(resolved);
      }
    }
  }
  return reached;
}

describe("stylesheet edges — a family's rules enter the bundle once", () => {
  const modules = consoleFiles([".ts", ".tsx"]);
  const stylesheets = consoleFiles([".css"]);

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong CONSOLE_SOURCE_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(stylesheets.length).toBeGreaterThan(5);
    expect(modules).toContain(LAZY_CHUNK_IMPORTER);
  });

  it("only a family barrel imports a stylesheet", () => {
    const offenders = modules
      .filter((modulePath) => !isFamilyBarrel(modulePath) && modulePath !== LAZY_CHUNK_IMPORTER)
      .map((modulePath) => ({
        modulePath,
        sheets: stylesheetSpecifiers(readConsoleFile(modulePath), STYLESHEET_IMPORT),
      }))
      .filter((entry) => entry.sheets.length > 0)
      .map((entry) => `${relative(".", entry.modulePath)}: ${entry.sheets.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("every stylesheet in the tree is reached from a barrel, exactly once", () => {
    // The other half: a sheet no barrel reaches is rules that were written and never
    // paint, which a rule about importers alone cannot see.
    const reached = reachedStylesheets();
    expect([...stylesheets].filter((sheet) => !reached.has(sheet))).toStrictEqual([]);
  });

  it("negative control: the checker matches the edges that are really there", () => {
    // Without this a typo in either pattern would make both clean results above
    // meaningless — an empty match set offends nobody.
    expect(
      stylesheetSpecifiers(readConsoleFile(join("workflows", "index.ts")), STYLESHEET_IMPORT),
    ).toStrictEqual(["./workflows.css"]);
    expect(
      stylesheetSpecifiers(
        readConsoleFile(join("workflows", "workflows.css")),
        STYLESHEET_AT_IMPORT,
      ).length,
    ).toBeGreaterThan(1);
  });

  it("negative control: a direct import in a component is flagged, a barrel's is not", () => {
    // The two sides of the line, driven through the predicate rather than through
    // whichever module happens to hold an edge today.
    const componentSource = 'import "./workflows-destination.css";\n';
    expect(stylesheetSpecifiers(componentSource, STYLESHEET_IMPORT)).toStrictEqual([
      "./workflows-destination.css",
    ]);
    expect(isFamilyBarrel(join("workflows", "WorkflowsDestination.tsx"))).toBe(false);
    expect(isFamilyBarrel(join("workflows", "index.ts"))).toBe(true);
  });

  it("negative control: the named exception really does import a sheet", () => {
    // An allowance for a module that imports nothing would be a hole nobody could
    // see, and would stay open after the module it was written for changed.
    const specifiers = stylesheetSpecifiers(
      readConsoleFile(LAZY_CHUNK_IMPORTER),
      STYLESHEET_IMPORT,
    );
    expect(specifiers.length).toBeGreaterThan(1);
    for (const sheet of LAZY_CHUNK_STYLESHEETS) {
      expect(stylesheets).toContain(sheet);
      expect(specifiers.some((specifier) => sheet.endsWith(specifier.replace("./", "")))).toBe(
        true,
      );
    }
  });
});
