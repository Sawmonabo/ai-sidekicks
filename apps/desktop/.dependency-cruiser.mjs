// Layering gate for `apps/desktop` — one of the two structure-enforcement legs.
//
// It answers one question the type system cannot: which module is allowed to import which.
// ESLint's `no-restricted-imports` already owns the renderer-untrusted specifier bans, and it
// keeps them — a `files`-scoped specifier ban is exactly what that rule is for. What it cannot
// express is an ORDERING over the renderer's layers, because flat config replaces a rule's
// options at the last matching block, so every layer would have to restate the whole list of
// layers above it. That table lives here instead.
//
// Resolution runs through `enhanced-resolve` with an explicit extension list, NOT through
// `--ts-config`. dependency-cruiser resolves a tsconfig's `extends` chain against the process
// directory rather than against the tsconfig's own directory, so a tsconfig whose `extends`
// climbs above its package only loads when the cruise runs from that exact directory. The path
// aliases come from `tsconfig.paths.json`, which extends nothing, so it has no such chain. The
// extension list is what makes this tree's `./foo.js` specifiers resolve to `foo.ts` sources.
//
// Paths are relative to `apps/desktop`; run it through `pnpm structure:layering`.
//
// The layer vocabulary this reasons over — the folders, the ladder, and the named
// readers — is `.dependency-cruiser.layers.mjs` beside this file.

import {
  ABOVE_COMPONENTS_HOOKS,
  ABOVE_FEATURES,
  ABOVE_LAYOUT,
  ABOVE_LIB_STYLES_ASSETS,
  ABOVE_REGISTRIES,
  ABOVE_ROUTING,
  ABOVE_SERVICES,
  ABOVE_STORE,
  ASSETS,
  BARRELS,
  COMPONENTS,
  CROSS_PROCESS_SHARED,
  FEATURE_PUBLIC_APIS,
  FEATURES,
  FEATURE_FIXTURES,
  FEATURE_FIXTURES_STYLESHEET,
  FIXTURE_READERS,
  FIXTURES,
  HOOKS,
  LAYOUT,
  LIB,
  REGISTRIES,
  RENDERER,
  ROUTING,
  SERVICES,
  STORE,
  STORE_ISOLATED_SUBTREES,
  STYLES,
  TEST_HELPERS,
  TEST_SUPPORT_MODULES,
  upwardEdge,
} from "./.dependency-cruiser.layers.mjs";

export default {
  forbidden: [
    {
      name: "no-circular",
      comment:
        "A cycle makes module initialisation order load-bearing and un-reviewable. Break it by " +
        "moving the shared symbol into the lower folder, not by deep-importing past a barrel.",
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
        "export there like any other. That `only legitimate dependents` clause is a check " +
        "rather than a claim: `test-support-has-no-shipping-reader` below is the rule that " +
        "holds it.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.(ts|mts)$",
          "\\.css$",
          "\\.json$",
          "(^|/)[^/]+\\.config\\.(ts|mjs|cjs|js)$",
          "\\.test-support\\.(ts|tsx)$",
          // A file kept whole for a consumer that is not built yet, exempted by its exact
          // path beside its `ignoreFiles` entry in the root `knip.json`; each goes in the
          // change that builds its consumer.
          //
          // Scripted diff patches kept as the fixtures' test data (register WT-14); the diff
          // read that plays them is built with the Review pane (build units DM-16 and B9).
          "^fixtures/data/repos-diff-patches\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "test-support-has-no-shipping-reader",
      comment:
        "A module that SHIPS imported test scaffolding: a `.test-support` module, or a helper " +
        "under `tests/`, which keeps its plain name without the suffix. The rule above already " +
        "says what a `.test-support` module is for — its only legitimate dependents are the " +
        "suites `options.exclude` removes from the graph. `feature-public-api-only` subtracts " +
        "the class from its SOURCE side, so a production module that imported a `.test-support` " +
        "sibling would reach whatever that sibling reaches with no rule reporting it. It can " +
        "only fire on an importer still in the graph — which, after the exclusion, is a module " +
        "that ships — so the remedy is never an exemption here: either the symbol belongs to " +
        "production, in which case it moves into a module that ships, or the importer belongs " +
        "to a suite, in which case it is named `.test-support` itself.",
      severity: "error",
      from: { path: "^src/", pathNot: [TEST_SUPPORT_MODULES] },
      to: { path: [TEST_SUPPORT_MODULES, TEST_HELPERS] },
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
      from: { path: CROSS_PROCESS_SHARED },
      // Both spellings of the one allowed target, and both are reachable: the contracts
      // package resolves into `node_modules/@ai-sidekicks/contracts/` once it has been built
      // and carries its bare specifier as its path when it has not, so the shape of this edge
      // depends on the build state of a sibling package. Measured both ways — the graph grows
      // by the resolved package's modules and the violation set does not move.
      to: {
        pathNot: "^(src/shared/|node_modules/@ai-sidekicks/contracts|@ai-sidekicks/contracts)",
      },
    },
    upwardEdge("lib-styles-assets", [LIB, STYLES, ASSETS], ABOVE_LIB_STYLES_ASSETS),
    upwardEdge("routing", ROUTING, ABOVE_ROUTING),
    upwardEdge("components-hooks", [COMPONENTS, HOOKS], ABOVE_COMPONENTS_HOOKS),
    upwardEdge("store", STORE, ABOVE_STORE),
    upwardEdge("services", SERVICES, ABOVE_SERVICES),
    upwardEdge("registries", REGISTRIES, ABOVE_REGISTRIES),
    upwardEdge("features", FEATURES, ABOVE_FEATURES),
    upwardEdge("layout", LAYOUT, ABOVE_LAYOUT),
    {
      name: "feature-isolation",
      comment:
        "One feature imported another, its `index.ts` included. Features are siblings: what " +
        "two features share goes through `registries/`, or down to `components/`, `hooks/`, " +
        "`store/` or `lib/` when it is really shared, and the session screen composes the " +
        "others through `app/` and the pane, contribution and registry seams.",
      severity: "error",
      // The source's own feature is captured and subtracted from the target, so this is one
      // rule over every feature rather than one per pair.
      from: { path: `${FEATURES}([^/]+)/` },
      to: { path: FEATURES, pathNot: `${FEATURES}$1/` },
    },
    {
      name: "feature-public-api-only",
      comment:
        "A module outside `features/` reached into a feature past its `index.ts`. A feature's " +
        "`index.ts` is its public API and the one module another folder imports from it; one " +
        "feature importing another at all is `feature-isolation`. Test scaffolding — a " +
        "`.test-support` module or a helper under `tests/` — is subtracted from the source " +
        "side: it drives a feature's internals for a suite, and a symbol only a suite needs " +
        "has no place in the public API.",
      severity: "error",
      from: { pathNot: [FEATURES, TEST_SUPPORT_MODULES, TEST_HELPERS] },
      to: { path: FEATURES, pathNot: FEATURE_PUBLIC_APIS },
    },
    {
      name: "store-isolation",
      comment:
        "The window store and the session store reached each other. They are two stores on " +
        "purpose — one per WINDOW, one per open SESSION — and a flag copied across that line " +
        "is a second record of one fact, the one the reconnect path cannot heal: the session " +
        "store's degraded cause clears on a re-pull, and a copy of it on the window store " +
        "clears when somebody remembers to. Read the other store through the registry, a " +
        "hook, or a scheduler above both, which is where composing them belongs. It lives here " +
        "rather than in `no-restricted-imports` because that rule matches the specifier TEXT " +
        "and so stops at the relative depths it enumerates; dependency-cruiser resolves the " +
        "specifier to a real path.",
      severity: "error",
      // The source's own subtree is captured and subtracted from the target set, so this is
      // one rule covering both directions rather than two rules covering one each.
      from: { path: STORE_ISOLATED_SUBTREES },
      to: { path: STORE_ISOLATED_SUBTREES, pathNot: `${STORE}$1/` },
    },
    {
      name: "app-is-composition-only",
      comment:
        "A module at the renderer ROOT that is not the entry imported a renderer module. The " +
        "root holds `main.tsx` and the ambient declarations; composition and bootstrap live in " +
        "`app/`, and everything else in the folder that owns it.",
      severity: "error",
      from: { path: `${RENDERER}/[^/]+$`, pathNot: [`${RENDERER}/main\\.tsx$`, "\\.d\\.ts$"] },
      to: { path: `${RENDERER}/` },
    },
    {
      name: "fixtures-import-source-types-only",
      comment:
        "A module under `fixtures/` imported a value from `src/`. `fixtures/` holds scenario " +
        "definitions and scripted data only; it takes the shapes it is written in from `src/` " +
        "as types, and the fixture implementations beside each boundary read it.",
      severity: "error",
      from: { path: FIXTURES },
      to: { path: "^src/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "fixtures-read-by-fixture-implementations",
      comment:
        "A module imported `fixtures/` that is not a fixture reader. Exactly these read it: " +
        "the fixture implementations beside their boundaries (`*.fixture.ts`), `app/`'s fixture " +
        "composition and pane harness, the tests and their `.test-support` scaffolding, and " +
        "`src/main/fixture-launch.ts`, which " +
        "checks a `--fixture` name against the catalog. A fixture build is chosen once, at " +
        "startup, by the fixture composition; no other module branches on it.",
      severity: "error",
      from: { path: "^src/", pathNot: [...FIXTURE_READERS, TEST_SUPPORT_MODULES] },
      to: { path: FIXTURES },
    },
    {
      name: "no-barrel-chain",
      comment:
        "A barrel re-exported from another barrel. Forwarding a symbol through a second " +
        "`index.ts` makes its home a matter of following two hops, and it lets a feature's " +
        "public API publish a name it never declared. Re-export from the module that DECLARES " +
        "the symbol. This matches only the `export … from` dependency type, so a barrel " +
        "importing another for a type it uses in a signature is not a chain and is not reported.",
      severity: "error",
      from: { path: BARRELS },
      to: { path: BARRELS, dependencyTypes: ["export"] },
    },
    {
      name: "fixture-stylesheet-outside-its-folder",
      comment:
        "A module inside one feature's `fixtures/` folder imported another fixtures folder's " +
        "stylesheet. A release build removes a feature's fixture by folding its fixture-build " +
        "ternary. That fold removes JavaScript and says nothing about a stylesheet: a sheet " +
        "ships its rules whenever a module the release build keeps imports it, and no source " +
        "map lists a stylesheet, so the release fixture gate cannot see one. Each fixture's " +
        "sheet enters through that fixture's own entry so that it ships exactly when the " +
        "fixture does. The importer's own folder is captured and subtracted, so this is one " +
        "rule over every feature's fixtures.",
      severity: "error",
      from: { path: FEATURE_FIXTURES },
      to: {
        path: FEATURE_FIXTURES_STYLESHEET,
        pathNot: `${FEATURES}$1/fixtures/`,
      },
    },
    {
      name: "fixture-stylesheet-from-outside-any-fixtures-folder",
      comment:
        "A module outside every feature's `fixtures/` folder imported a fixture's stylesheet. " +
        "A feature's chunk root is not gated, so a sheet imported from there or from any other " +
        "kept module ships its rules in a release renderer that contains none of the fixture " +
        "they style, and no source map lists a stylesheet, so the release fixture gate cannot " +
        "see it. Import the fixture's entry instead, which carries the sheet in a fixture " +
        "build and leaves with the fixture in a release one.",
      severity: "error",
      from: { pathNot: FEATURE_FIXTURES },
      to: { path: FEATURE_FIXTURES_STYLESHEET },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Test files are not subjects of the layering rules: a renderer test legitimately
    // reaches across folders to drive the module it covers, and reaches both process trees to
    // assert the boundary between them.
    exclude: { path: "\\.(test|bench)\\.(ts|tsx)$" },
    tsPreCompilationDeps: true,
    // A workspace package resolves to its path under `node_modules/` rather than to the
    // real path its pnpm link points at, so the contracts edge from `src/shared/` reads the
    // same whether or not the package has been built, and `doNotFollow` above holds for it.
    preserveSymlinks: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
    tsConfig: { fileName: "tsconfig.paths.json" },
  },
};
