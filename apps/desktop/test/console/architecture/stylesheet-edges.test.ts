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
// THERE IS NO EXEMPTION LIST, AND THAT IS THE POINT OF THE RULE'S SHAPE. A lazily
// loaded chunk owns sheets that must NOT ride the initial document — the graph
// library's `base.css` and `phase-graph.css` are the pair today — and an earlier
// revision admitted them by writing the importing COMPONENT's path into this file,
// which excepted the convention rather than enforcing it. `apps/desktop/AGENTS.md`
// now states the rule the chunk actually needs: a sheet enters through the barrel of
// the family or of the lazily-loaded chunk that owns it, and through no component. So
// the chunk gets a door of its own, the `import()` names that door, and the predicate
// below admits it for the same reason it admits every other barrel — no path written
// out, and nothing here to keep in step with a component that moves.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { CONSOLE_SOURCE_DIRECTORY } from "../paths.js";

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

/**
 * Whether a console-relative module path is a barrel — a family's door or a lazily
 * loaded chunk's, which the rule treats alike.
 *
 * The two are the same shape on purpose. What a stylesheet edge needs is a module
 * that is the single way into the code the sheet paints, and a door is that whether
 * the code behind it is a family or a chunk; a predicate that tried to tell them
 * apart would be reading intent out of a path.
 */
function isOwningBarrel(modulePath: string): boolean {
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
    if (!isOwningBarrel(modulePath)) {
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
    // And the scan is recursive rather than a listing of the console root: every
    // stylesheet edge below sits at least two directories down.
    expect(modules.some((modulePath) => modulePath.split(sep).length > 2)).toBe(true);
  });

  it("only an owning barrel imports a stylesheet", () => {
    const offenders = modules
      .filter((modulePath) => !isOwningBarrel(modulePath))
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
    expect(isOwningBarrel(join("workflows", "WorkflowsDestination.tsx"))).toBe(false);
    expect(isOwningBarrel(join("workflows", "index.ts"))).toBe(true);
  });

  it("the lazy chunk's door owns its sheets, and the component in it owns none", () => {
    // The case the rule was restated for, asserted from the tree rather than from a
    // path this file remembers: the door imports the library's sheet and this
    // directory's, in that order, and the canvas behind it imports neither. Without
    // the second half the door could be added and the component's edge left in place,
    // which is two ways into one sheet and the cascade order back to a coincidence.
    const chunkDirectory = join("panes", "workflow-run", "phase-graph");
    expect(
      stylesheetSpecifiers(readConsoleFile(join(chunkDirectory, "index.ts")), STYLESHEET_IMPORT),
    ).toStrictEqual(["@xyflow/react/dist/base.css", "./phase-graph.css"]);
    expect(
      stylesheetSpecifiers(
        readConsoleFile(join(chunkDirectory, "PhaseGraphCanvas.tsx")),
        STYLESHEET_IMPORT,
      ),
    ).toStrictEqual([]);
  });
});
