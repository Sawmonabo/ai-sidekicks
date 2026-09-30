// electron-vite v5 configuration: three build targets (main, preload, renderer).
//
// The renderer loads over a custom protocol, not file://. Source maps are emitted as "hidden":
// available for reading a crash report's stack but not referenced from the shipped bundle. The
// release fixture gate (`tests/budget/release-absence.test.ts`) reads the same maps and fails
// rather than passing if a target stops writing them.
//
// Module system per target, decided empirically:
//
//   • main: `format: "es"` (entryFileNames: index.js). The package root has `"type": "module"` and
//     Electron supports an ESM main process since v28, so ESM matches the rest of the monorepo.
//     `app.requestSingleInstanceLock()` and `app.exit()` behave identically under ESM (verified).
//
//   • preload: `format: "cjs"` (entryFileNames: index.cjs). Electron's sandboxed preload runtime
//     (`sandbox: true`, set in `src/main/windows/window.ts`) supports only CommonJS: an ESM preload
//     fails to register with "SyntaxError: Cannot use import statement outside a module" (verified
//     on Electron 41.6.1, unchanged on 44.x). The `.cjs` extension is load-bearing, since under the
//     package's `"type": "module"` Node would refuse to load a `.js` file as CJS. `PRELOAD_PATH` in
//     that file resolves `../preload/index.cjs` accordingly.
//
//   • renderer: browser ESM via the Vite default. Chromium loads renderer chunks via
//     `<script type="module">`, which the package `type` field does not affect.
//
// `electron` is externalized for main and preload so the bundle emits
// `import { app } from "electron"` (or `require("electron")` for the CJS preload) rather than
// inlining the npm package's installer script, which returns a binary path string, not an API
// surface. electron-vite's preset declares this default, but the user `rollupOptions.output`
// override loses it through mergeConfig in some paths, so it is re-declared here. `/^electron\/.+/`
// keeps `electron/<subpath>` external too.
//
// Smoke-probe production safety: `main` has a `define` entry `__SIDEKICKS_SMOKE_BUILD__` that
// substitutes `false` in default builds and `true` in `--mode=smoke` builds (`build:smoke` in
// `apps/desktop/package.json`). The smoke-probe branch in `src/main/index.ts` is gated on it as the
// outer condition, so release bundles tree-shake the whole branch (Rollup folds `if (false && ...)`
// to nothing). A runtime env-var gate (`SIDEKICKS_SMOKE_PROBE=1`) keeps even the smoke bundle from
// auto-running the probe.
//
// `define` is a textual substitution applied before parsing; `JSON.stringify(boolean)` yields the
// literal `true` or `false` that Vite injects. Only `main` needs it, since preload and renderer
// contain no probe branch. After `pnpm build`, `grep -c` for `SIDEKICKS_SMOKE_PROBE`,
// `executeJavaScript` and `about:blank` in `out/main/index.js` all return 0, proving the probe body
// never reaches the release bundle.
//
// Renderer dev server, Content-Security-Policy parity: `electron-vite dev` serves the renderer over
// HTTP and sets `ELECTRON_RENDERER_URL`, which `src/main/windows/window.ts` loads instead of the
// built bundle. That document does not pass through the protocol handler, so it does not inherit
// the handler's response headers; without the `server` block below the dev renderer would run with
// no policy at all. The dev server therefore emits the same policy the handler does, composed from
// the same directive list in `src/main/services/renderer-scheme.ts` so the two cannot drift,
// widened by one directive: `connect-src` also admits the HMR websocket. `strictPort` is set
// because the policy names that port literally, and a silent fallback to another port would leave
// HMR blocked by a policy that no longer matches the server.

import { fileURLToPath } from "node:url";

import { defineConfig, type ElectronViteConfigFnObject } from "electron-vite";

import {
  RENDERER_DEV_CONTENT_SECURITY_POLICY,
  RENDERER_DEV_SERVER_PORT,
} from "./src/main/services/renderer-scheme.js";
import { iconCompilationPlugin } from "./vitest/icon-compilation.js";
import { PATH_ALIASES } from "./vitest/path-aliases.js";

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
 * console installs its token sheet and registers its families at module scope elsewhere, and a
 * blanket declaration would invite the bundler to drop those.
 *
 * A feature's `fixtures/` folder needs it for its stylesheet. Its JavaScript is referenced only
 * from folded fixture branches and leaves the bundle on its own, but a door module holding a bare
 * stylesheet import is a side effect the bundler keeps, and Vite's CSS transform marks the sheet
 * itself `"no-treeshake"`. Declaring the door side-effect-free drops the edge that would pull the
 * sheet into a release renderer.
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
  "/src/renderer/src/app/fixture-composition.ts",
  "/src/renderer/src/app/fixture-global-names.ts",
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
// `src/main/services/renderer-scheme.test.ts` imports this module (it asserts the dev server emits
// the same policy as the protocol handler), so it is part of a checked program.
const electronViteConfig: ElectronViteConfigFnObject = defineConfig(({ mode }) => {
  // `--mode=smoke` builds ship the probe; the default build tree-shakes it out. See the header.
  const isSmokeBuild = mode === "smoke";
  // The builds that carry the scenario catalog: `electron-vite dev` (mode `development`) and
  // `electron-vite build --mode=fixtures`, the bundle the test tiers launch. Either plays a
  // scenario only when launched with `--fixture <scenario>`. Every other mode, the release build
  // included, folds the fixture code away.
  const isFixtureBuild = mode === "development" || mode === "fixtures";
  // The builds the automated Electron tiers launch, which may hide their windows
  // (`src/main/windows/window-reveal.ts`). Narrower than the fixture flag: a
  // development window is never hidden.
  const isTestTierBuild = isSmokeBuild || mode === "fixtures";

  return {
    main: {
      resolve: { alias: PATH_ALIASES },
      // See the header on `define`: a textual substitution, so Rollup folds `if (false && expr)`
      // and drops the probe body from the release bundle.
      define: {
        __SIDEKICKS_SMOKE_BUILD__: JSON.stringify(isSmokeBuild),
        // The console's fixture gate reaches `main` too, because main checks a
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
      resolve: { alias: PATH_ALIASES },
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
      resolve: { alias: PATH_ALIASES },
      // The console's icon family, compiled to components at build time rather than fetched or
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
      // The console's fixture gate, beside the smoke gate above and for the same reason: a
      // build-time literal, not a runtime flag. A runtime environment variable would ship every
      // scenario, the engine and the manifest to users, charge them the bytes on every
      // bundle-budget run, and leave a switch that flips the app into fixture data in production.
      // As a literal, Rollup folds `if (false)` and drops the whole subtree, which
      // `tests/budget/release-absence.test.ts` asserts by reading the release build's source maps:
      // no module `isFixtureOnlyModule` names may appear in them.
      //
      // True under `electron-vite dev` and `--mode=fixtures`, and in the Vitest console projects,
      // which set the same define.
      define: {
        __FIXTURE_BUILD__: JSON.stringify(isFixtureBuild),
      },
      build: {
        outDir: "out/renderer",
        sourcemap: "hidden",
        // Minified, because electron-vite is not Vite here. Vite's production default is
        // `minify: "esbuild"`; electron-vite overrides it to `false` for every target on the
        // reasoning that a desktop bundle loads from disk. That does not hold here: unminified, the
        // shipped bundle carried the console's source text (every comment, every identifier at full
        // length), and the `renderer-initial-bundle` budget (≤ 450 000 B gzip) gated an artifact
        // nobody downloads. Measured: 443 585 B unminified against 244 546 B minified, so the
        // budget read within 2 % of its ceiling on bytes the shipped app does not have. Source maps
        // stay `hidden` above, so a stack trace is still resolvable by anyone holding the map and
        // the bundle carries no `sourceMappingURL` for anyone who is not.
        minify: "esbuild",
        // `.vite/manifest.json`: the chunk graph Rollup already computed, written out on request.
        // It carries `isEntry`, the static `imports` of every chunk, its `dynamicImports`, `css`
        // and `assets`, which is the initial-versus-lazy split the initial-bundle budget bounds (≤
        // 450 kB gzip, excluding lazy chunks). `scripts/budget/measure-bundle.mts` reads it instead
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
          // prove pure. A scenario is built by calling builders at module scope, so none of those
          // statements is provably pure and all were retained. Measured on the release artifact
          // without this option: `"Browsing agent"`, `artifact-capture-staging-header`,
          // `scenarios:` and `fixtureServedOperations` were all present in `index-*.js`.
          //
          // So the corpus declares what is true of it: those directories hold pure data and pure
          // builders and run nothing at import time. Then the unreferenced bindings go, and the
          // modules with them. The claim is path-scoped, not a package-wide `sideEffects: false`,
          // which would also invite the bundler to drop the token-sheet install and the tripwire
          // registrations that legitimately run at module scope. It is not mode-scoped, and need
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
