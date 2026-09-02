// Layering gate for `apps/desktop` (`Spec-023 §Console Libraries`, structure-enforcement row).
//
// It answers one question the type system cannot: which module is allowed to import which.
// ESLint's `no-restricted-imports` already owns the renderer-untrusted specifier bans, and it
// keeps them — a `files`-scoped specifier ban is exactly what that rule is for. What it cannot
// express is an ORDERING over N families, because flat config replaces a rule's options at the
// last matching block, so every family would have to restate the whole list of families above
// it. That table lives here instead.
//
// Resolution runs through `enhanced-resolve` with an explicit extension list, NOT through
// `--ts-config`. dependency-cruiser resolves a tsconfig's `extends` chain against the process
// directory rather than against the tsconfig's own directory, so a tsconfig whose `extends`
// climbs above its package only loads when the cruise runs from that exact directory — and this
// tree declares no path aliases, so the flag would buy a working-directory constraint and
// nothing else. The extension list is what makes this tree's `./foo.js` specifiers resolve to
// `foo.ts` sources.
//
// Paths are relative to `apps/desktop`; run it through `pnpm structure:layering`.

/** Console family homes, low to high. A family may import any home below it and none above. */
const CONSOLE = "^src/renderer/src/console";

// `core/` is the DAG floor: `constants.ts`, `tripwires.ts`, `keyed-registry.ts`, `refusal.ts`,
// `emitter.ts`, `clock.ts`. Nothing below it, so its rule below is the only one that forbids
// every other family at once.
const CORE = `${CONSOLE}/core/`;
const TOKENS = `${CONSOLE}/tokens/`;
const ROUTING = `${CONSOLE}/routing/`;
const PRIMITIVES = `${CONSOLE}/primitives/`;
const STATE = `${CONSOLE}/(store|persistence)/`;
const BRIDGE = `${CONSOLE}/bridge/`;
// `seats/` holds the contracts through which view families hand each other bodies — the
// pane registry and its kinds and addresses, the composer seat, sidebar sections, the
// timeline row slot, the inline-card seats. It sits HERE, directly above `bridge/`,
// because that is the highest family a seat imports; and below `palette/` and `frame/`
// because the frame composes the pane-registry singleton and a seat reaches for neither.
// It lived at `workspace/seats/` until this position was named, which made the frame
// import a VIEW family — the edge the `console-layering-view-families` rule below now
// forbids outright.
const SEATS = `${CONSOLE}/seats/`;
const PALETTE = `${CONSOLE}/palette/`;
const FRAME = `${CONSOLE}/frame/`;

// The composition sites. `families.ts` and `panes/index.ts` are the two files whose whole
// job is to name every view family, so they are the one place a downward-only ladder
// cannot apply: they sit above every family by construction. They are named here so the
// view-family rule below can subtract them rather than report the console's own entry
// wiring as a violation.
const COMPOSITION_ROOT_FILES = `${CONSOLE}/[^/]+$`;
const COMPOSITION_PANE_BOARD = `${CONSOLE}/panes/`;

/**
 * Every barrel under `console/` — a family door and a sub-module door alike.
 *
 * Two alternatives rather than one `(?:[^/]+/)*` because dependency-cruiser refuses a rule
 * whose regular expression has a star height above one: a quantified group containing its own
 * quantifier is the catastrophic-backtracking shape, and the cruise bails on it outright
 * rather than running slowly. Measured — the nested form fails with "has an unsafe regular
 * expression. Bailing out."
 */
const CONSOLE_BARRELS = [`${CONSOLE}/index\\.ts$`, `${CONSOLE}/.+/index\\.ts$`];

/** Every layer family, low to high — the closed set the DAG orders. */
const LAYER_FAMILIES = [CORE, TOKENS, ROUTING, PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];

/**
 * A VIEW family is any console home that is not a layer family and not a composition site.
 *
 * Stated as the COMPLEMENT rather than as a list of directory names, because a list is the
 * exact thing that failed here: the ladders below stopped at `frame/`, so no rule named the
 * view families and `frame/` → `workspace/` passed a gate whose own standard forbids it. A
 * list would have to be extended by each of the seven family branches, and the one that
 * forgot would reopen the same hole silently. The complement needs no line at all when a
 * family lands, and it cannot be forgotten.
 */
const VIEW_FAMILIES = {
  path: `${CONSOLE}/`,
  pathNot: [...LAYER_FAMILIES, COMPOSITION_PANE_BOARD, COMPOSITION_ROOT_FILES],
};

/** Everything strictly above each family, as one alternation. */
const ABOVE_CORE = [TOKENS, ROUTING, PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
const ABOVE_TOKENS = [ROUTING, PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
const ABOVE_ROUTING = [PRIMITIVES, STATE, BRIDGE, SEATS, PALETTE, FRAME];
const ABOVE_PRIMITIVES = [STATE, BRIDGE, SEATS, PALETTE, FRAME];
const ABOVE_STATE = [BRIDGE, SEATS, PALETTE, FRAME];
const ABOVE_BRIDGE = [SEATS, PALETTE, FRAME];
const ABOVE_SEATS = [PALETTE, FRAME];
const ABOVE_PALETTE = [FRAME];

/** One forbidden rule per family: an edge from that family to anything above it. */
function upwardEdge(family, fromPath, toPaths) {
  return {
    name: `console-layering-${family}`,
    comment:
      `\`console/${family}\` sits below the families it imported. Hoist the symbol down to the ` +
      `lowest family that needs it; never deep-import around the edge.`,
    severity: "error",
    from: { path: fromPath },
    to: { path: toPaths },
  };
}

export default {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "A cycle makes module initialisation order load-bearing and un-reviewable. Break it by " +
        "hoisting the shared symbol into the lower family, not by deep-importing past a barrel.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment:
        "A module with no dependents AND no dependencies is connected to nothing. This is a " +
        "narrower claim than the dead-code gate's: `knip` owns reachability from the entry " +
        "points, this owns total disconnection, and neither subsumes the other. Ambient " +
        "declarations, stylesheets, and tool configuration are roots, not orphans.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.(ts|mts)$",
          "\\.css$",
          "\\.json$",
          "(^|/)[^/]+\\.config\\.(ts|mjs|cjs|js)$",
        ],
      },
      to: {},
    },
    {
      name: "renderer-not-main",
      comment:
        "The renderer is untrusted. It reaches the main process only across the context bridge; " +
        "a value both sides need lives in `src/shared/`.",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { path: "^src/(main|preload)/" },
    },
    {
      name: "main-not-renderer",
      comment:
        "Main and preload never import renderer source. A value both sides need lives in " +
        "`src/shared/` and is imported by both, never mirrored by hand.",
      severity: "error",
      from: { path: "^src/(main|preload)/" },
      to: { path: "^src/renderer/" },
    },
    {
      name: "shared-imports-nothing",
      comment:
        "`src/shared/` is the one cross-process leaf: types and pure functions main, preload, " +
        "and the renderer all need. It may import the contracts package and nothing else — an " +
        "`electron`, `node:*`, or React import there would make it unimportable by one of its " +
        "three consumers.",
      severity: "error",
      from: { path: "^src/shared/" },
      // Both spellings of the one allowed target, and both are reachable: the contracts
      // package resolves into `node_modules/@ai-sidekicks/contracts/` once it has been built
      // and carries its bare specifier as its path when it has not, so the shape of this edge
      // depends on the build state of a sibling package. Measured both ways — the graph grows
      // by the resolved package's modules and the violation set does not move.
      to: {
        pathNot: "^(src/shared/|node_modules/@ai-sidekicks/contracts|@ai-sidekicks/contracts)",
      },
    },
    {
      name: "console-not-plan-subtree",
      comment:
        "A plan-owned subtree whose owner MOUNTS INTO the console reaches the frame by calling " +
        "`registerConsoleSurface`, which is a call and not an import — so the console imports " +
        "it through no path, and this rule takes no exception. It is deliberately not a ban on " +
        "every sibling subtree: Plan-023's Phase-1C rule has the console absorb the shipped " +
        "Tier-1 components (`session-bootstrap/`, `session-members/`, `runtime-node-attach/`) " +
        "by import, and a gate stricter than its own plan is a defect. A later plan whose page " +
        "mounts into the console adds its subtree to this list.",
      severity: "error",
      from: { path: `${CONSOLE}/` },
      to: {
        path:
          "^src/renderer/src/(timeline|usage-meters|run-controls|provider-accounts|" +
          "sidekick-definitions|mcp-governance)/",
      },
    },
    upwardEdge("core", CORE, ABOVE_CORE),
    upwardEdge("tokens", TOKENS, ABOVE_TOKENS),
    upwardEdge("routing", ROUTING, ABOVE_ROUTING),
    upwardEdge("primitives", PRIMITIVES, ABOVE_PRIMITIVES),
    upwardEdge("store-persistence", STATE, ABOVE_STATE),
    upwardEdge("bridge", BRIDGE, ABOVE_BRIDGE),
    upwardEdge("seats", SEATS, ABOVE_SEATS),
    upwardEdge("palette", PALETTE, ABOVE_PALETTE),
    {
      name: "console-layering-view-families",
      comment:
        "A layer family imported a VIEW family. The view families sit at the top of the DAG " +
        "and import the layers below them; an edge back down means the layer is reaching for " +
        "a body. Hoist the contract into the lowest layer that needs it — `seats/` is where " +
        "the pane, composer, sidebar, timeline-row, and inline-card contracts live for exactly " +
        "this reason — and never deep-import around it. This rule is stated once for all nine " +
        "layer families rather than per family, because its target set is everything in the " +
        "console that is NOT a layer family or a composition site: a new view family is covered " +
        "the moment its directory exists, with no line to remember.",
      severity: "error",
      from: { path: LAYER_FAMILIES },
      to: VIEW_FAMILIES,
    },
    {
      name: "console-view-family-isolation",
      comment:
        "One VIEW family imported another. View families are siblings, not a ladder: the rule " +
        "above only forbids a LAYER family reaching up into a view family, so without this one " +
        "`collaboration/` → `repos/` stayed green and the six concurrent family branches could " +
        "grow edges into each other that no ordering could ever untangle. Hoist the shared " +
        "contract into `seats/` — that is what `seats/` is for — or into the lowest layer " +
        "family that needs it. The two composition sites are the only files that name more " +
        "than one view family, and they are subtracted from BOTH endpoints below, as they are " +
        "from the view-family set itself.",
      severity: "error",
      // The top-level owner is captured from the source and subtracted from the target, so
      // this is one rule over N families rather than N² pairs: a family added by a branch is
      // covered the moment its directory exists. Intra-family edges — the common case — are
      // the ones `$1` removes.
      from: { path: `${CONSOLE}/([^/]+)/`, pathNot: VIEW_FAMILIES.pathNot },
      to: { path: `${CONSOLE}/`, pathNot: [...VIEW_FAMILIES.pathNot, `${CONSOLE}/$1/`] },
    },
    {
      name: "console-no-barrel-chain",
      comment:
        "A barrel re-exported from another barrel. A family door publishes its own family's " +
        "modules and a sub-module door (`bridge/growth-values/`, `bridge/scenarios/`) publishes " +
        "its own directory's; forwarding a symbol through a second `index.ts` makes its home a " +
        "matter of following two hops, and it lets a family door publish a name it never " +
        "declared. Re-export from the module that DECLARES the symbol. This matches only the " +
        "`export … from` dependency type, so a composition site importing a family door for a " +
        "type it uses in a signature — which `panes/index.ts` does — is not a chain and is not " +
        "reported.",
      severity: "error",
      from: { path: CONSOLE_BARRELS },
      to: { path: CONSOLE_BARRELS, dependencyTypes: ["export"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Test files are not subjects of the layering DAG: a `console-unit` test legitimately
    // reaches across families to drive the module it covers, and reaches both process trees to
    // assert the boundary between them.
    exclude: { path: "\\.(test|bench)\\.(ts|tsx)$|__tests__/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
