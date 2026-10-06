// electron-vite configuration: three build targets (main, preload, renderer).
//
// The renderer loads over a custom protocol, not file://. Source maps are "hidden": readable for a
// crash report's stack but not referenced from the shipped bundle. The release fixture gate
// (`tests/budget/release-absence.test.ts`) reads the same maps and fails if a target stops writing
// them.
//
// Module system per target:
//
//   • main: `format: "es"` (`index.js`). The package is `"type": "module"` and Electron runs an
//     ESM main process.
//   • preload: `format: "cjs"` (`index.cjs`). The sandboxed preload (`sandbox: true` in
//     `src/main/windows/factory.ts`) loads only CommonJS; an ESM preload fails with "Cannot use
//     import statement outside a module". The `.cjs` extension is what lets Node load it as CJS
//     under `"type": "module"`, and `PRELOAD_PATH` in that file names it.
//   • renderer: browser ESM, loaded through `<script type="module">`.
//
// `electron` is external for main and preload, so the bundle imports the API rather than inlining
// the npm package's installer script, which returns a binary path. The preset declares this, but
// the `rollupOptions.output` override loses it through `mergeConfig`, so it is re-declared here.
//
// The smoke probe: `main`'s `define` substitutes `__SMOKE_BUILD__` with `false` in every
// build but `--mode=smoke`, and the probe branch in `src/main/index.ts` is gated on it, so Rollup
// folds the branch out of a release bundle. A runtime `SIDEKICKS_SMOKE_PROBE=1` gate keeps even the
// smoke bundle from running the probe on its own.
//
// The dev server's Content-Security-Policy: `electron-vite dev` serves the renderer over HTTP,
// which bypasses the protocol handler's response headers, so the `server` block sends the same
// policy, composed from the directive list in `src/main/services/renderer/scheme.ts` and widened
// only to admit the HMR websocket. `strictPort` holds because the policy names that port.

import { fileURLToPath } from "node:url";

import { defineConfig, type ElectronViteConfigFnObject } from "electron-vite";

import {
  RENDERER_DEV_CONTENT_SECURITY_POLICY,
  RENDERER_DEV_SERVER_PORT,
} from "./src/main/services/renderer/scheme.js";
import { iconCompilationPlugin } from "./vitest/icon-compilation.js";

const ELECTRON_EXTERNAL: readonly (string | RegExp)[] = ["electron", /^electron\/.+/];

/** The scenario catalog: scenario definitions and the scripted data they play. */
const FIXTURE_CATALOG_DIRECTORY: string = fileURLToPath(new URL("./fixtures/", import.meta.url))
  .split("\\")
  .join("/");

/** A fixture implementation, which sits beside the real boundary it substitutes. */
const FIXTURE_IMPLEMENTATION_PATTERN = /\.fixture\.[cm]?tsx?$/u;

/** A feature's `fixtures/` folder, which holds a fixture of a boundary that feature owns. */
const FEATURE_FIXTURES_PATTERN = /\/src\/renderer\/src\/features\/.+\/fixtures\//u;

/**
 * Does this module belong to the fixture corpus: the catalog, a fixture implementation, or a
 * feature's `fixtures/` folder?
 *
 * The corpus holds components and pure readings and runs nothing at import time, so the renderer
 * build declares it side-effect-free and drops what nothing references. The declaration is
 * path-scoped rather than a package-wide `sideEffects` claim, because it is true only here: the
 * renderer installs its token sheet and registers its feature contributions at module scope
 * elsewhere, and a blanket declaration would invite the bundler to drop those.
 *
 * A feature's `fixtures/` folder needs it for its stylesheet. Its JavaScript is referenced only
 * from folded fixture branches and leaves the bundle on its own, but the module that imports the
 * folder's stylesheet is a side effect the bundler keeps, and Vite's CSS transform marks the sheet
 * itself `"no-treeshake"`. Declaring that module side-effect-free drops the edge that would pull
 * the sheet into a release renderer.
 */
function isFixtureCorpusModule(moduleId: string): boolean {
  const normalized = moduleId.split("\\").join("/");
  return (
    FIXTURE_IMPLEMENTATION_PATTERN.test(normalized) ||
    FEATURE_FIXTURES_PATTERN.test(normalized) ||
    normalized.includes(FIXTURE_CATALOG_DIRECTORY)
  );
}

/**
 * Fixture-only modules that live outside the corpus directories.
 *
 * The build needs no side-effect declaration for them: they are reached only through the fixture
 * composition, which `App.tsx` calls inside a folded `__FIXTURE_BUILD__` branch, so they leave the
 * bundle on their own. They are named here so the release gate can prove that they did.
 */
const FIXTURE_ONLY_PATHS: readonly string[] = [
  "/src/renderer/src/app/fixture/composition.ts",
  "/src/renderer/src/app/fixture/global-names.ts",
  "/src/renderer/src/app/pane-harness/",
];

/** A test suite or its scaffolding, which no build of any flavor ships. */
const TEST_MODULE_PATTERN = /\.test(?:-support)?\.[cm]?tsx?$/u;

/**
 * Does a release build owe this module's absence?
 *
 * True for the fixture corpus, for the fixture-only modules outside it, and for every test
 * and test-support file. `tests/budget/release-absence.test.ts` reads the release
 * build's source maps, which list every module that rendered code into a shipped file, and
 * fails on any module this answers true for. The tree-shaking declaration below reads the
 * narrower {@link isFixtureCorpusModule}, because only the corpus needs its side effects
 * declared away.
 */
export function isFixtureOnlyModule(moduleId: string): boolean {
  const normalized = moduleId.split("\\").join("/");
  return (
    isFixtureCorpusModule(normalized) ||
    FIXTURE_ONLY_PATHS.some((path) => normalized.includes(path)) ||
    TEST_MODULE_PATTERN.test(normalized)
  );
}

// Annotated rather than inferred: `isolatedDeclarations` is repo-wide, and
// `tests/budget/release-absence.test.ts` imports this module (it reads `isFixtureOnlyModule`), so
// it is part of a checked program.
const electronViteConfig: ElectronViteConfigFnObject = defineConfig(({ mode }) => {
  // `--mode=smoke` builds ship the probe; the default build tree-shakes it out. See the header.
  const isSmokeBuild = mode === "smoke";
  // The builds that carry the scenario catalog: `electron-vite dev` (mode `development`) and
  // `electron-vite build --mode=fixtures`, the bundle the test tiers launch. Either plays a
  // scenario only when launched with `--fixture <scenario>`. Every other mode, the release build
  // included, folds the fixture code away.
  const isFixtureBuild = mode === "development" || mode === "fixtures";
  // The builds the automated Electron tiers launch, which may hide their windows
  // (`src/main/windows/reveal.ts`). Narrower than the fixture flag: a
  // development window is never hidden.
  const isTestTierBuild = isSmokeBuild || mode === "fixtures";

  return {
    main: {
      // See the header on `define`: a textual substitution, so Rollup folds `if (false && expr)`
      // and drops the probe body from the release bundle.
      define: {
        __SMOKE_BUILD__: JSON.stringify(isSmokeBuild),
        // The fixture gate reaches `main` too, because main checks a
        // `--fixture` launch against the scenario catalog. A release main bundle
        // folds the check and its catalog import away and refuses the argument.
        __FIXTURE_BUILD__: JSON.stringify(isFixtureBuild),
        __TEST_TIER_BUILD__: JSON.stringify(isTestTierBuild),
      },
      build: {
        outDir: "out/main",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: "src/main/index.ts",
          },
          external: [...ELECTRON_EXTERNAL],
          output: {
            format: "es",
            entryFileNames: "index.js",
          },
        },
      },
    },
    preload: {
      // The preload hands a fixture launch to the page, and only in a build that
      // carries the catalog; a release preload folds the read away.
      define: {
        __FIXTURE_BUILD__: JSON.stringify(isFixtureBuild),
      },
      build: {
        outDir: "out/preload",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: "src/preload/index.ts",
          },
          external: [...ELECTRON_EXTERNAL],
          output: {
            // The sandboxed preload requires CommonJS, and the `.cjs` extension overrides the
            // package's `"type": "module"`. See the header.
            format: "cjs",
            entryFileNames: "index.cjs",
          },
        },
      },
    },
    renderer: {
      // The app's icons, compiled to components at build time rather than fetched or
      // inlined as markup. The options live in one module the Vitest tiers call too (see
      // `vitest/icon-compilation.ts`), so the three consumers cannot drift.
      plugins: [iconCompilationPlugin()],
      server: {
        port: RENDERER_DEV_SERVER_PORT,
        // See the header note: the policy names this port, so a silent
        // fallback to the next free one must fail instead.
        strictPort: true,
        headers: {
          "Content-Security-Policy": RENDERER_DEV_CONTENT_SECURITY_POLICY,
          "X-Content-Type-Options": "nosniff",
        },
      },
      // The renderer's fixture gate, beside the smoke gate above and for the same reason: a
      // build-time literal, not a runtime flag. A runtime environment variable would ship every
      // scenario, the engine and the manifest to users, charge them the bytes on every
      // bundle-budget run, and leave a switch that flips the app into fixture data in production.
      // As a literal, Rollup folds `if (false)` and drops the whole subtree, which
      // `tests/budget/release-absence.test.ts` asserts by reading the release build's source maps:
      // no module `isFixtureOnlyModule` names may appear in them.
      //
      // True under `electron-vite dev` and `--mode=fixtures`, and in the Vitest renderer projects,
      // which set the same define.
      define: {
        __FIXTURE_BUILD__: JSON.stringify(isFixtureBuild),
      },
      build: {
        outDir: "out/renderer",
        sourcemap: "hidden",
        // Minified, because electron-vite is not Vite here. Vite's production default is `minify:
        // "esbuild"`; electron-vite overrides it to `false` for every target on the reasoning that
        // a desktop bundle loads from disk. Unminified, the bundle carries the renderer's source
        // text and the `renderer-initial-bundle` budget measures bytes the app would not need
        // (measured: 443 585 B gzip unminified, 244 546 B minified). Source maps stay `hidden`
        // above, so a stack trace is still resolvable by anyone holding the map.
        minify: "esbuild",
        // `.vite/manifest.json`: the chunk graph Rollup already computed, written out on request.
        // It carries `isEntry`, the static `imports` of every chunk, its `dynamicImports`, `css`
        // and `assets`, which is the initial-versus-lazy split the initial-bundle budget bounds
        // (lazy chunks excluded). `scripts/budget/measure-bundle.mts` reads it instead
        // of re-deriving the graph from emitted text: the bundler that made the split is the
        // authority on it. The manifest is build metadata, not a shipped asset (nothing links it,
        // and the protocol handler serves only what `index.html` reaches), so the budget harness
        // excludes the whole `.vite/` directory from its inventory.
        manifest: true,
        rollupOptions: {
          input: {
            index: "src/renderer/index.html",
          },
          // The second half of the fixture gate; without it the first half does not finish the job.
          // The `define` above folds the one fixture call site, `App.tsx`'s composition, to
          // nothing, but not the static import edges that reach the corpus (`App.tsx` imports the
          // fixture composition, which imports the fixture bridge and the catalog at module scope),
          // and a module the graph still reaches keeps every top-level statement the bundler cannot
          // prove pure. A scenario is built by calling builders at module scope, so without this
          // option scenario text and fixture handlers stay in the release `index-*.js`.
          //
          // So the corpus declares what is true of it: those directories hold pure data and pure
          // builders and run nothing at import time. Then the unreferenced bindings go, and the
          // modules with them. The claim is path-scoped (see `isFixtureCorpusModule`), not a
          // package-wide `sideEffects: false`. It is not mode-scoped, and need
          // not be: in a fixture build the corpus is referenced, so nothing about it is unused.
          // `tests/budget/release-absence.test.ts` gates the outcome on the release build's source
          // maps, with a planted negative control.
          treeshake: {
            moduleSideEffects: (moduleId: string) => !isFixtureCorpusModule(moduleId),
          },
        },
      },
    },
  };
});

export default electronViteConfig;
