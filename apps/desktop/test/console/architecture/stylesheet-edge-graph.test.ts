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
  lazyChunkRoots,
  resolveStylesheet,
  stylesheetEdgeOffences,
  syntheticStylesheetTree,
} from "./stylesheet-edge-graph.js";
import { moduleStylesheetImports, stylesheetAtImports } from "./stylesheet-specifiers.js";

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
      misowned: [],
    });
  });

  it("counts a sheet reached from a neighbour's barrel rather than from its owner's", () => {
    // The console's own pre-fix shape, in miniature, and the defect the first three
    // verdicts cannot see: `doored.css` is reached, once, from one barrel — every
    // earlier claim passes — and the barrel that reaches it belongs to the directory
    // ABOVE the one that owns the sheet. Ownership is what separates them, so the walk
    // has to compute it rather than treat any `index.ts` as an owner.
    const misownedTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), '@import "./doored/doored.css";\n'],
        [join("family", "doored", "index.ts"), "export const doored = 1;\n"],
        [join("family", "doored", "doored.css"), ".doored {\n  color: red;\n}\n"],
      ]),
    );

    const offences = stylesheetEdgeOffences(misownedTree, collectStylesheetEdges(misownedTree));

    expect(offences.unreached).toStrictEqual([]);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
    expect(offences.misowned).toHaveLength(1);
    expect(offences.misowned[0]).toContain(join("family", "doored", "doored.css"));
  });

  it("counts nothing once the door owns its own sheet, one edge moved and nothing else", () => {
    // The repair, driven — without it the verdict above would be satisfied by a walk
    // that reported every sheet under a doored directory, which would forbid the shape
    // the rule actually prescribes.
    const repairedTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), ".family {\n  color: blue;\n}\n"],
        [join("family", "doored", "index.ts"), 'import "./doored.css";\n'],
        [join("family", "doored", "doored.css"), ".doored {\n  color: red;\n}\n"],
      ]),
    );

    const offences = stylesheetEdgeOffences(repairedTree, collectStylesheetEdges(repairedTree));

    expect(offences.misowned).toStrictEqual([]);
    expect(offences.unreached).toStrictEqual([]);
  });

  it("counts nothing for a doorless sub-directory, which its family owns", () => {
    // The other side of ownership, and the reason the rule keys on the OWNER rather
    // than on depth: a sub-directory with no door of its own is the family's, so the
    // family door pulling in its sheet is the family importing its own rules.
    const doorlessTree = syntheticStylesheetTree(
      new Map([
        [join("family", "index.ts"), 'import "./family.css";\n'],
        [join("family", "family.css"), '@import "./parts/part.css";\n'],
        [join("family", "parts", "part.css"), ".part {\n  color: red;\n}\n"],
      ]),
    );

    const offences = stylesheetEdgeOffences(doorlessTree, collectStylesheetEdges(doorlessTree));

    expect(offences.misowned).toStrictEqual([]);
    expect(offences.unreached).toStrictEqual([]);
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

  it("admits two lazy chunk roots of ONE directory reaching one sheet", () => {
    // The one fan-in the rule lets through. Two deferred entries to the same directory
    // are two ways into one body, not two owners: the bundler emits the sheet once
    // into whichever chunk pulls, and a document mounts at most one of them. A sheet
    // named by only one of the pair would leave the other entry rendering undressed,
    // so the import has to be on both and the rule has to say so.
    const siblingRootTree = syntheticStylesheetTree(
      new Map([
        [
          join("one", "index.ts"),
          'export const open = async () => [import("./pane-body.js"), import("./surface-body.js")];\n',
        ],
        [join("one", "pane-body.ts"), 'import "./shared.css";\n'],
        [join("one", "surface-body.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), "\n"],
      ]),
    );
    const edges = collectStylesheetEdges(siblingRootTree);
    // Read out of the walk rather than asserted about it: the sheet really does carry
    // two inbound edges here, so the clean verdict below is the rule and not an
    // arrangement the walk failed to see.
    expect(edges.get(join("one", "shared.css"))).toHaveLength(2);

    const offences = stylesheetEdgeOffences(siblingRootTree, edges);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
    expect(offences.unreached).toStrictEqual([]);
  });

  it("admits the sheets an admitted fan-in `@import`s at its own head", () => {
    // The clause the workflows family paid for. Its chrome is pulled by three sibling
    // chunk roots, and that chrome carries the sheets the family owns at its head — so
    // each of THOSE is reached once per root, with one importer and three edges. The
    // multiplicity is a property of the roots and not of the sheet: it lands on exactly
    // the asset its importer lands on. Without this clause the model would forbid a
    // fanned-in family sheet from carrying any `@import` at all, which is an accident of
    // how the walk counts rather than a rule anyone decided.
    const nestedFanInTree = syntheticStylesheetTree(
      new Map([
        [
          join("one", "index.ts"),
          'export const open = async () => [import("./pane-body.js"), import("./surface-body.js")];\n',
        ],
        [join("one", "pane-body.ts"), 'import "./shared.css";\n'],
        [join("one", "surface-body.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), '@import "./badge.css";\n'],
        [join("one", "badge.css"), "\n"],
      ]),
    );
    const edges = collectStylesheetEdges(nestedFanInTree);
    // Read out of the walk, so the clean verdict below is the rule rather than a fan-in
    // the walk did not find: the nested sheet really does carry one edge per root.
    expect(edges.get(join("one", "badge.css"))).toHaveLength(2);

    const offences = stylesheetEdgeOffences(nestedFanInTree, edges);
    expect(offences.duplicatePaths).toStrictEqual([]);
    expect(offences.duplicateBarrels).toStrictEqual([]);
    expect(offences.unreached).toStrictEqual([]);
  });

  it("negative control: a sheet the DOOR pulls carries no admission to its `@import`s", () => {
    // The clause above admits an importer only when the importer is itself admitted, so
    // the recursion inherits "every importer must qualify" rather than replacing it. Here
    // the family sheet is pulled by the door as well as by a chunk root — the double
    // injection the single-edge rule exists for — and the sheet at its head is counted
    // exactly as the sheet that pulls it is.
    const doorPulledTree = syntheticStylesheetTree(
      new Map([
        [
          join("one", "index.ts"),
          'import "./shared.css";\nexport const open = async () => import("./pane-body.js");\n',
        ],
        [join("one", "pane-body.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), '@import "./badge.css";\n'],
        [join("one", "badge.css"), "\n"],
      ]),
    );
    const offences = stylesheetEdgeOffences(doorPulledTree, collectStylesheetEdges(doorPulledTree));
    expect(offences.duplicatePaths).toHaveLength(2);
    expect(offences.duplicatePaths.join("\n")).toContain(join("one", "badge.css"));
  });

  it("negative control: two chunk roots under DIFFERENT owners are still counted", () => {
    // What the admission above must not swallow. Both importers are lazy chunk roots,
    // which a rule keyed on "is a chunk root" alone would have passed; they answer to
    // two different barrels, so one directory is still the reason another is styled.
    const twoOwnerRootTree = syntheticStylesheetTree(
      new Map([
        [join("one", "index.ts"), 'export const open = async () => import("./pane-body.js");\n'],
        [join("one", "pane-body.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), "\n"],
        [join("two", "index.ts"), 'export const open = async () => import("./pane-body.js");\n'],
        [join("two", "pane-body.ts"), 'import "../one/shared.css";\n'],
      ]),
    );
    const offences = stylesheetEdgeOffences(
      twoOwnerRootTree,
      collectStylesheetEdges(twoOwnerRootTree),
    );
    expect(offences.duplicatePaths).toHaveLength(1);
    expect(offences.duplicatePaths[0]).toContain("2 inbound edges");
    expect(offences.duplicateBarrels).toHaveLength(1);
  });

  it("negative control: a door joining its own chunk root is still counted", () => {
    // The other half of "every importer must qualify". The two importers share an
    // owner this time, and one of them is the family door — an eager import beside a
    // deferred one, which is the double injection the single-edge rule was written
    // for: the sheet lands in the initial chunk AND in the lazy one.
    const doorAndRootTree = syntheticStylesheetTree(
      new Map([
        [
          join("one", "index.ts"),
          'import "./shared.css";\nexport const open = async () => import("./pane-body.js");\n',
        ],
        [join("one", "pane-body.ts"), 'import "./shared.css";\n'],
        [join("one", "shared.css"), "\n"],
      ]),
    );
    const offences = stylesheetEdgeOffences(
      doorAndRootTree,
      collectStylesheetEdges(doorAndRootTree),
    );
    expect(offences.duplicatePaths).toHaveLength(1);
    expect(offences.duplicatePaths[0]).toContain("2 inbound edges");
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

  it("walks out of a lazily imported chunk root, and owns its sheet to the barrel", () => {
    // THE SHAPE THE CONSOLE NOW HAS. `body.css` is named by nothing but `body.ts`, and
    // `body.ts` is named by nothing but the barrel's `import()`. A walk that started
    // only at barrels reported that sheet as rules that never paint, which is the
    // false verdict this control exists to pin: the sheet is reached, exactly once,
    // and the chunk root is not a neighbour reaching in — it answers to the same
    // barrel the sheet does.
    const lazyTree = syntheticStylesheetTree(
      new Map([
        [
          join("family", "index.ts"),
          'import "./family.css";\nexport const body = () => import("./pane/body.js");\n',
        ],
        [join("family", "family.css"), "\n"],
        [join("family", "pane", "body.ts"), 'import "./body.css";\nexport const Body = 1;\n'],
        [join("family", "pane", "body.css"), ".body {\n  color: red;\n}\n"],
      ]),
    );

    expect([...lazyChunkRoots(lazyTree)]).toStrictEqual([join("family", "pane", "body.ts")]);
    expect(stylesheetEdgeOffences(lazyTree, collectStylesheetEdges(lazyTree))).toStrictEqual({
      unreached: [],
      duplicatePaths: [],
      duplicateBarrels: [],
      misowned: [],
    });
  });

  it("negative control: a module nothing lazily imports is no door, whatever it is named", () => {
    // THE WHOLE REASON THE SET IS DERIVED FROM THE GRAPH. This tree is the one above
    // with the `import()` made static, so the module keeps the name and loses the
    // property — and the sheet it imports is then reached by nothing the rule admits.
    // A predicate keyed on a `-body` suffix would report this tree clean and put the
    // sheet on the initial document with nothing to say so.
    const staticTree = syntheticStylesheetTree(
      new Map([
        [
          join("family", "index.ts"),
          'import "./family.css";\nimport { Body } from "./pane/body.js";\nexport const body = Body;\n',
        ],
        [join("family", "family.css"), "\n"],
        [join("family", "pane", "body.ts"), 'import "./body.css";\nexport const Body = 1;\n'],
        [join("family", "pane", "body.css"), ".body {\n  color: red;\n}\n"],
      ]),
    );

    expect([...lazyChunkRoots(staticTree)]).toStrictEqual([]);
    expect(
      stylesheetEdgeOffences(staticTree, collectStylesheetEdges(staticTree)).unreached,
    ).toStrictEqual([join("family", "pane", "body.css")]);
  });

  it("negative control: a chunk root is read from the parse and not from the text", () => {
    // `import(` inside a comment or a string is not a call expression, and the same
    // reasoning that put the stylesheet readers on the parser puts this one there: a
    // header explaining why a family does NOT lazily load a body would otherwise mint
    // a door out of the sentence explaining its absence.
    const proseTree = syntheticStylesheetTree(
      new Map([
        [
          join("family", "index.ts"),
          '// This family does not import("./pane/body.js") — it paints on first frame.\nconst specifier = \'import("./pane/body.js")\';\nimport "./family.css";\nexport const named = specifier;\n',
        ],
        [join("family", "family.css"), "\n"],
        [join("family", "pane", "body.ts"), "export const Body = 1;\n"],
      ]),
    );

    expect([...lazyChunkRoots(proseTree)]).toStrictEqual([]);
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
