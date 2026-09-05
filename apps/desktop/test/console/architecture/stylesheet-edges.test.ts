// Where the console's rules enter the bundle, asserted.
//
// `apps/desktop/AGENTS.md` gives the rule in one line — a stylesheet enters through
// the barrel of the family or of the lazily-loaded chunk that owns it, and through no
// component — and until this file nothing checked it. Two families had already grown a
// second edge: `workflows-destination.css` was imported straight from its component
// while `workflows.css` did not `@import` it, so a family had two ways into its own
// rules and which one won depended on which component modules a build happened to
// reach first. That is not a formatting preference. Cascade order decides which rule
// paints, so a second edge makes the paint depend on the module graph.
//
// THREE CLAIMS, AND THEY CATCH DIFFERENT DEFECTS. One: only an owning barrel imports
// a stylesheet. Two: every stylesheet in the tree is REACHED, from a barrel directly
// or through an `@import` chain. Three: it is reached ONCE — one inbound edge, from
// one barrel. The first alone would pass over a sheet nobody imports at all, which is
// rules that were written and never paint; the second alone would pass over a sheet
// reached twice.
//
// THE WALK IS NEXT DOOR, AND SO ARE ITS CONTROLS. `stylesheet-edge-graph.ts` owns the
// model — the tree it reads, the edges it keeps, and the three ways a tree can offend
// — because proving that a duplicate edge is really counted needs a tree with a
// planted duplicate in it, and planting one here would mean a test writing into the
// console's source. This file makes the claims; that file's test makes them worth
// their green.
//
// THERE IS NO EXEMPTION LIST, AND THAT IS THE POINT OF THE RULE'S SHAPE. A lazily
// loaded chunk owns sheets that must NOT ride the initial document — the graph
// library's `base.css` and `phase-graph.css` are the pair today — and an earlier
// revision admitted them by writing the importing COMPONENT's path into this file,
// which excepted the convention rather than enforcing it. The chunk has a door of its
// own now, the `import()` names that door, and the barrel predicate admits it for the
// same reason it admits every other barrel — no path written out, and nothing here to
// keep in step with a component that moves.

import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectStylesheetEdges,
  isOwningBarrel,
  readConsoleFile,
  stylesheetEdgeOffences,
  stylesheetSpecifiers,
  CONSOLE_STYLESHEET_TREE,
  STYLESHEET_AT_IMPORT,
  STYLESHEET_IMPORT,
} from "./stylesheet-edge-graph.js";

describe("stylesheet edges — a family's rules enter the bundle once", () => {
  const modules = CONSOLE_STYLESHEET_TREE.modulePaths;
  const stylesheets = CONSOLE_STYLESHEET_TREE.stylesheetPaths;

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
    // The other half, in three parts: a sheet no barrel reaches is rules that were
    // written and never paint, which a rule about importers alone cannot see; a sheet
    // reached twice is a cascade whose order depends on the module graph, which a
    // collapsed reachability set could not see at all.
    const offences = stylesheetEdgeOffences(
      CONSOLE_STYLESHEET_TREE,
      collectStylesheetEdges(CONSOLE_STYLESHEET_TREE),
    );
    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
  });

  it("negative control: the checker matches the edges that are really there", () => {
    // Without this a typo in either pattern would make both clean results above
    // meaningless against THIS tree — the walk's own controls drive literal sources,
    // and a pattern that matched none of the console's real text would still satisfy
    // them.
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
    const chunkDirectory = join("workflows", "pane", "run", "phase-graph");
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
