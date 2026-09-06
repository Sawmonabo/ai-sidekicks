// Every console stylesheet enters through the door of the directory that owns it.
//
// `apps/desktop/AGENTS.md` §Module shape states it in one line — "A family's CSS is
// imported from that family's barrel and from nowhere else" — and until this file
// nothing checked it. The rule looked self-enforcing while each family had exactly
// one sheet named after itself; it stops being self-enforcing the moment a family
// splits its sheet by surface, because then there are five files any component in
// the family could reach for and four of them would still look plausible in a diff.
//
// WHAT BREAKS IF IT IS NOT HELD. A stylesheet imported from a component is an edge
// the bundler follows per importing module, so one shape's CSS arrives in whichever
// chunk happened to reach it first — and the terminal family's sheet, which
// `Spec-023 §Console Design (Meridian)` §Budgets deliberately keeps OUT of the
// initial bundle, would land in it the day a statically reached module imported it.
// The single edge at the door is also what makes "no surface can render a shape
// whose CSS never arrived" true: the door is on every path into the family.
//
// WHAT THIS DOES NOT CLAIM. Nothing here is about what the CSS says. The token
// resolution is `test/console/assets/generated-tokens.test.ts`'s and the computed
// geometry is the browser tier's; this file owns the import graph alone.
//
// THE INSTRUMENT IS THE PARSER. A stylesheet edge is an `import` declaration with no
// clause, which is a declaration boundary — and `apps/desktop/AGENTS.md` says to ask
// the compiler about one rather than a pattern. The regular expression this replaced
// could not tell an edge from a sentence about one, so a header explaining WHY a
// component does not import a sheet would have been counted as the import it was
// explaining the absence of.
//
// AND A SUB-MODULE BARREL IS A DOOR TOO. `repos/artifact-pane/index.ts` is a barrel,
// and `apps/desktop/AGENTS.md` gives it the same standing as a family's: the rule keys
// on the directory that OWNS a sheet, and a directory carrying a door owns itself. So
// the question this gate asks is never how deep a barrel sits — it is whether the
// module importing a sheet is the barrel of the directory that holds it. This suite
// asked the depth question for a while and hoisted two pane sheets up into the repos
// family door to satisfy it, which is the reach the rule names in its own words: it
// makes one directory the reason another is styled. No count of edges reports either
// arrangement, since both are exactly one — the predicate is the whole of the ruling.
//
// A LIBRARY'S OWN SHEET IS NOT A FAMILY'S SHEET, so only RELATIVE specifiers are
// read. `terminal/emulator/xterm-adapter.ts` imports `@xterm/xterm/css/xterm.css` from the
// lazy chunk's entry deliberately, and that placement is the point: the emulator's
// grid geometry has to arrive on the same edge as the code that draws the grid, and
// hoisting it to the family door would put it in the document the operator waits
// for. The rule this file holds is about which door a family's OWN sheet enters by.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The one member of Vite's `import.meta` this tier reads, declared where it is read.
 *
 * The architecture tier is a Node program and its `tsconfig` deliberately does not
 * pull in `vite/client` wholesale — the renderer's own `console-env.d.ts` says why
 * for its half — so the member is named structurally at the one call site rather than
 * by widening a config for every gate in the directory. Vitest transforms this file
 * with Vite, so the call itself is resolved at build time exactly as it is in the
 * renderer.
 */
interface ViteGlobImportMeta {
  readonly glob: (
    pattern: string,
    options?: { readonly query?: string },
  ) => Readonly<Record<string, unknown>>;
}

/**
 * Every console source module, through the tier's ONE walk.
 *
 * `source-walk-chokepoint.test.ts` fails a gate that reaches renderer source through
 * a `readdirSync` of its own: five private walks are five slightly different ideas of
 * what counts as source, and the difference between them is invisible until one of
 * them scans a file the others do not — which is how this file came to exclude
 * `.test.` by substring while its neighbours excluded four exact suffixes.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

/**
 * Every stylesheet under the console, console-relative.
 *
 * Through Vite's own module graph rather than through a directory read, because the
 * walk above answers for TypeScript and this claim needs the other half — and a
 * second directory read here is the exact shape the chokepoint forbids. The glob is
 * resolved by the same bundler that resolves the imports these edges are about, so
 * both halves of every assertion below come from one resolver.
 */
const STYLESHEET_PATHS: readonly string[] = Object.keys(
  (import.meta as ImportMeta & ViteGlobImportMeta).glob(
    "../../../src/renderer/src/console/**/*.css",
    { query: "?url" },
  ),
)
  .map((specifier) => consoleRelative(resolve(HERE, specifier)))
  .sort();

/** The one file in a directory that may carry a stylesheet import. */
const FAMILY_DOOR = "index.ts";

/**
 * Whether a console-relative path is a DOOR — the barrel a directory is entered by.
 *
 * Keyed on OWNERSHIP and never on depth. `apps/desktop/AGENTS.md` puts a sheet through
 * the barrel of the directory that owns it: a sub-directory carrying no `index.ts` is
 * owned by its parent, and one carrying a door owns itself. So `sessions/notifications`
 * and `repos/diff-pane` are each where their own sheet enters, and a family door
 * reaching down for either is the shape the rule forbids rather than the tidier form
 * of it — a depth predicate reads that exactly backwards, and this one was one before
 * a sub-module barrel with a sheet of its own arrived to say so.
 */
function isDoorModule(consoleRelativePath: string): boolean {
  return consoleRelativePath === FAMILY_DOOR || consoleRelativePath.endsWith(`/${FAMILY_DOOR}`);
}

/** The extension that makes an import a stylesheet edge. */
const STYLESHEET_EXTENSION = ".css";

/**
 * Every stylesheet specifier `source` imports, as written. Relative only.
 *
 * A pure function over text so the controls below can drive it with strings whose
 * verdict is known. `import.meta.glob` is not an import declaration and is correctly
 * invisible here: the glob above is how this file finds the sheets to count edges
 * INTO, and counting it as an edge would report the counter as a consumer.
 */
function stylesheetSpecifiersIn(fileName: string, source: string): readonly string[] {
  const specifiers: string[] = [];
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }
    const specifier = node.moduleSpecifier.text;
    if (specifier.startsWith(".") && specifier.endsWith(STYLESHEET_EXTENSION)) {
      specifiers.push(specifier);
    }
  });
  return specifiers;
}

/** A path under the console, spelled the way every message here names one. */
function consoleRelative(absolutePath: string): string {
  return relative(CONSOLE_DIRECTORY, absolutePath).split("\\").join("/");
}

/** The family a console-relative path belongs to — its first path segment. */
function familyOf(consoleRelativePath: string): string {
  return consoleRelativePath.split("/")[0] ?? "";
}

/** Every stylesheet a module imports, as console-relative paths. */
function stylesheetImportsOf(consoleRelativePath: string): readonly string[] {
  const source = readModuleNamed(CONSOLE_MODULES, `console/${consoleRelativePath}`);
  const importedFrom = dirname(consoleRelativePath);
  return stylesheetSpecifiersIn(consoleRelativePath, source).map((specifier) =>
    consoleRelative(resolve(CONSOLE_DIRECTORY, importedFrom, specifier)),
  );
}

describe("stylesheet edges — a sheet enters at the door of the directory that owns it", () => {
  const stylesheets = STYLESHEET_PATHS;
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds the console's stylesheets and modules at all", () => {
    // Without this, a wrong root would scan nothing and every assertion below would
    // pass over the empty set.
    expect(stylesheets.length).toBeGreaterThan(4);
    expect(modules.length).toBeGreaterThan(100);
  });

  it("is imported by no module but a door", () => {
    const offenders = modules
      .filter((module) => !isDoorModule(module))
      .flatMap((module) => stylesheetImportsOf(module).map((sheet) => `${module} -> ${sheet}`));
    expect(offenders).toStrictEqual([]);
  });

  it("is imported by its OWN family's door and no other", () => {
    // A submodule reaching for a sibling family's sheet is the same defect one level
    // out: the sheet then arrives on whichever chunk that family lands in.
    const crossFamilyEdges = modules
      .filter((module) => isDoorModule(module))
      .flatMap((door) =>
        stylesheetImportsOf(door)
          .filter((sheet) => familyOf(sheet) !== familyOf(door))
          .map((sheet) => `${door} -> ${sheet}`),
      );
    expect(crossFamilyEdges).toStrictEqual([]);
  });

  it("is reached by exactly one import, and every sheet is reached", () => {
    // Two edges into one sheet is two chunks that may both carry it; zero is a shape
    // that renders unstyled, which in this console is a pane with no geometry at all.
    const edgeCountBySheet = new Map(stylesheets.map((sheet) => [sheet, 0]));
    for (const module of modules) {
      for (const sheet of stylesheetImportsOf(module)) {
        edgeCountBySheet.set(sheet, (edgeCountBySheet.get(sheet) ?? 0) + 1);
      }
    }
    const wrongEdgeCounts = [...edgeCountBySheet]
      .filter(([, count]) => count !== 1)
      .map(([sheet, count]) => `${sheet}: ${String(count)}`);
    expect(wrongEdgeCounts).toStrictEqual([]);
  });

  it("negative control: the checker reads a submodule's import and a door's", () => {
    // The clean results above mean nothing unless the reader recognises the two
    // shapes it is looking for. Read out of the real tree rather than asserted about
    // it: the browser family's door carries its five sheets, and the component beside
    // it carries none.
    const doorEdges = stylesheetImportsOf(`browser/${FAMILY_DOOR}`);
    expect(doorEdges.length).toBeGreaterThan(1);
    expect(doorEdges.every((sheet) => familyOf(sheet) === "browser")).toBe(true);
    expect(stylesheetImportsOf("browser/bounds/BudgetMeter.tsx")).toStrictEqual([]);
  });

  it("negative control: a sentence about an import is not an edge", () => {
    // What the regular expression could not tell apart. A component explaining why it
    // does NOT carry its family's sheet names the import it is not writing, and a
    // reader that counted that would report the explanation as the defect.
    expect(
      stylesheetSpecifiersIn(
        "Pane.tsx",
        '// Deliberately no `import "./browser.css";` here -- the door carries it.\nexport const x = 1;',
      ),
    ).toStrictEqual([]);
    expect(
      stylesheetSpecifiersIn("index.ts", 'import "./browser.css";\nexport const x = 1;'),
    ).toStrictEqual(["./browser.css"]);
  });

  it("negative control: a sub-module barrel IS a door, and a component is not", () => {
    // Planted as text so the two verdicts keep being made after the real modules move.
    // An edge count cannot separate them — a sheet reached from a family door and one
    // reached from its own sub-module barrel are both exactly one edge — so the
    // predicate is the whole of the ruling, and it is the half this suite got wrong:
    // `repos/artifact-pane/index.ts` answered false under a depth rule, which ordered
    // the sheet UP into the family door and called the violation the fix.
    expect(isDoorModule("repos/artifact-pane/index.ts")).toBe(true);
    expect(isDoorModule("sessions/notifications/index.ts")).toBe(true);
    expect(isDoorModule(`repos/${FAMILY_DOOR}`)).toBe(true);
    expect(isDoorModule("repos/mounts/RepoSection.tsx")).toBe(false);
    expect(isDoorModule("repos/diff-pane/diff-bounds.ts")).toBe(false);
    // And the legitimate reach a door still has: `repos/mounts/` carries no barrel, so
    // the family door is what owns its sheet.
    expect(stylesheetSpecifiersIn("repos/index.ts", 'import "./mounts/mounts.css";')).toStrictEqual(
      ["./mounts/mounts.css"],
    );
  });

  it("negative control: the two forms a line-anchored pattern could not see", () => {
    // Both are legal TypeScript and both were invisible to `/^import\s+"…";$/gm`: a
    // statement terminated by ASI rather than by a semicolon, and one that is not at
    // column zero. A gate that cannot see an import cannot rule on it, and neither
    // form is rare enough to call unreachable.
    expect(stylesheetSpecifiersIn("index.ts", 'import "./repos.css"\n')).toStrictEqual([
      "./repos.css",
    ]);
    expect(stylesheetSpecifiersIn("index.ts", '  import "./repos.css";\n')).toStrictEqual([
      "./repos.css",
    ]);
  });

  it("negative control: a library's own sheet is not a family's", () => {
    // The relative-only rule, as a case. The emulator's `@xterm/xterm/css/xterm.css`
    // rides the lazy chunk's entry on purpose, and reporting it would push a
    // deliberate placement into the family door and into the initial bundle.
    expect(
      stylesheetSpecifiersIn("xterm-adapter.ts", 'import "@xterm/xterm/css/xterm.css";'),
    ).toStrictEqual([]);
  });
});
