// The composer's workflow picker is not on the graph every session pays for.
//
// WHAT THIS IS FOR. The `+` disclosure in the composer's accessory rail is closed until
// somebody presses it, and its "Start a workflow" entry is a body the workflows family
// owns. `apps/desktop/AGENTS.md` states the test that decides the registration form —
// "is this painted before a person acts?" — and a menu behind a disclosure is not, so
// the picker and the sheet it draws against belong on their own chunk.
//
// THE DEFECT THIS WAS WRITTEN AGAINST. The rail imported `WorkflowStartMenu` from the
// workflows door, and the door re-exported it from `start/WorkflowStartMenu.js` and
// imported `start/workflow-start-menu.css` beside it. `families.ts` imports that door
// eagerly to register the family's surfaces, so BOTH paths were static: the picker, the
// definition directory it reads through, the start act it dispatches, and the family's
// menu sheet all sat in the entry chunk of every session, including every session whose
// composer never opened that menu.
//
// TWO CLAIMS BECAUSE THERE WERE TWO PATHS, and either one alone puts the body back.
// Deleting the door line while the rail deep-imported the component would be caught by
// `structure:layering`'s door rule and not by a reach walk; deleting the rail's import
// while the door still re-exported the component would leave the body on the eager graph
// with nothing here disagreeing. So the claim is made from each importer in turn, which
// is the local-and-exact form `StylesheetReachIndex.reachableFrom` documents: whatever
// else reaches these two modules, these two modules reach what they reach.
//
// THE TREE SPANS THE SHELL, which the console-only one cannot. `ComposerAccessoryRail`
// lives in `src/renderer/src/shell/`, so a walk over `CONSOLE_STYLESHEET_TREE` holds
// neither the rail nor the edge it writes and would answer the empty set for a question
// it never asked. `RENDERER_STYLESHEET_TREE` holds both roots and keys them by display
// path, which is what lets the rail's `../../../console/workflows/index.js` resolve.
//
// AND THE CHUNK DIRECTORY IS READ FROM THE DOOR'S OWN LOADER rather than written here,
// on `lazy-chunk-isolation.test.ts`' rule: moving the picker moves the claim with it,
// and deleting the loader fails the derivation rather than quietly asserting nothing
// about a directory no registration names any more.

import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RENDERER_STYLESHEET_TREE,
  resolveStylesheet,
  syntheticStylesheetTree,
} from "./stylesheet-edge-graph.js";
import { dynamicImportSpecifiers } from "./stylesheet-specifiers.js";
import { StylesheetReachIndex } from "./stylesheet-static-reach.js";

/** The workflows family's door, which registers the picker's loader. */
const WORKFLOWS_DOOR = "console/workflows/index.ts";

/** The composer surface that mounts the picker's seat. */
const COMPOSER_RAIL = "shell/composer/accessories/ComposerAccessoryRail.tsx";

/** The console module that composes every view family in, so the door is eagerly reached. */
const CONSOLE_FAMILIES = "console/families.ts";

/**
 * The directory the picker's chunk root lives in, read out of the door's own loaders.
 *
 * SELECTED BY WHERE IT RESOLVES rather than by position in the list: the door carries a
 * loader per registration — two pane bodies, two surfaces, and this seat — and which one
 * is written first is an editing detail. Throwing when the count is not one is what makes
 * the claims below non-vacuous: a door that stopped naming a module under `start/` would
 * fail here rather than quantify a reach claim over an empty prefix.
 */
function workflowStartChunkDirectory(): string {
  const source = RENDERER_STYLESHEET_TREE.read(WORKFLOWS_DOOR);
  const resolvedRoots = dynamicImportSpecifiers(WORKFLOWS_DOOR, source)
    .map((specifier) => resolveStylesheet(WORKFLOWS_DOOR, specifier))
    .filter((resolved): resolved is string => resolved !== undefined)
    .filter((resolved) => resolved.startsWith("console/workflows/start/"));
  const [chunkRoot] = resolvedRoots;
  if (resolvedRoots.length !== 1 || chunkRoot === undefined) {
    throw new Error(
      `${WORKFLOWS_DOOR} must carry exactly one loader naming a module under ` +
        `console/workflows/start/ — the composer picker's chunk root — and carries ` +
        `${String(resolvedRoots.length)}. A seat whose body the door reaches statically ` +
        "puts the picker on every session's initial graph.",
    );
  }
  return `${posix.dirname(chunkRoot)}${posix.sep}`;
}

/** Everything `entry` reaches without crossing an `import()`, inside `directory`. */
function eagerlyReachedInside(entry: string, directory: string): readonly string[] {
  const index = new StylesheetReachIndex(RENDERER_STYLESHEET_TREE);
  return [...index.reachableFrom(entry)]
    .filter((modulePath) => modulePath.startsWith(directory))
    .sort();
}

describe("the composer's workflow picker", () => {
  it("is not reachable from the accessory rail without crossing its loader", () => {
    const directory = workflowStartChunkDirectory();
    expect(
      eagerlyReachedInside(COMPOSER_RAIL, directory),
      `${directory} is behind a loader, so the composer's rail may not reach it ` +
        "statically. The usual cause is a component import written straight at the " +
        "workflows door: the rail is on every session's initial graph, so whatever it " +
        "names is in the entry chunk whichever form the registration takes.",
    ).toStrictEqual([]);
  });

  it("is not reachable from the workflows door either", () => {
    const directory = workflowStartChunkDirectory();
    expect(
      eagerlyReachedInside(WORKFLOWS_DOOR, directory),
      `${directory} is behind a loader, and ${CONSOLE_FAMILIES} imports ` +
        `${WORKFLOWS_DOOR} eagerly to register this family — so a door line naming the ` +
        "picker, or a sheet import reaching into its directory, puts the body back on " +
        "every launch's initial graph while the loader beside it still reads deferred.",
    ).toStrictEqual([]);
  });

  it("resolves its chunk root to the workflows family's start directory", () => {
    // What the derivation is worth is what it names. A loader resolving into some other
    // subtree would make both claims above true about a directory no seat registers from,
    // which is the shape a moved body leaves behind.
    expect(workflowStartChunkDirectory()).toBe("console/workflows/start/");
  });

  it("floor: the walk crosses from the shell into the workflows family", () => {
    // The negative control both clean results need. A reach index that resolved nothing
    // across the root boundary — a specifier this tree could not key, a shell module the
    // walk never admitted — would report the empty set and read as a clean boundary. The
    // rail demonstrably reaches the workflows door and the door demonstrably reaches its
    // own registrations, so the picker's absence is a fact about the picker.
    const index = new StylesheetReachIndex(RENDERER_STYLESHEET_TREE);
    const fromRail = index.reachableFrom(COMPOSER_RAIL);
    expect(fromRail.has(WORKFLOWS_DOOR)).toBe(true);
    expect(index.reachableFrom(CONSOLE_FAMILIES).has(WORKFLOWS_DOOR)).toBe(true);
  });

  it("negative control: a planted static import into the chunk directory is reported", () => {
    // The one arm the console's own tree cannot reach once the fix has landed, driven
    // rather than reasoned about. A synthetic tree plants exactly the defect this file
    // was written against — a rail naming the picker through the family door, and a door
    // re-exporting it — and the same derivation reports both modules.
    const planted = syntheticStylesheetTree(
      new Map([
        [
          "shell/composer/accessories/ComposerAccessoryRail.tsx",
          'import { WorkflowStartMenu } from "../../../console/workflows/index.js";\n',
        ],
        [
          "console/workflows/index.ts",
          'import "./start/workflow-start-menu.css";\n' +
            'export { WorkflowStartMenu } from "./start/WorkflowStartMenu.js";\n' +
            'const paneBody = () => import("./start/workflow-start-menu-body.js");\n',
        ],
        [
          "console/workflows/start/WorkflowStartMenu.tsx",
          "export function WorkflowStartMenu() {}\n",
        ],
        [
          "console/workflows/start/workflow-start-menu-body.ts",
          "export const Body = () => null;\n",
        ],
      ]),
    );
    const plantedIndex = new StylesheetReachIndex(planted);
    const reached = [...plantedIndex.reachableFrom(COMPOSER_RAIL)]
      .filter((modulePath) => modulePath.startsWith("console/workflows/start/"))
      .sort();
    expect(reached).toStrictEqual(["console/workflows/start/WorkflowStartMenu.tsx"]);
    // And the loader's own target is NOT reached, which is what shows the walk stops at
    // an `import()` rather than reporting every module in the directory.
    expect(reached).not.toContain("console/workflows/start/workflow-start-menu-body.ts");
  });
});
