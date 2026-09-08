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
import { deferredSheetOffences, undressedEagerReaderOffences } from "./stylesheet-static-reach.js";

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
 *
 * `ledger/cards/cards.css` is the third, and it did not become misplaced — it became
 * VISIBLE. The sheet declared `meridian-ledger-row` in a descendant prelude, which the
 * collision census counted and this gate exempts, so the placement was masked by a
 * collision rather than reported. Resolving that collision — the card's disclosure now
 * carries the primitives family's own reveal-slot class instead — left the real state
 * on the record.
 *
 * That pin was written while the ledger had no chunk root to move the sheet to, and it
 * has one now (`ledger/pane/timeline-pane-body.ts`). What is left is narrower than what
 * it was: `ledger/cards/index.ts` is reachable only from behind that loader, so the sheet
 * ALREADY travels in the timeline chunk rather than on the initial document — measured on
 * the built bundle. What this gate reports is where the sheet ENTERS, and moving that
 * entry to the chunk root reorders it against every other sheet inside that chunk, which
 * is a cascade change carrying its own screenshot references rather than a placement fix.
 * The pin names the fact; making the gate drive that reorder is what its own header
 * refuses.
 */
const PINNED_MISPLACED_SHEETS: readonly string[] = [
  "ledger/cards/cards.css <- ledger/cards/index.ts",
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

/** The console's answer to the same rule read from the other side. */
function consoleUndressedOffences(): readonly string[] {
  const tree = CONSOLE_STYLESHEET_TREE;
  const edges = collectStylesheetEdges(tree);
  const chunkRoots = lazyChunkRoots(tree);
  return undressedEagerReaderOffences(
    tree,
    (stylesheetPath) => edges.get(stylesheetPath)?.[0]?.owningBarrel,
    (modulePath) => chunkRoots.has(modulePath),
  ).map((offence) => `${offence.stylesheetPath} <- ${offence.importer} (${offence.eagerReader})`);
}

describe("the console's deferred stylesheets", () => {
  it("imports a door's unusable sheets from a chunk root instead", () => {
    expect(consoleOffences()).toStrictEqual(PINNED_MISPLACED_SHEETS);
  });

  // The converse, and the failure a person actually sees. The browser family's settings
  // sheet entered through the pane's chunk root while `BrowserSettingsSection` renders
  // from the settings route, which reaches it statically through `browser/index.ts` — so
  // Settings → Browser opened before any browser pane had ever rendered painted its
  // controls with no rules at all, and then started working once an unrelated pane was
  // opened. A ban rather than a pin: no sheet is allowed to be in that state, and the
  // remedy is always the same one the rule states — the sheet enters through the barrel
  // of the directory that owns it.
  it("leaves no sheet on a chunk root that the initial graph renders against", () => {
    expect(consoleUndressedOffences()).toStrictEqual([]);
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

describe("the undressed-reader reader, against planted trees", () => {
  /**
   * A family with two surfaces: one behind a loader, one the settings route mounts.
   *
   * A COMPOSITION ROOT AND NOT JUST A DOOR, because the eager graph is rooted at the
   * modules a tree holds directly under `console/` and a planted tree with only a
   * family in it has no such module — the walk would start nowhere, every set would be
   * empty, and every case below would pass over a reader that answers nothing.
   */
  const mountedSection = new Map<string, string>([
    ["planted-page.ts", 'import { PlantedSection } from "./planted/index.js";\n'],
    [
      "planted/index.ts",
      'export { PlantedSection } from "./settings/PlantedSection.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    ],
    ["planted/settings/PlantedSection.tsx", 'const className = "meridian-planted-section";\n'],
    ["planted/settings/settings.css", ".meridian-planted-section { top: 0; }\n"],
    [
      "planted/pane/planted-pane-body.ts",
      'import "../settings/settings.css";\nimport "./pane.css";\n',
    ],
    ["planted/pane/pane.css", ".meridian-planted-pane { top: 0; }\n"],
  ]);

  function undressedIn(sources: ReadonlyMap<string, string>): readonly string[] {
    const tree = syntheticStylesheetTree(sources);
    const edges = collectStylesheetEdges(tree);
    const chunkRoots = lazyChunkRoots(tree);
    return undressedEagerReaderOffences(
      tree,
      (stylesheetPath) => edges.get(stylesheetPath)?.[0]?.owningBarrel,
      (modulePath) => chunkRoots.has(modulePath),
    ).map((offence) => `${offence.stylesheetPath} (${offence.eagerReader})`);
  }

  // The planted failure: the exact shape the browser family shipped.
  it("reports a chunk-root sheet the initial graph renders against", () => {
    expect(undressedIn(mountedSection)).toStrictEqual([
      "planted/settings/settings.css (planted/settings/PlantedSection.tsx)",
    ]);
  });

  // The fix, asserted as the fix: the same tree with the sheet moved to the door that
  // owns it reports nothing, and the pane's own sheet is left exactly where it was.
  it("reports nothing once the family door imports it", () => {
    const moved = new Map(mountedSection);
    moved.set(
      "planted/index.ts",
      'import "./settings/settings.css";\nexport { PlantedSection } from "./settings/PlantedSection.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    );
    moved.set("planted/pane/planted-pane-body.ts", 'import "./pane.css";\n');
    expect(undressedIn(moved)).toStrictEqual([]);
  });

  // The RESTATEMENT pair, and the reason the reading subtracts what arrives eagerly
  // rather than asking about one sheet at a time. `browser/pane/pane.css` carries
  // `.meridian-browser-chrome .meridian-browser-action` — a rule scoped to a chrome bar
  // the settings page has no ancestor of — so a per-sheet question calls the pane sheet
  // misplaced, which is true of the token match and false of the defect. While nothing
  // eagerly-arriving declares the class, BOTH are reported and the fix is one move.
  it("reports a restating chunk sheet while no eagerly-arriving sheet declares the class", () => {
    const restated = new Map(mountedSection);
    restated.set(
      "planted/pane/pane.css",
      ".meridian-planted-pane { top: 0; }\n.meridian-planted-pane .meridian-planted-section { top: 1px; }\n",
    );
    // Reported in the tree's own order, which is what the console's own claim reads
    // too: one line per sheet, and the fix is the single move both of them name.
    expect(undressedIn(restated)).toStrictEqual([
      "planted/settings/settings.css (planted/settings/PlantedSection.tsx)",
      "planted/pane/pane.css (planted/settings/PlantedSection.tsx)",
    ]);
  });

  // And the other half of that pair, which is the one the console's own tree needs: once
  // the sheet that OWED the rules is at the door, the restatement is not a defect and
  // reports nothing. A reader without the subtraction fails here, on a tree whose
  // settings page is fully dressed.
  it("admits the same restatement once the owing sheet is at the door", () => {
    const dressed = new Map(mountedSection);
    dressed.set(
      "planted/index.ts",
      'import "./settings/settings.css";\nexport { PlantedSection } from "./settings/PlantedSection.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    );
    dressed.set("planted/pane/planted-pane-body.ts", 'import "./pane.css";\n');
    dressed.set(
      "planted/pane/pane.css",
      ".meridian-planted-pane { top: 0; }\n.meridian-planted-pane .meridian-planted-section { top: 1px; }\n",
    );
    expect(undressedIn(dressed)).toStrictEqual([]);
  });

  // The control that keeps the two cases above from passing for the wrong reason. A
  // reader that asked "does ANY module name this class" rather than "does any module on
  // the INITIAL graph name it" would report this sheet, whose only reader is on the far
  // side of the loader — which is the arrangement the whole boundary exists to produce,
  // and reporting it would fail every correctly deferred family in the console.
  it("reports nothing for a sheet whose only reader is behind the loader", () => {
    const deferredReader = new Map(mountedSection);
    deferredReader.set(
      "planted/index.ts",
      'import "./settings/settings.css";\nexport { PlantedSection } from "./settings/PlantedSection.js";\nexport const register = () => import("./pane/planted-pane-body.js");\n',
    );
    deferredReader.set(
      "planted/pane/planted-pane-body.ts",
      'import "./pane.css";\nimport { PlantedPane } from "./PlantedPane.js";\n',
    );
    deferredReader.set(
      "planted/pane/PlantedPane.tsx",
      'const className = "meridian-planted-pane";\n',
    );
    expect(undressedIn(deferredReader)).toStrictEqual([]);
  });
});
