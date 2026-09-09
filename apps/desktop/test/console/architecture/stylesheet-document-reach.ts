// Which stylesheets the renderer's own entry module can ever put on the document.
//
// THE CLAIM ITS NEIGHBOURS CANNOT MAKE. `stylesheet-edges.test.ts` asks whether each
// sheet is imported by the barrel that OWNS it, and answers about ownership alone: a
// sheet correctly owned by a barrel nothing imports passes every one of its four claims
// and paints nothing. `stylesheet-chunk-root-ownership.test.ts` asks whether a sheet is
// on the right SIDE of a chunk boundary, which presumes it is on the graph at all. What
// neither asks is the one a person sees first — does this file's rules reach a window —
// and the answer is a property of the module graph from `src/renderer/src/main.tsx`
// down, which is the only module in this package that mounts anything.
//
// WHY THIS IS NOT PARANOIA. The shape it catches is one edge away at all times: a
// stylesheet owned by a sub-module door whose only importer is a SIBLING that happens to
// read a value out of the directory. The sheet is on the document because of an edge
// that has nothing to do with what the sheet dresses, so the day that sibling stops
// reading the value — a refactor with no stylesheet in its diff — the rules go with it,
// and every ownership claim stays green.
//
// BOTH KINDS OF MODULE EDGE COUNT, and that is the whole difference from
// `eagerlyReachedModules`. A body registered through a loader is reached only by an
// `import()`, so a static closure reports every sheet that body's chunk root imports as
// reached by nothing — which would fail the console's `browser`, `terminal`, and
// `agents` families for being placed exactly as `apps/desktop/AGENTS.md` §Module shape
// tells them to place their sheets. `StylesheetReachIndex.loadableFrom` is the set that
// crosses those edges, and this file is its one consumer.
//
// AND THE `@import` CHAIN COUNTS TOO, on the reason `stylesheet-edge-graph.ts` gives for
// counting it: a family that pulls its parts in at the head of its own sheet has put
// them on the same chunk as a module edge would have. So the reached set is the LEAST
// FIXPOINT over the edge graph — seeded by every sheet a loadable module names, then
// grown by every sheet a reached sheet names — which is also why there is no cycle guard
// here and needs none: a monotone closure over a finite set terminates whatever the
// sheets say about each other.
//
// THE WALK IS NOT A SECOND ONE. The tree, the specifier readers, the resolver, the reach
// index, and the edge graph are all the tier's own; what is written here is the
// predicate over them, which is the part that is this claim and nobody else's.

import type { StylesheetEdgeGraph, StylesheetTree } from "./stylesheet-edge-graph.js";

/**
 * The module the renderer bundle enters at, spelled as `DESKTOP_STYLESHEET_TREE` keys it.
 *
 * A literal because it is one: `electron.vite.config.ts` gives the renderer build the
 * single input `src/renderer/index.html`, whose one `<script type="module">` names
 * `./src/main.tsx`. The suite asserts the tree holds the path rather than trusting the
 * string, so a rename fails loudly here instead of quietly reporting every sheet in the
 * package as unreachable.
 */
export const RENDERER_ENTRY_MODULE = "src/renderer/src/main.tsx";

/**
 * Every stylesheet in `tree` that `entry` can never load, each with why.
 *
 * A sheet is reached when some module the entry can load imports it, or when some sheet
 * that is itself reached `@import`s it. Anything else is rules that were written and
 * that no state this application can be driven into will paint.
 *
 * The two causes are reported apart because the remedies are different: a sheet no edge
 * names at all is either dead or missing its door line, while a sheet whose importers
 * are all unreachable is a door that fell off the graph and takes every sheet it owns
 * with it.
 */
export function documentUnreachedStylesheets(
  tree: StylesheetTree,
  edges: StylesheetEdgeGraph,
  loadableModules: ReadonlySet<string>,
  entry: string,
): readonly string[] {
  const reached = documentReachedStylesheets(tree, edges, loadableModules);
  return tree.stylesheetPaths
    .filter((stylesheetPath) => !reached.has(stylesheetPath))
    .map((stylesheetPath) => {
      const importers = (edges.get(stylesheetPath) ?? []).map((edge) => edge.importer);
      return importers.length === 0
        ? `${stylesheetPath}: no module or sheet imports it`
        : `${stylesheetPath}: imported only by ${importers.join(", ")}, which ${entry} never loads`;
    });
}

/**
 * The least fixpoint: every sheet the entry's loadable modules put on a document.
 *
 * Seeded by the module edges and grown by the `@import` ones, re-scanning until a pass
 * adds nothing. The set is small — one entry per stylesheet in the package — so the
 * repeated scan is cheaper than the bookkeeping a worklist would need to stay correct
 * across a sheet reached later than one it feeds.
 */
function documentReachedStylesheets(
  tree: StylesheetTree,
  edges: StylesheetEdgeGraph,
  loadableModules: ReadonlySet<string>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const stylesheetPath of tree.stylesheetPaths) {
      if (reached.has(stylesheetPath)) {
        continue;
      }
      const arrivesHere = (edges.get(stylesheetPath) ?? []).some(
        (edge) => loadableModules.has(edge.importer) || reached.has(edge.importer),
      );
      if (arrivesHere) {
        reached.add(stylesheetPath);
        grew = true;
      }
    }
  }
  return reached;
}
