// electron-vite v5 configuration — three build targets (main / preload / renderer).
//
// Per docs/plans/023-desktop-shell-and-renderer.md §Implementation Steps step 3:
// renderer loads via custom protocol (not file://); sourcemaps are emitted as
// "hidden" so they are available for Sentry upload but NOT referenced from the
// shipped bundle. Source-code protection (bytecodePlugin) is deferred to the
// Tier 8 remainder per Phase 1 partial scope.
//
// Plan-023 Phase 1 T-023p-1-7 activated this config as the active build pipeline
// (replacing the placeholder `tsc -b` script wired at T-023p-1-3). The module-
// system choice per target was decided empirically:
//
//   • main:    `format: "es"` (entryFileNames: index.js). The package root
//              has `"type": "module"`; Electron supports ESM main process
//              since v28, so the 44.x pin carries it too. Keeping main as ESM matches the rest of the
//              monorepo's module system. `app.requestSingleInstanceLock()`
//              and `app.exit()` work identically in ESM context (empirically
//              verified at T-023p-1-7).
//
//   • preload: `format: "cjs"` (entryFileNames: index.cjs). Electron's
//              sandboxed preload runtime (`sandbox: true`, locked by
//              `src/main/window.ts`) ONLY supports CommonJS — verified
//              empirically with Electron 41.6.1 and unchanged on the 44.x
//              pin: an ESM preload fails to
//              register with `"SyntaxError: Cannot use import statement
//              outside a module"`. The `.cjs` extension (not `.js`) is
//              load-bearing: under our `"type": "module"` package, Node
//              would otherwise refuse to load a `.js` file as CJS.
//              `src/main/window.ts`'s `PRELOAD_PATH` resolves
//              `"../preload/index.cjs"` accordingly.
//
//   • renderer: format unchanged (browser ESM via Vite default). Chromium
//              loads renderer chunks via `<script type="module">` which is
//              explicit and unaffected by the package `type` field.
//
// `electron` is externalized for both main and preload so the bundle emits
// `import { app } from "electron"` (or `require("electron")` for the CJS
// preload) at runtime — NOT inlining the npm package's installer-script
// (which returns a binary path string, not an API surface). electron-vite's
// preset declares this default but the user `rollupOptions.output` override
// loses it through mergeConfig in some paths, so we re-declare it here
// defensively. `/^electron\/.+/` also keeps `electron/<subpath>` external.
//
// Smoke-probe production safety — `__SIDEKICKS_SMOKE_BUILD__` define:
//
//   `main` has a `define` entry `__SIDEKICKS_SMOKE_BUILD__` that
//   compile-time-substitutes to `false` in default builds and `true` in
//   `--mode=smoke` builds. The smoke-probe branch in `src/main/index.ts`
//   is gated on this identifier as the OUTER condition; release bundles
//   tree-shake the entire branch as dead code (Rollup folds the
//   `if (false && ...)` to nothing). The smoke bundle (built via
//   `electron-vite build --mode=smoke`, see `apps/desktop/package.json`
//   `build:smoke` script) substitutes `true` and ships the probe body —
//   a secondary runtime env-var gate (`SIDEKICKS_SMOKE_PROBE=1`) keeps
//   even the smoke bundle from auto-running the probe.
//
//   `define` is a TEXTUAL substitution applied before parsing.
//   `JSON.stringify(boolean)` is the correct shape: it produces the
//   literal string `"true"` / `"false"`, which Vite then injects into
//   the source as the boolean literal `true` / `false`. Only `main`
//   needs the define — preload and renderer do not contain the probe
//   branch.
//
// Renderer dev server — Content-Security-Policy parity:
//
//   `electron-vite dev` serves the renderer over HTTP and sets
//   `ELECTRON_RENDERER_URL`, which `src/main/window.ts` loads instead of the
//   built bundle. That document does NOT pass through the protocol handler, so
//   it does not inherit the handler's response headers — without the `server`
//   block below the dev renderer would run with NO policy at all, and
//   `Spec-023 §Security Hardening Baseline` holds for every renderer document
//   and not merely for the packaged one. The dev server therefore emits the
//   same policy the handler does, composed from the SAME directive list in
//   `src/main/renderer-scheme.ts` so the two cannot drift, widened by exactly
//   one directive: `connect-src` also admits the HMR websocket. `strictPort`
//   is set because the policy names that port literally — a silent fallback to
//   5174 would leave HMR blocked by a policy that no longer matches the server
//   it is protecting, which is a confusing failure rather than a safe one.
//
//   The production-safety guarantee is empirical: after `pnpm build`,
//   `grep -c SIDEKICKS_SMOKE_PROBE out/main/index.js`,
//   `grep -c executeJavaScript out/main/index.js`, and
//   `grep -c "about:blank" out/main/index.js` all return 0 — proving
//   the probe body never reaches the release bundle.

import { defineConfig, type ElectronViteConfigFnObject } from "electron-vite";

import {
  RENDERER_DEV_CONTENT_SECURITY_POLICY,
  RENDERER_DEV_SERVER_PORT,
} from "./src/main/renderer-scheme.js";

const ELECTRON_EXTERNAL: readonly (string | RegExp)[] = ["electron", /^electron\/.+/];

/**
 * The directories that make up the console's fixture corpus.
 *
 * Three, and they are the three `Spec-023 §Console Design (Meridian)` §The fixture
 * bridge names: the scenario INSTANCES, the fixture bridge that serves them, and the
 * scenario vocabulary and engine a scenario is written in and played by.
 */
const FIXTURE_CORPUS_DIRECTORIES: readonly string[] = [
  "/src/renderer/src/console/bridge/scenarios/",
  "/src/renderer/src/console/bridge/fixture/",
  "/src/renderer/src/console/bridge/scenario-runtime/",
];

/**
 * Does this module belong to the fixture corpus?
 *
 * Path-scoped rather than a package-wide `sideEffects` claim, because the claim is
 * only true here: the console installs its token sheet and its tripwires at module
 * scope elsewhere, and a blanket declaration would invite the bundler to drop those.
 */
function isFixtureCorpusModule(moduleId: string): boolean {
  const normalized = moduleId.split("\\").join("/");
  return FIXTURE_CORPUS_DIRECTORIES.some((directory) => normalized.includes(directory));
}

// Annotated rather than inferred: `isolatedDeclarations` is repo-wide, and
// this module is imported by `src/main/renderer-scheme.test.ts` — which asserts
// the dev server emits the same Content-Security-Policy the protocol handler
// does — so it is part of a checked program and not config the compiler only
// ever sees through Vite's own loader.
const electronViteConfig: ElectronViteConfigFnObject = defineConfig(({ mode }) => {
  // `electron-vite build --mode=smoke` produces a smoke-test artifact that
  // ships the probe; the default `electron-vite build` produces a release
  // artifact that tree-shakes the probe entirely. See header comment.
  const isSmokeBuild = mode === "smoke";
  // `electron-vite build --mode=fixtures` produces the gallery/screenshot
  // artifact, which serves the console from scripted scenarios instead of the
  // preload bridge. Every other mode — the release build included — folds the
  // fixture subtree away.
  const isFixtureBuild = mode === "fixtures";

  return {
    main: {
      // Vite's `define` is a textual substitution before parsing. The shape
      // `JSON.stringify(boolean)` produces the string `"true"` / `"false"`,
      // which Vite injects as the boolean literal at the use site. Rollup's
      // dead-code elimination then collapses `if (false && expr)` to no
      // emitted code, dropping the probe body from the release bundle.
      define: {
        __SIDEKICKS_SMOKE_BUILD__: JSON.stringify(isSmokeBuild),
        // The console's fixture gate reaches `main` too, because the scenario a
        // fixture build plays is named by a launch environment variable that main
        // reads and forwards onto the renderer document URL. Substituted the same
        // way and for the same reason: a release main bundle folds the branch
        // away, so it carries neither the environment read nor the query.
        __SIDEKICKS_CONSOLE_FIXTURES__: JSON.stringify(isFixtureBuild),
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
      build: {
        outDir: "out/preload",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: "src/preload/index.ts",
          },
          external: [...ELECTRON_EXTERNAL],
          output: {
            // CJS preload with `.cjs` extension — sandboxed preload requires
            // CommonJS, AND the explicit `.cjs` extension overrides the
            // package-level `"type": "module"` for Node's module-system
            // resolution. See header comment.
            format: "cjs",
            entryFileNames: "index.cjs",
          },
        },
      },
    },
    renderer: {
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
      // The console's fixture gate, beside the smoke gate above and for the same
      // reason: a build-time literal, not a runtime flag.
      //
      // `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the
      // fixture `define`-gated. A runtime environment variable could not do this
      // job — it would ship every scenario, the engine, and the manifest to
      // users, charge them the bytes on every bundle-budget run, and leave a
      // switch that flips the app into fixture data in production. As a literal,
      // Rollup folds `if (false)` and drops the whole subtree, which the
      // architecture tier asserts by grepping the release bundle for a scenario
      // id.
      //
      // True only under `--mode=fixtures` (the gallery and screenshot builds) and
      // in the Vitest console projects, which set the same define.
      define: {
        __SIDEKICKS_CONSOLE_FIXTURES__: JSON.stringify(isFixtureBuild),
      },
      build: {
        outDir: "out/renderer",
        sourcemap: "hidden",
        // Minified, because electron-vite is not Vite here.
        //
        // Vite's own production default is `minify: "esbuild"`; electron-vite
        // OVERRIDES it to `false` for every target, on the reasoning that a
        // desktop bundle is loaded from disk rather than over a network. That
        // reasoning does not survive contact with this package: what shipped was
        // the console's SOURCE TEXT — every comment in this tree, every
        // identifier at full length — and the `renderer-initial-bundle` budget
        // (`Spec-023 §Console Design (Meridian)` §Budgets row 1, ≤ 450 000 B
        // gzip) was therefore gating an artifact nobody downloads. Measured on
        // this branch: 443 585 B unminified against 244 546 B minified, so the
        // budget was reading within 2 % of its ceiling on bytes the shipped app
        // does not have.
        //
        // Source maps stay `hidden` above, so a stack trace is still resolvable
        // by anyone holding the map and the bundle still carries no
        // `sourceMappingURL` for anyone who is not.
        minify: "esbuild",
        // `.vite/manifest.json` — the chunk graph Rollup already computed to
        // produce the chunks, written out on request. It carries `isEntry`,
        // the STATIC `imports` of every chunk, its `dynamicImports`, its `css`,
        // and its `assets`, which is exactly the initial-versus-lazy split
        // `Spec-023 §Console Design (Meridian)` §Budgets row 1 bounds ("≤ 450 kB
        // gzip, excluding lazy chunks"). `scripts/budget/measure-bundle.mts`
        // reads it instead of re-deriving the graph from the emitted text: the
        // bundler that made the split is the authority on it, and a second
        // reader over minified output is a heuristic that can only ever agree
        // with the manifest or be wrong.
        //
        // The manifest is build metadata, not a shipped asset — the renderer
        // never fetches it (nothing links it, and the protocol handler serves
        // only what `index.html` reaches) — so the budget harness excludes the
        // whole `.vite/` directory from its inventory rather than classifying
        // its own input.
        manifest: true,
        rollupOptions: {
          input: {
            index: "src/renderer/index.html",
          },
          // The second half of the fixture gate, and without it the first half
          // does not finish the job it claims to.
          //
          // The `define` above folds every fixture CALL SITE to nothing, which is
          // what drops `createFixtureBridge`, `ScenarioSelection`, and the pane
          // harness. It does not remove the static IMPORT edges that reach the
          // corpus — `BridgeProvider.tsx` imports the fixture bridge, the manifest,
          // and a scenario id at module scope — and a module the graph still
          // reaches keeps every top-level statement the bundler cannot prove pure.
          // A scenario is built by calling builders at module scope, so none of
          // those statements is provably pure and all of them were retained.
          //
          // Measured on the release artifact before this option: `"Browsing agent"`,
          // `artifact-capture-staging-header`, `scenarios:`, and
          // `fixtureServedOperations` were all present in `index-*.js`, against a
          // spec sentence that says a release bundle carries none of it.
          //
          // So the corpus declares what is true of it: those three directories hold
          // pure data and pure builders and run nothing at import time. With that
          // declared, the unreferenced bindings go and the modules go with them.
          // The claim is path-scoped rather than a package-wide `sideEffects: false`,
          // which would also invite the bundler to drop the token-sheet install and
          // the tripwire registrations that legitimately run at module scope.
          //
          // It is not mode-scoped, and does not need to be: in a fixture build the
          // corpus is referenced, so nothing about it is unused and nothing is
          // dropped. `test/console/budget/release-absence.test.ts` gates the outcome
          // on the built artifact, with a planted negative control.
          treeshake: {
            moduleSideEffects: (moduleId: string) => !isFixtureCorpusModule(moduleId),
          },
        },
      },
    },
  };
});

export default electronViteConfig;
