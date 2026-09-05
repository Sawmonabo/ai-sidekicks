// The edge walk's own tests, driven over trees written out in full.
//
// EVERY CONTROL HERE IS A PLANTED DEFECT. The claims about the console are next door
// in `stylesheet-edges.test.ts` and they are only worth their green if this walk bites
// when an edge really is duplicated — and proving that against the console itself
// would mean a test writing a second import into the source tree. So each tree below
// is four or five literal sources with a known verdict, and each names the defect the
// superseded collapsing walk could not see.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectStylesheetEdges,
  isOwningBarrel,
  resolveStylesheet,
  stylesheetEdgeOffences,
  moduleStylesheetImports,
  stylesheetAtImports,
  syntheticStylesheetTree,
} from "./stylesheet-edge-graph.js";

describe("the stylesheet edge walk", () => {
  it("a clean tree offends nobody", () => {
    // The floor under every control below. Without it a walk that reported every
    // sheet as duplicated would satisfy them all and prove nothing.
    const cleanTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), '@import "./surface.css";\n'],
        [join("family", "surface.css"), "\n"],
      ]),
    );
    expect(stylesheetEdgeOffences(cleanTree, collectStylesheetEdges(cleanTree))).toStrictEqual({
      unreached: [],
      duplicatePaths: [],
      duplicateBarrels: [],
    });
  });

  it("counts a sheet imported from two barrels, where a reached-set collapsed it", () => {
    // The defect the superseded assertion could not see. Both barrels reach
    // `shared.css`, so a set of reached sheets held it once and reported the tree
    // clean; the edge list holds two, from two barrels.
    const twoBarrelTree = syntheticStylesheetTree(
      new Map([
        [join("one", "index.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), "\n"],
        [join("two", "index.ts"), 'import "../one/shared.css";\n'],
      ]),
    );
    const edges = collectStylesheetEdges(twoBarrelTree);
    // What the superseded check saw, taken from this walk's own output rather than
    // rebuilt: collapse the edges to their keys and every sheet is present, so its one
    // assertion passed over exactly this tree.
    const collapsedToReachedSheets = new Set(edges.keys());
    expect(
      twoBarrelTree.stylesheetPaths.filter((sheet) => !collapsedToReachedSheets.has(sheet)),
    ).toStrictEqual([]);

    const offences = stylesheetEdgeOffences(twoBarrelTree, edges);
    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicatePaths).toHaveLength(1);
    expect(offences.duplicatePaths[0]).toContain("2 inbound edges");
    expect(offences.duplicateBarrels).toHaveLength(1);
    expect(offences.duplicateBarrels[0]).toContain(join("one", "index.ts"));
    expect(offences.duplicateBarrels[0]).toContain(join("two", "index.ts"));
  });

  it("counts two `@import` paths from one barrel too", () => {
    // The half a barrel count alone would miss: one owning barrel, two chains through
    // it, and a sheet whose cascade position depends on which chain a build walks
    // first. Reported as a duplicate PATH and deliberately not as a duplicate barrel,
    // because there is only one barrel and a report that said otherwise would send a
    // reader looking for a second family.
    const diamondTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), '@import "./left.css";\n@import "./right.css";\n'],
        [join("family", "left.css"), '@import "./shared.css";\n'],
        [join("family", "right.css"), '@import "./shared.css";\n'],
        [join("family", "shared.css"), "\n"],
      ]),
    );
    const offences = stylesheetEdgeOffences(diamondTree, collectStylesheetEdges(diamondTree));
    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
    expect(offences.duplicatePaths).toHaveLength(1);
    expect(offences.duplicatePaths[0]).toContain(join("family", "shared.css"));
    expect(offences.duplicatePaths[0]).toContain(join("family", "left.css"));
    expect(offences.duplicatePaths[0]).toContain(join("family", "right.css"));
  });

  it("counts what a doubly-reached sheet pulls in, at every level it injects", () => {
    // What a visited set shared across barrels would lose, and the reason the set is
    // per walk. `deep.css` is named by ONE `@import` line, and that line is reached
    // under two barrels, so it enters the cascade twice; a walk that stopped at the
    // already-visited parent would report the parent alone and attribute `deep.css` to
    // whichever barrel the walk order happened to reach first — module-graph-order
    // dependence, rebuilt inside the checker that exists to remove it.
    const sharedSubtreeTree = syntheticStylesheetTree(
      new Map([
        [join("one", "index.ts"), 'import "./shared-parent.css";\n'],
        [join("one", "shared-parent.css"), '@import "./deep.css";\n'],
        [join("one", "deep.css"), "\n"],
        [join("two", "index.ts"), 'import "../one/shared-parent.css";\n'],
      ]),
    );
    const offences = stylesheetEdgeOffences(
      sharedSubtreeTree,
      collectStylesheetEdges(sharedSubtreeTree),
    );
    expect(offences.unreached).toStrictEqual([]);
    // Both the sheet the barrels share and the sheet under it, each from both barrels.
    expect(offences.duplicatePaths).toHaveLength(2);
    expect(offences.duplicateBarrels).toHaveLength(2);
    expect(offences.duplicateBarrels.join("\n")).toContain(join("one", "deep.css"));
  });

  it("reports a sheet no barrel reaches", () => {
    // The other claim's own control: without it a walk that recorded nothing at all
    // would report every tree clean on the two duplicate counts above.
    const strandedTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), "\n"],
        [join("family", "stranded.css"), "\n"],
      ]),
    );
    const offences = stylesheetEdgeOffences(strandedTree, collectStylesheetEdges(strandedTree));
    expect(offences.unreached).toStrictEqual([join("family", "stranded.css")]);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
  });

  it("terminates on a cyclic `@import`, having already recorded the edge that closed it", () => {
    // A cycle is not this walk's subject, but a walk that hung on one would take the
    // whole tier with it. The second edge into `family.css` is the cycle, and it is
    // recorded — the visited set skips the DESCENT and never the edge.
    const cyclicTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), '@import "./surface.css";\n'],
        [join("family", "surface.css"), '@import "./family.css";\n'],
      ]),
    );
    const offences = stylesheetEdgeOffences(cyclicTree, collectStylesheetEdges(cyclicTree));
    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicatePaths).toHaveLength(1);
    expect(offences.duplicatePaths[0]).toContain(join("family", "family.css"));
  });

  it("negative control: the readers and the predicate match what they claim to", () => {
    // Without this a broken reader would make every clean verdict above meaningless —
    // an empty specifier set offends nobody — and a predicate that answered `true`
    // everywhere would admit a component's edge as a barrel's.
    expect(moduleStylesheetImports("index.ts", 'import "./surface.css";\n')).toStrictEqual([
      "./surface.css",
    ]);
    expect(stylesheetAtImports("family.css", '@import "./surface.css";\n')).toStrictEqual([
      "./surface.css",
    ]);
    // Each reader answers nothing for the other's file, so a stylesheet and a module
    // are non-edges to each other rather than silent ones. The module reader is blind
    // by the file's NAME and not by parsing, and this is the measurement that says so:
    // under a module name TypeScript's error recovery reads `@import "./x.css";` as a
    // decorator followed by a side-effect import, which is exactly why that reader
    // carries a guard and why the guard is load-bearing rather than decorative.
    expect(moduleStylesheetImports("family.css", '@import "./surface.css";\n')).toStrictEqual([]);
    expect(stylesheetAtImports("family.css", 'import "./surface.css";\n')).toStrictEqual([]);
    expect(moduleStylesheetImports("index.ts", '@import "./surface.css";\n')).toStrictEqual([
      "./surface.css",
    ]);
    expect(isOwningBarrel(join("family", "index.ts"))).toBe(true);
    expect(isOwningBarrel(join("family", "Surface.tsx"))).toBe(false);
  });

  it("reads the edges a whole-line match could not see", () => {
    // Every one of these is an edge the console can legitimately carry and the
    // patterns this replaced reported as nothing — which made a reached sheet read as
    // unreached and a doubly-reached one read as reached once.
    expect(
      moduleStylesheetImports("index.ts", 'import "./surface.css"; // ships with the surface\n'),
    ).toStrictEqual(["./surface.css"]);
    expect(moduleStylesheetImports("index.ts", 'import\n  "./surface.css";\n')).toStrictEqual([
      "./surface.css",
    ]);
    expect(stylesheetAtImports("family.css", '@import "./surface.css" screen;\n')).toStrictEqual([
      "./surface.css",
    ]);
    expect(stylesheetAtImports("family.css", '@import url("./surface.css");\n')).toStrictEqual([
      "./surface.css",
    ]);
    expect(
      stylesheetAtImports("family.css", '@import "./surface.css"; /* the surface */\n'),
    ).toStrictEqual(["./surface.css"]);
  });

  it("reads no edge where a reader must not see one", () => {
    // The other half: a commented-out `@import` is not an edge, and a module's
    // side-effect import of something that is not a sheet is not one either. Without
    // this the readers above could be satisfied by anything permissive enough.
    expect(stylesheetAtImports("family.css", '/* @import "./surface.css"; */\n')).toStrictEqual([]);
    expect(
      moduleStylesheetImports("index.ts", 'import "./register-tripwires.js";\n'),
    ).toStrictEqual([]);
    // A NAMED import of a sheet-shaped specifier is not a side-effect edge: it binds
    // something, so a walk that counted it would attribute a sheet to a module that
    // imports a value out of it.
    expect(
      moduleStylesheetImports("index.ts", 'import styles from "./surface.css";\n'),
    ).toStrictEqual([]);
  });

  it("negative control: a bare specifier resolves to nothing this tree can place", () => {
    // The graph library's `base.css` is the live instance. A resolver that returned a
    // path for it would report the console short of one sheet it does not own, and
    // then throw reading a file that is not in the tree.
    expect(resolveStylesheet(join("family", "index.ts"), "@xyflow/react/dist/base.css")).toBe(
      undefined,
    );
    expect(resolveStylesheet(join("family", "index.ts"), "./family.css")).toBe(
      join("family", "family.css"),
    );
  });
});
