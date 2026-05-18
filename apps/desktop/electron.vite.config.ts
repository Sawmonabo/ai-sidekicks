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
//              has `"type": "module"`; Electron 41 supports ESM main process
//              (since v28). Keeping main as ESM matches the rest of the
//              monorepo's module system. `app.requestSingleInstanceLock()`
//              and `app.exit()` work identically in ESM context (empirically
//              verified at T-023p-1-7).
//
//   • preload: `format: "cjs"` (entryFileNames: index.cjs). Electron's
//              sandboxed preload runtime (`sandbox: true`, locked by
//              `src/main/window.ts`) ONLY supports CommonJS — verified
//              empirically with Electron 41.6.1: an ESM preload fails to
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
//   The production-safety guarantee is empirical: after `pnpm build`,
//   `grep -c SIDEKICKS_SMOKE_PROBE out/main/index.js`,
//   `grep -c executeJavaScript out/main/index.js`, and
//   `grep -c "about:blank" out/main/index.js` all return 0 — proving
//   the probe body never reaches the release bundle.

import { defineConfig } from "electron-vite";

const ELECTRON_EXTERNAL: readonly (string | RegExp)[] = ["electron", /^electron\/.+/];

export default defineConfig(({ mode }) => {
  // `electron-vite build --mode=smoke` produces a smoke-test artifact that
  // ships the probe; the default `electron-vite build` produces a release
  // artifact that tree-shakes the probe entirely. See header comment.
  const isSmokeBuild = mode === "smoke";

  return {
    main: {
      // Vite's `define` is a textual substitution before parsing. The shape
      // `JSON.stringify(boolean)` produces the string `"true"` / `"false"`,
      // which Vite injects as the boolean literal at the use site. Rollup's
      // dead-code elimination then collapses `if (false && expr)` to no
      // emitted code, dropping the probe body from the release bundle.
      define: {
        __SIDEKICKS_SMOKE_BUILD__: JSON.stringify(isSmokeBuild),
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
      build: {
        outDir: "out/renderer",
        sourcemap: "hidden",
        rollupOptions: {
          input: {
            index: "src/renderer/index.html",
          },
        },
      },
    },
  };
});
