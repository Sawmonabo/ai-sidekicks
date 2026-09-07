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
//
// AND A SHEET IS REACHED THROUGH A CHAIN AS WELL AS THROUGH A DOOR. A family whose
// sheet grew past one file may pull its parts in with `@import` at the head of the
// family sheet instead of adding a module edge per part, and both spellings arrive on
// the same chunk. A reachability claim that counted only module edges would report
// three such sheets as reached by nothing at all — rules that were written and never
// paint — so the count below takes both kinds of edge, and the graph that walks the
// chains is `stylesheet-edge-graph.ts` next door, where a planted tree proves a
// duplicate or a misowned edge is really counted.
//
// OWNERSHIP IS THE NEAREST DOOR ABOVE A SHEET, WHICH IS NARROWER THAN ITS FAMILY. The
// family-scoped claim above passes a door that reaches into a sub-directory carrying a
// door of its own, and that is a real shape: a family sheet that used to `@import` a
// sub-surface's rules is one edge away from being the second way into them. So the
// fourth claim asks which door OWNS each sheet rather than which family it sits in.

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";
import {
  collectStylesheetEdges,
  isOwningBarrel,
  lazyChunkRoots,
  readConsoleFile,
  stylesheetEdgeOffences,
  CONSOLE_STYLESHEET_TREE,
} from "./stylesheet-edge-graph.js";
import { moduleStylesheetImports, stylesheetAtImports } from "./stylesheet-specifiers.js";

/**
 * The budget this file states rather than inherits.
 *
 * Its claim is a parse pass over every console module, so what it costs is a
 * property of the TREE and grows with it. Measured on the authoring machine with a
 * warm transform cache and this file's neighbours for company, the pass is 2242 ms
 * — and on a cold cache, or under the aggregate gate's five-project concurrency, the
 * same pass crossed vitest's 5 s default with no change to the code it reads. That is
 * how it was found: two view families landed, the tree grew, and four whole-tree
 * gates that had never stated a budget began timing out on the load rather than on a
 * defect.
 *
 * Set well above the loaded measurement on purpose, and to the figure
 * `source-walk-chokepoint.test.ts` already states for the same reason: what a budget
 * guards is a pass that never settles, not a slow one, and a budget tightened to the
 * last measurement fails on the next machine rather than on the next defect.
 */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

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
 * The console's lazily imported chunk roots, resolved once for this file.
 *
 * Read off the shared tree rather than re-derived here, so the two claims below and the
 * walk next door answer "is this a door" from one graph. The paths come back separated
 * by the platform's separator and this file speaks in POSIX ones, which is the whole of
 * the normalisation.
 */
const CONSOLE_CHUNK_ROOTS: ReadonlySet<string> = new Set(
  [...lazyChunkRoots(CONSOLE_STYLESHEET_TREE)].map((modulePath) => modulePath.split(sep).join("/")),
);

/**
 * Whether a console-relative path is a DOOR — a module a directory is entered by.
 *
 * Keyed on OWNERSHIP and never on depth. `apps/desktop/AGENTS.md` puts a sheet through
 * the barrel of the directory that owns it: a sub-directory carrying no `index.ts` is
 * owned by its parent, and one carrying a door owns itself. So `sessions/notifications`
 * and `repos/diff-pane` are each where their own sheet enters, and a family door
 * reaching down for either is the shape the rule forbids rather than the tidier form
 * of it — a depth predicate reads that exactly backwards, and this one was one before
 * a sub-module barrel with a sheet of its own arrived to say so.
 *
 * AND A LAZILY IMPORTED CHUNK ROOT IS A DOOR, on the reason the barrel is one: what the
 * rule wants is the module that is the single way into the code the sheet paints, and a
 * chunk root is exactly that — the loader's `import()` is the only static reference to
 * it. `seats/lazy-body.ts` made that the registration form for a body off the flagship
 * first paint, and the sheets those bodies paint with belong on their chunk rather than
 * on the document the launch is measured by. The set is derived from the graph and never
 * from a name: a module nothing lazily imports is not admitted by being called one.
 */
function isDoorModule(consoleRelativePath: string): boolean {
  return (
    consoleRelativePath === FAMILY_DOOR ||
    consoleRelativePath.endsWith(`/${FAMILY_DOOR}`) ||
    CONSOLE_CHUNK_ROOTS.has(consoleRelativePath)
  );
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

  it("counts edges over the same sheets this file found", () => {
    // TWO RESOLVERS ANSWER "WHICH STYLESHEETS EXIST" HERE — Vite's module graph
    // above, and the tier's shared walk inside `CONSOLE_STYLESHEET_TREE`, which the
    // two reachability claims below quantify over. While they agree nothing reports
    // it, and the failure is silent in one direction only: a model tree holding
    // FEWER sheets leaves "every sheet is reached" clean about the sheets it happened
    // to hold rather than about the console, and the floor above would not notice
    // because it counts the other list. An empty MODULE list fails loudly instead —
    // no edges are collected, so every sheet reports unreached — which is why this
    // control is about the sheets. So the two lists are compared rather than trusted.
    const walked = CONSOLE_STYLESHEET_TREE.stylesheetPaths.map((sheetPath) =>
      sheetPath.split(sep).join("/"),
    );
    expect([...walked].sort()).toStrictEqual([...stylesheets].sort());
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

  it("every stylesheet in the tree is reached from a barrel, exactly once", () => {
    // The other half, in three parts: a sheet no barrel reaches is rules that were
    // written and never paint, which a rule about importers alone cannot see; a sheet
    // reached twice is a cascade whose order depends on the module graph, which a
    // collapsed reachability set could not see at all. Both kinds of edge count — a
    // door's module import and an `@import` at the head of a sheet a door reaches —
    // because both put the rules on the same chunk.
    const offences = stylesheetEdgeOffences(
      CONSOLE_STYLESHEET_TREE,
      collectStylesheetEdges(CONSOLE_STYLESHEET_TREE),
    );
    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
  });

  it("and from the barrel of the directory that owns it, never a neighbour's", () => {
    // The fourth claim, over the real console. A family door pulling in the sheets of
    // its own doorless sub-directories is the intended shape and passes; a family
    // sheet reaching into a directory that carries a door does not.
    const offences = stylesheetEdgeOffences(
      CONSOLE_STYLESHEET_TREE,
      collectStylesheetEdges(CONSOLE_STYLESHEET_TREE),
    );
    expect(offences.misowned).toStrictEqual([]);
  });

  it("negative control: the checker reads a submodule's import and a door's", () => {
    // The clean results above mean nothing unless the reader recognises the two
    // shapes it is looking for. Read out of the real tree rather than asserted about
    // it, and read at BOTH kinds of door now that a family's sheets may enter at a
    // lazy chunk root instead: the repos family's door carries several sheets, the
    // browser family's pane body carries the five that used to sit on the browser
    // door, and the component beside that body carries none. The browser door itself
    // is deliberately not the sample any more — it carries no sheet at all, so a
    // reader that had stopped seeing imports would still pass there.
    const doorEdges = stylesheetImportsOf(`repos/${FAMILY_DOOR}`);
    expect(doorEdges.length).toBeGreaterThan(1);
    expect(doorEdges.every((sheet) => familyOf(sheet) === "repos")).toBe(true);
    const chunkRootEdges = stylesheetImportsOf("browser/pane/browser-pane-body.ts");
    expect(chunkRootEdges.length).toBeGreaterThan(1);
    expect(chunkRootEdges.every((sheet) => familyOf(sheet) === "browser")).toBe(true);
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

  it("negative control: the checker matches the edges that are really there", () => {
    // Without this a typo in either pattern would make both clean results above
    // meaningless against THIS tree — the walk's own controls drive literal sources,
    // and a pattern that matched none of the console's real text would still satisfy
    // them.
    expect(
      moduleStylesheetImports(
        join("workflows", "index.ts"),
        readConsoleFile(join("workflows", "index.ts")),
      ),
      // The family door's one remaining sheet. Its own chrome moved to the three chunk
      // roots when the last of its bodies went behind a loader; what stays is the run
      // list's sheet, whose cascade position is shared with the runs family.
    ).toStrictEqual(["./runs/run-list.css"]);
    expect(
      stylesheetAtImports(
        join("workflows", "workflows.css"),
        readConsoleFile(join("workflows", "workflows.css")),
      ),
    ).toStrictEqual(["./parks/park-badge.css"]);
    // And the door this family's destination now enters on, so the pattern is shown to
    // match a module edge one directory down as well as the family's own.
    expect(
      moduleStylesheetImports(
        join("workflows", "destination", "index.ts"),
        readConsoleFile(join("workflows", "destination", "index.ts")),
      ),
    ).toStrictEqual(["./workflows-destination.css"]);
  });

  it("negative control: a direct import in a component is flagged, a barrel's is not", () => {
    // The two sides of the line, driven through the predicate rather than through
    // whichever module happens to hold an edge today.
    const componentSource = 'import "./workflows-destination.css";\n';
    expect(
      moduleStylesheetImports(join("workflows", "WorkflowsDestination.tsx"), componentSource),
    ).toStrictEqual(["./workflows-destination.css"]);
    expect(isOwningBarrel(join("workflows", "WorkflowsDestination.tsx"))).toBe(false);
    expect(isOwningBarrel(join("workflows", "index.ts"))).toBe(true);
  });

  it("the lazy chunk's door owns its sheets, and the component in it owns none", () => {
    // The case the rule was restated for, asserted from the tree rather than from a
    // path this file remembers: the door imports the library's sheet and this
    // directory's, in that order, and the canvas behind it imports neither. Without
    // the second half the door could be added and the component's edge left in place,
    // which is two ways into one sheet and the cascade order back to a coincidence.
    const chunkDirectory = join("workflows", "pane", "run", "phase-graph");
    expect(
      moduleStylesheetImports(
        join(chunkDirectory, "index.ts"),
        readConsoleFile(join(chunkDirectory, "index.ts")),
      ),
    ).toStrictEqual(["@xyflow/react/dist/base.css", "./phase-graph.css"]);
    expect(
      moduleStylesheetImports(
        join(chunkDirectory, "PhaseGraphCanvas.tsx"),
        readConsoleFile(join(chunkDirectory, "PhaseGraphCanvas.tsx")),
      ),
    ).toStrictEqual([]);
  });
});
