// The renderer's layer vocabulary, for `.dependency-cruiser.mjs` beside it.
//
// Kept apart from the rule set because they are two jobs: this half says what the layers are
// (where each lives and what sits above it) and is what a branch adding a top-level folder touches;
// the other half says what is forbidden over that vocabulary and is what a branch tightening a rule
// touches.
//
// A name is exported only when the rule set reads it: a name it stops using is a name to delete
// rather than one to hide.

/** The renderer source root. */
export const RENDERER = "^src/renderer/src";

// The layers, low to high. A layer imports any layer below it and none above; two
// folders on one rung may import each other, and `no-circular` holds that pair to a
// one-way edge. `src/shared/` sits below them all and is `CROSS_PROCESS_SHARED` below.
export const LIB = `${RENDERER}/lib/`;
export const STYLES = `${RENDERER}/styles/`;
export const ASSETS = `${RENDERER}/assets/`;
export const ROUTING = `${RENDERER}/routing/`;
export const COMPONENTS = `${RENDERER}/components/`;
export const HOOKS = `${RENDERER}/hooks/`;
export const STORE = `${RENDERER}/store/`;
export const SERVICES = `${RENDERER}/services/`;
export const REGISTRIES = `${RENDERER}/registries/`;
export const FEATURES = `${RENDERER}/features/`;
export const LAYOUT = `${RENDERER}/layout/`;
const APP = `${RENDERER}/app/`;

/**
 * Where a renderer module may live: the top-level folders, and at the root only the entry and
 * its two ambient declarations.
 */
export const RENDERER_HOMES = [
  LIB,
  STYLES,
  ASSETS,
  ROUTING,
  COMPONENTS,
  HOOKS,
  STORE,
  SERVICES,
  REGISTRIES,
  FEATURES,
  LAYOUT,
  APP,
  `${RENDERER}/main\\.tsx$`,
  `${RENDERER}/desktop-bridge\\.d\\.ts$`,
  `${RENDERER}/vite-env\\.d\\.ts$`,
];

/**
 * The two stores held apart inside `store/`: one per window, one per open session.
 *
 * A flag copied across that line is a second record of one fact that the reconnect path cannot
 * heal: the session store's degraded cause clears on a re-pull, and a copy on the window store
 * clears only when somebody remembers to. Neither store can read the other's state without
 * importing from it (there is no global handle to either), so banning the import edge is exact
 * rather than a proxy. The composition above the stores (the registry that opens session stores,
 * the hooks, the schedulers) reads both by design, which is why this names the two subtrees and not
 * `store/`.
 *
 * It is a capture group because the rule that spends it subtracts the source's own subtree from its
 * target set, which makes one rule cover both directions.
 */
export const STORE_ISOLATED_SUBTREES = `${STORE}(window|session)/`;

/**
 * Test scaffolding. A `.test-support.*` module is a module like any other and stays a
 * subject of every rule about module shape; it is subtracted from the source side of
 * `feature-public-api-only`, because the symbols a harness reaches for are ones no
 * feature's `index.ts` publishes to production, and it may read `fixtures/` as the tests
 * it serves do.
 */
export const TEST_SUPPORT_MODULES = "\\.test-support\\.(ts|tsx)$";

/** The package's test scaffolding folder, which nothing that ships may import. */
export const TEST_HELPERS = "^tests/";

/**
 * The one cross-process leaf: types and pure functions main, preload and the renderer
 * all need. Two rules scope to it and they say opposite things — what it may import,
 * and who may import it.
 */
export const CROSS_PROCESS_SHARED = "^src/shared/";

/** The scenario definitions and scripted data a fixture build plays. */
export const FIXTURES = "^fixtures/";

/**
 * The modules that may import `fixtures/`: the fixture implementations beside their
 * boundaries (a `*.fixture.ts` file or a feature's `fixtures/` folder), `app/`'s fixture
 * composition and pane harness, and the one main-process module that checks a `--fixture`
 * name against the catalog.
 */
export const FIXTURE_READERS = [
  "\\.fixture\\.tsx?$",
  `${FEATURES}.+/fixtures/`,
  `${APP}fixture-composition\\.tsx?$`,
  `${APP}pane-harness/`,
  "^src/main/fixture-launch\\.ts$",
];

/**
 * A feature's `fixtures/` folder: the fixture of a boundary that feature owns, which a fixture
 * build mounts in place of the real one.
 *
 * A capture group, because the rule that keeps a fixture's stylesheet inside its folder subtracts
 * the importer's own folder from its target set, making it one rule over every feature's fixtures.
 */
export const FEATURE_FIXTURES = `${FEATURES}(.+)/fixtures/`;

/** A stylesheet anywhere inside a feature's `fixtures/` folder. */
export const FEATURE_FIXTURES_STYLESHEET = `${FEATURES}.+/fixtures/.+\\.css$`;

/** A feature's public API, the one module another folder may import from it. */
export const FEATURE_PUBLIC_APIS = `${FEATURES}[^/]+/index\\.ts$`;

/**
 * Every barrel in the renderer.
 *
 * Two alternatives rather than one `(?:[^/]+/)*`: dependency-cruiser refuses a rule whose regular
 * expression has a star height above one (a quantified group containing its own quantifier is the
 * catastrophic-backtracking shape) and bails out of the cruise rather than running slowly.
 */
export const BARRELS = [`${RENDERER}/index\\.ts$`, `${RENDERER}/.+/index\\.ts$`];

/** Everything strictly above each rung, as one alternation. */
export const ABOVE_LIB_STYLES_ASSETS = [
  ROUTING,
  COMPONENTS,
  HOOKS,
  STORE,
  SERVICES,
  REGISTRIES,
  FEATURES,
  LAYOUT,
  APP,
];
export const ABOVE_ROUTING = [
  COMPONENTS,
  HOOKS,
  STORE,
  SERVICES,
  REGISTRIES,
  FEATURES,
  LAYOUT,
  APP,
];
export const ABOVE_COMPONENTS_HOOKS = [STORE, SERVICES, REGISTRIES, FEATURES, LAYOUT, APP];
export const ABOVE_STORE = [SERVICES, REGISTRIES, FEATURES, LAYOUT, APP];
export const ABOVE_SERVICES = [REGISTRIES, FEATURES, LAYOUT, APP];
export const ABOVE_REGISTRIES = [FEATURES, LAYOUT, APP];
export const ABOVE_FEATURES = [LAYOUT, APP];
export const ABOVE_LAYOUT = [APP];

/** One forbidden rule per rung: an edge from that rung to anything above it. */
export function upwardEdge(layer, fromPaths, toPaths) {
  return {
    name: `layering-${layer}`,
    comment:
      `\`${layer}\` sits below the folders it imported. The import direction is ` +
      `shared → lib/styles/assets → routing → components/hooks → store → services → ` +
      `registries → features → layout → app. Move the symbol down to the lowest folder ` +
      `that needs it; never deep-import around the edge.`,
    severity: "error",
    from: { path: fromPaths },
    to: { path: toPaths },
  };
}
