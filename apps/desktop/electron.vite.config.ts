// electron-vite v5 configuration — three build targets (main / preload / renderer).
//
// Per docs/plans/023-desktop-shell-and-renderer.md §Implementation Steps step 3:
// renderer loads via custom protocol (not file://); sourcemaps are emitted as
// "hidden" so they are available for Sentry upload but NOT referenced from the
// shipped bundle. Source-code protection (bytecodePlugin) is deferred to the
// Tier 8 remainder per Phase 1 partial scope.
//
// At this task (T-023p-1-2) the three target source trees (src/main/, src/preload/,
// src/renderer/) do not yet exist. T-023p-1-3 / T-023p-1-4 / T-023p-1-5 author the
// entry points and any direct invocation of `electron-vite build` will fail with a
// "no input" error until those land. The package build script remains `tsc -b`
// until T-023p-1-3 swaps it.

import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          index: "src/main/index.ts",
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
});
