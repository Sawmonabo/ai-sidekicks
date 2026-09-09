// Every console stylesheet can reach the document the renderer mounts.
//
// A SIBLING RATHER THAN A SIXTH CASE IN `stylesheet-edges.test.ts`, and the reason is
// that suite's own header: its subject is stated in its first line — "Every console
// stylesheet enters through the door of the directory that owns it" — and restated in
// its "WHAT THIS DOES NOT CLAIM" paragraph. Reachability is not a narrower reading of
// ownership; it is the question ownership presumes an answer to. Its floor also pins
// the sheets Vite's glob finds against the tier walk's list, and this claim quantifies
// over a THIRD tree — the whole package, so the walk can start above the console at the
// renderer entry — which that equality would have to be widened to admit and would then
// stop being the control it is.
//
// WHAT IT CATCHES THAT NOTHING ELSE DOES. A sheet owned correctly by a barrel that
// nothing imports is four green claims and no rules on screen. The live instance was
// `primitives/reading/partial-read.css`: owned by `primitives/reading/index.ts`, whose
// only importer is `primitives/announce/reading-announcement.ts` — a module that reads
// the incomplete-reading VOCABULARY and has nothing to do with the notice box the sheet
// dresses — so the box was styled by an edge that would survive exactly as long as that
// one value import did. That sheet has since moved to the door that publishes its
// components, which is what makes this gate's present job the one it will keep: it
// guards the DELETION, and reports the day an edge like that is the last one.
//
// THE NEGATIVE CONTROL IS PLANTED, not read out of the tree. A clean result over the
// real console proves nothing unless an orphan is shown to fail, and the console is not
// going to hold one on purpose — so the controls drive the same predicate over
// `syntheticStylesheetTree`, where a sheet nobody imports, a sheet behind a loader, and
// a door that fell off the graph are each written out and each has a known verdict.

import { describe, expect, it, vi } from "vitest";

import {
  RENDERER_ENTRY_MODULE,
  documentUnreachedStylesheets,
} from "./stylesheet-document-reach.js";
import {
  DESKTOP_STYLESHEET_TREE,
  collectStylesheetEdges,
  syntheticStylesheetTree,
  type StylesheetTree,
} from "./stylesheet-edge-graph.js";
import { StylesheetReachIndex } from "./stylesheet-static-reach.js";

/**
 * The budget this file states rather than inherits, on its neighbours' reasoning.
 *
 * Its claim parses every module in `src/` twice — once for the static specifiers and
 * once for the dynamic ones — plus every barrel, chunk root, and stylesheet the edge
 * graph walks. That cost is a property of the TREE and grows with it, and under this
 * tier's project concurrency the same pass crossed vitest's 5 s default with no change
 * to the code it reads. Set well above the loaded measurement on purpose: what a budget
 * guards is a pass that never settles, not a slow one.
 */
const DESKTOP_PARSE_ALLOWANCE_MS = 60_000;

vi.setConfig({ testTimeout: DESKTOP_PARSE_ALLOWANCE_MS });

/** The whole package's shipped source, walked once for this file. */
const TREE = DESKTOP_STYLESHEET_TREE;

/** The offences over one tree, from the entry that tree is rooted above. */
function unreachedIn(tree: StylesheetTree, entry: string): readonly string[] {
  return documentUnreachedStylesheets(
    tree,
    collectStylesheetEdges(tree),
    new StylesheetReachIndex(tree).loadableFrom(entry),
    entry,
  );
}

describe("stylesheet document reach — every sheet can reach the mounted document", () => {
  it("finds the renderer entry, its sheets, and a graph to walk", () => {
    // Without this a wrong root would scan nothing, the loadable set would be empty,
    // and the claim below would report every sheet in the package rather than passing
    // over none of them — loud in the right direction, but for the wrong reason.
    expect(TREE.modulePaths).toContain(RENDERER_ENTRY_MODULE);
    expect(TREE.stylesheetPaths.length).toBeGreaterThan(40);
    expect(new StylesheetReachIndex(TREE).loadableFrom(RENDERER_ENTRY_MODULE).size).toBeGreaterThan(
      100,
    );
  });

  it("crosses a loader, so the dynamic half of the walk is not vacuous", () => {
    // The console registers bodies off the first paint through `import()`, and if the
    // reach set stopped there this file's clean result would be an accident of the
    // console happening to import everything statically. Asserted as the DIFFERENCE
    // between the two sets rather than as a path: whichever module is behind a loader
    // this month, the loadable set is strictly the larger one.
    const index = new StylesheetReachIndex(TREE);
    const eager = index.reachableFrom(RENDERER_ENTRY_MODULE);
    const loadable = index.loadableFrom(RENDERER_ENTRY_MODULE);
    expect(loadable.size).toBeGreaterThan(eager.size);
    for (const modulePath of eager) {
      expect(loadable.has(modulePath)).toBe(true);
    }
  });

  it("puts every stylesheet in the package on a document the entry can reach", () => {
    expect(unreachedIn(TREE, RENDERER_ENTRY_MODULE)).toStrictEqual([]);
  });

  it("negative control: an orphan sheet in the walk's input fails the claim", () => {
    // The planted defect, in the shape the console can actually grow: `orphan.css` is
    // owned by a door nothing imports, so it is perfectly owned and reaches no window.
    // `dressed.css` beside it is the foil — same tree, same predicate, one edge — so a
    // reader can see the claim is about the edge and not about the file.
    const tree = syntheticStylesheetTree(
      new Map([
        ["main.tsx", 'import "./family/index.js";\n'],
        ["family/index.ts", 'import "./dressed.css";\nexport const family = 1;\n'],
        ["family/dressed.css", ".dressed {\n  color: red;\n}\n"],
        ["orphaned/index.ts", 'import "./orphan.css";\nexport const orphaned = 1;\n'],
        ["orphaned/orphan.css", ".orphan {\n  color: red;\n}\n"],
      ]),
    );
    expect(unreachedIn(tree, "main.tsx")).toStrictEqual([
      "orphaned/orphan.css: imported only by orphaned/index.ts, which main.tsx never loads",
    ]);
  });

  it("negative control: a sheet no edge names at all is reported as that", () => {
    // The second cause, and it reads differently on purpose: a sheet with no inbound
    // edge is a missing door line or a deleted surface, while the one above is a door
    // that fell off the graph. One message for both would send a reader to the wrong
    // half of the tree.
    const tree = syntheticStylesheetTree(
      new Map([
        ["main.tsx", 'import "./family/index.js";\n'],
        ["family/index.ts", "export const family = 1;\n"],
        ["family/nobody.css", ".nobody {\n  color: red;\n}\n"],
      ]),
    );
    expect(unreachedIn(tree, "main.tsx")).toStrictEqual([
      "family/nobody.css: no module or sheet imports it",
    ]);
  });

  it("a loader-backed body's sheet is reached through its chunk root", () => {
    // The rule's first consequence, driven rather than asserted: the deferred sheet is
    // named by no static edge, and the same tree reports it clean because `import()` is
    // an edge to this claim. The paired reading — that the eager closure does NOT hold
    // the chunk root — is what proves the pass is coming from the dynamic half.
    const tree = syntheticStylesheetTree(
      new Map([
        ["main.tsx", 'import "./family/index.js";\n'],
        [
          "family/index.ts",
          'export const open = async () => import("./pane/pane-body.js");\nexport const family = 1;\n',
        ],
        ["family/pane/pane-body.ts", 'import "./pane.css";\nexport const Body = 1;\n'],
        ["family/pane/pane.css", ".pane {\n  color: red;\n}\n"],
      ]),
    );
    const index = new StylesheetReachIndex(tree);
    expect(index.reachableFrom("main.tsx").has("family/pane/pane-body.ts")).toBe(false);
    expect(index.loadableFrom("main.tsx").has("family/pane/pane-body.ts")).toBe(true);
    expect(unreachedIn(tree, "main.tsx")).toStrictEqual([]);
  });

  it("an `@import` chain out of a reached sheet reaches what it names", () => {
    // The other kind of edge, and the reason the reached set is a fixpoint rather than
    // one pass: `part.css` is named by no module anywhere, and it arrives on the same
    // chunk as the sheet whose head names it.
    const tree = syntheticStylesheetTree(
      new Map([
        ["main.tsx", 'import "./family/index.js";\n'],
        ["family/index.ts", 'import "./family.css";\nexport const family = 1;\n'],
        ["family/family.css", '@import "./part.css";\n.family {\n  color: red;\n}\n'],
        ["family/part.css", ".part {\n  color: red;\n}\n"],
      ]),
    );
    expect(unreachedIn(tree, "main.tsx")).toStrictEqual([]);
  });

  it("negative control: an entry the tree does not hold reports every sheet", () => {
    // The vacuity this claim could fail silently by. A mistyped entry resolves to an
    // empty loadable set, and a gate that reported nothing there would be green about a
    // walk it never took. It reports everything instead, which is the loud direction.
    const tree = syntheticStylesheetTree(
      new Map([
        ["main.tsx", 'import "./family/index.js";\n'],
        ["family/index.ts", 'import "./family.css";\nexport const family = 1;\n'],
        ["family/family.css", ".family {\n  color: red;\n}\n"],
      ]),
    );
    expect(unreachedIn(tree, "main.ts")).toStrictEqual([
      "family/family.css: imported only by family/index.ts, which main.ts never loads",
    ]);
  });
});
