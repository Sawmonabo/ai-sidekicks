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
 * The one cross-family deep specifier the tree still carries, and why it is named here.
 *
 * `frame/surface-registry.ts` declares `ConsoleSurfaceContext` and the registry a view
 * family registers itself into, and a view family cannot import the FRAME's door to
 * reach them: that door composes the view families through `families.ts`, so an import
 * back closes a cycle `no-circular` fails. Its right home is `seats/` — it is a contract
 * through which families hand each other bodies, and it imports nothing above `bridge/`
 * — and the pane registry now travels through the surface context, but the module still
 * sits in `frame/`; moving it is the cross-family structure audit's, at which point this
 * exemption is deleted and the rule covers the whole console. Naming the one module
 * rather than excepting `frame/` keeps the rule's reach exact: a second deep specifier
 * into this family, including one into this same module's neighbours, still fails.
 */
const FRAME_SURFACE_REGISTRY = `${CONSOLE}/frame/surface-registry\\.ts$`;

/** Every family door, and only a family door — a sub-module door is one segment deeper. */
const CONSOLE_FAMILY_DOORS = `${CONSOLE}/[^/]+/index\\.ts$`;

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
        "declarations, stylesheets, and tool configuration are roots, not orphans — and so " +
        "is a `.test-support.*` module, whose only legitimate dependents are the suites " +
        "`options.exclude` below removes from the graph BEFORE this rule runs. Its emptiness " +
        "is a property of that exclusion rather than of the module, and the gate that does " +
        "own its reachability is `knip`, which sees the test entries and reports an unused " +
        "export there like any other.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.(ts|mts)$",
          "\\.css$",
          "\\.json$",
          "(^|/)[^/]+\\.config\\.(ts|mjs|cjs|js)$",
          "\\.test-support\\.(ts|tsx)$",
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
      name: "console-cross-family-deep-import",
      comment:
        "A console family reached into another family's module instead of its door. " +
        "`apps/desktop/AGENTS.md` §Module shape: cross-family imports go through the " +
        "family door, intra-family imports are deep. The two rules above order the " +
        "families and keep view families apart; neither says anything about HOW a " +
        "permitted edge is written, so a downward edge past a barrel — the shape a " +
        "caller reaches for when importing the door would close a cycle — stayed green. " +
        "The fix is never the deep specifier: hoist the symbol to the lowest family " +
        "that owns its inputs, and import it from that family's door. A sub-module " +
        "door (`bridge/growth-values/`, `bridge/scenarios/`) is deliberately NOT a " +
        "legal target here — it publishes to its own family only, which is why the " +
        "exemption below matches a family door's single path segment and not a nested " +
        "one. The composition sites are subtracted at both ends on the same terms the " +
        "view-family rule subtracts them: `panes/` sits above every family by " +
        "construction, so its edges are composition rather than layering.",
      severity: "error",
      from: { path: `${CONSOLE}/([^/]+)/`, pathNot: [COMPOSITION_PANE_BOARD] },
      to: {
        path: `${CONSOLE}/[^/]+/`,
        pathNot: [
          `${CONSOLE}/$1/`,
          CONSOLE_FAMILY_DOORS,
          COMPOSITION_PANE_BOARD,
          FRAME_SURFACE_REGISTRY,
        ],
      },
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
    // assert the boundary between them. `*.test-support.*` is the same class by the same
    // reasoning — it is the scaffolding a suite factors out, imported by test files and by
    // nothing else — and it was outside this pattern only because the pattern was written
    // before that suffix existed.
    exclude: { path: "\\.(test|test-support|bench)\\.(ts|tsx)$|__tests__/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
