// A sheet nothing on the door's graph can use belongs at the chunk root that reaches it.
//
// WHAT THIS IS FOR. A family whose bodies register through loaders keeps its code off
// the initial import graph and then, if nobody checks, leaves its CSS on it — so every
// session downloads and parses rules for a surface it never opens. The `browser`,
// `terminal`, and `agents` families each shipped that way: one loader-backed
// registration, five or four sheets at the door, and nothing statically reachable from
// that door able to render against any of them.
//
// THE TEST IS THE MODULE GRAPH AND NOT THE DIRECTORY. `stylesheet-static-reach.ts` asks
// whether any module the sheet's own owning barrel reaches WITHOUT crossing an
// `import()` names a class the sheet declares. Rooted at the barrel rather than at the
// bundle's entry, for the reason that module records: the renderer enters the console in
// more places than a list can be trusted to hold, and a forgotten one reports a
// perfectly placed sheet as unusable.
//
// AND THE CASCADE OVERRIDES IT. A sheet declaring a class another family also declares
// is resolved by load order, so deferring it restyles that other family's surface — the
// defect `runs/index.ts` records measuring. `stylesheet-selector-owners.test.ts` holds
// that census; a sheet named in it is exempt here and stays at its door until the
// collision itself is settled.
//
// A PIN AND NOT A BAN, for that census's reason: two sheets are misplaced today, in
// families this file's diff did not convert. Naming them is what makes a THIRD a
// failure, and the comparison is equality, so fixing one without trimming the pin fails
// too.

import { describe, expect, it, vi } from "vitest";

import {
  CONSOLE_STYLESHEET_TREE,
  collectStylesheetEdges,
  lazyChunkRoots,
  syntheticStylesheetTree,
} from "./stylesheet-edge-graph.js";
import { consoleStylesheetTexts, crossFamilyCollisions } from "./stylesheet-selector-owners.js";
import { declaredClassNames } from "./stylesheet-selectors.js";
import { deferredSheetOffences } from "./stylesheet-static-reach.js";

/** Parsing the console's modules twice over; ~2s on the authoring machine. */
vi.setConfig({ testTimeout: 60_000 });

/**
 * Every sheet a family door still imports that only a deferred chunk can render.
 *
 * `repos/artifacts/artifacts.css` is the repos family's, whose panes this branch did not
 * convert. `runs/pane/interventions/run-interventions.css` is pinned by its SIBLING:
 * `runs/pane/runs.css` declares three classes the workflows family also declares and
 * therefore cannot move, and the two sheets are written as a pair — rules addressing
 * selectors in both live in `runs.css` as single declarations — so moving one alone
 * reorders them against each other.
 */
const PINNED_MISPLACED_SHEETS: readonly string[] = [
  "repos/artifacts/artifacts.css <- repos/index.ts",
  "runs/pane/interventions/run-interventions.css <- runs/index.ts",
];

/** The console's own answer to the four questions the census asks. */
function consoleOffences(): readonly string[] {
  const tree = CONSOLE_STYLESHEET_TREE;
  const edges = collectStylesheetEdges(tree);
  const chunkRoots = lazyChunkRoots(tree);
  const collidingClassNames = new Set(
    crossFamilyCollisions(consoleStylesheetTexts()).map((collision) => collision.className),
  );
  return deferredSheetOffences(
    tree,
    (stylesheetPath) => edges.get(stylesheetPath)?.[0]?.owningBarrel,
    (stylesheetPath) =>
      [...declaredClassNames(tree.read(stylesheetPath))].some((className) =>
        collidingClassNames.has(className),
      ),
    (modulePath) => chunkRoots.has(modulePath),
  ).map((offence) => `${offence.stylesheetPath} <- ${offence.importer}`);
}

describe("the console's deferred stylesheets", () => {
  it("imports a door's unusable sheets from a chunk root instead", () => {
    expect(consoleOffences()).toStrictEqual(PINNED_MISPLACED_SHEETS);
  });

  // The positive control. A census that resolved no importer at all would report an
  // empty offence list and satisfy nothing, which is what a broken edge walk looks like
  // from the outside.
  it("reaches every console stylesheet from some importer", () => {
    const edges = collectStylesheetEdges(CONSOLE_STYLESHEET_TREE);
    const unreached = CONSOLE_STYLESHEET_TREE.stylesheetPaths.filter(
      (stylesheetPath) => edges.get(stylesheetPath) === undefined,
    );
    expect(unreached).toStrictEqual([]);
    expect(CONSOLE_STYLESHEET_TREE.stylesheetPaths.length).toBeGreaterThan(40);
  });
});

describe("the deferred-sheet reader, against planted trees", () => {
  const never = (): boolean => false;

  /** A family whose one body is loader-backed, with its sheet still at the door. */
  const deferredFamily = new Map<string, string>([
    [
      "planted/index.ts",
      'import "./pane/pane.css";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    ],
    ["planted/pane/planted-pane-body.ts", 'import { PlantedPane } from "./PlantedPane.js";\n'],
    ["planted/pane/PlantedPane.tsx", 'const className = "meridian-planted-pane";\n'],
    ["planted/pane/pane.css", ".meridian-planted-pane { top: 0; }\n"],
  ]);

  function offencesIn(sources: ReadonlyMap<string, string>): readonly string[] {
    const tree = syntheticStylesheetTree(sources);
    const edges = collectStylesheetEdges(tree);
    const chunkRoots = lazyChunkRoots(tree);
    return deferredSheetOffences(
      tree,
      (stylesheetPath) => edges.get(stylesheetPath)?.[0]?.owningBarrel,
      never,
      (modulePath) => chunkRoots.has(modulePath),
    ).map((offence) => offence.stylesheetPath);
  }

  // The planted failure: the exact shape the browser family shipped.
  it("reports a door sheet whose only reader is behind an import()", () => {
    expect(offencesIn(deferredFamily)).toStrictEqual(["planted/pane/pane.css"]);
  });

  // The fix, asserted as the fix: the same tree with the import moved reports nothing.
  it("reports nothing once the chunk root imports it", () => {
    const moved = new Map(deferredFamily);
    moved.set(
      "planted/index.ts",
      'export const register = () => import("./pane/planted-pane-body.js");\n',
    );
    moved.set(
      "planted/pane/planted-pane-body.ts",
      'import "./pane.css";\nimport { PlantedPane } from "./PlantedPane.js";\n',
    );
    expect(offencesIn(moved)).toStrictEqual([]);
  });

  // The other exoneration, and the one that keeps the rule honest: a sheet a STATICALLY
  // reachable module can render against belongs where it is, whatever else the family
  // defers.
  it("reports nothing when the door itself reaches a reader", () => {
    const staticReader = new Map(deferredFamily);
    staticReader.set(
      "planted/index.ts",
      'import "./pane/pane.css";\nimport { PlantedPane } from "./pane/PlantedPane.js";\n',
    );
    expect(offencesIn(staticReader)).toStrictEqual([]);
  });

  // The reversal the reach reader used to get wrong, planted as a pair. A type-only
  // edge is erased before the bundler sees it, so the component it names is NOT in the
  // door's chunk — but the walk followed it anyway and reported the door as reaching a
  // user, which turned the offence off. The failure was silent in the one direction that
  // matters here: this predicate reports on finding NO user, so a reach set that is too
  // wide admits exactly the regression the gate exists to reject.
  it("reports a door sheet whose only reader it reaches through an `import type`", () => {
    const typeOnlyEdge = new Map(deferredFamily);
    typeOnlyEdge.set(
      "planted/index.ts",
      'import "./pane/pane.css";\nimport type { PlantedPaneProps } from "./pane/PlantedPane.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    );
    expect(offencesIn(typeOnlyEdge)).toStrictEqual(["planted/pane/pane.css"]);
  });

  // The negative control for it, and the one that keeps the skip honest: the same edge
  // written as a VALUE import puts the component in the door's chunk, and the sheet is
  // then exactly where it belongs.
  it("admits the same sheet when that edge is a value import", () => {
    const valueEdge = new Map(deferredFamily);
    valueEdge.set(
      "planted/index.ts",
      'import "./pane/pane.css";\nimport { PlantedPane } from "./pane/PlantedPane.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    );
    expect(offencesIn(valueEdge)).toStrictEqual([]);
  });

  // A sheet nothing declares against is not a placement question at all.
  it("mints no offence from a sheet that declares no class", () => {
    const tokensOnly = new Map(deferredFamily);
    tokensOnly.set("planted/pane/pane.css", ":root { --meridian-planted: 1px; }\n");
    expect(offencesIn(tokensOnly)).toStrictEqual([]);
  });
});
