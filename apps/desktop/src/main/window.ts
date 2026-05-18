// `createMainWindow()` — `BrowserWindow` factory for the Electron main process.
//
// The `webPreferences` block below is the verbatim Spec-023 §Security Hardening
// Baseline lock-in (lines 104-116 of docs/specs/023-desktop-shell-and-renderer.md).
// Every value is asserted at build time by `apps/desktop/build/assert-webprefs.ts`;
// any drift fails `pnpm build` before the bundle is shipped. The build-time
// assertion is the enforcement mechanism for Plan-023 §Done Checklist line 356
// and Spec-023 §Pitfalls To Avoid (line 579: `nodeIntegration: true` or
// `sandbox: false` MUST be a build-time error).
//
// Tier 1 carve-outs (per Plan-023 Phase 1 task T-023p-1-3):
//   - No custom-protocol load. Spec-023 + Plan-023 step 3 require "renderer
//     loads via custom protocol, not file://"; the protocol handler lands at
//     Tier 8 remainder. At Tier 1 we return the unloaded `BrowserWindow` —
//     the smoke test in T-023p-1-7 asserts only that the window appears and
//     `window.sidekicks` is defined; an unloaded `BrowserWindow` satisfies
//     both. The actual `loadURL('sidekicks://app/')` wires in at Tier 8.
//   - No Sentry init, no daemon supervisor, no deep-link handler. All those
//     land at Tier 8 remainder against the same `index.ts` surface.
//
// Preload path: resolved relative to `import.meta.dirname` so the factory
// works under the `electron-vite build` output layout (`out/main/index.js`
// → `out/preload/index.cjs`). The preload file itself is authored at
// T-023p-1-4. `import.meta.dirname` is available natively in Node 20.11+ /
// Electron 28+ (we target Electron 41 / Node 22 per ADR-022) and avoids
// the manual `fileURLToPath(import.meta.url)` reconstruction.
//
// Why `import.meta.dirname` and NOT a `__dirname` reconstruction:
//   At Plan-023 Phase 1 T-023p-1-7 the build pipeline swapped from `tsc -b`
//   to `electron-vite build` (electron-vite v5). electron-vite's `esmShim`
//   plugin (chunks/lib-q6ns0vZr.js line 812:
//   `const CJSShim = supportImportMetaPaths() ? CJSShim_node_20_11 : CJSShim_normal;`)
//   auto-injects a CommonJS shim into ESM-target bundles whenever it
//   detects a `__filename` / `__dirname` / `require(` token in user code
//   (lines 786 + 818-819: `CJSyntaxRe = /__filename|__dirname|require\(|require\.resolve\(/`
//   tested in `renderChunk`). The shim variant is gated on
//   `supportImportMetaPaths()` (lines 137-139: `parseInt(majorVer) >= 30`,
//   reading the bundled Electron major version). We target Electron 41
//   (ADR-022), so the active shim is `CJSShim_node_20_11` (lines 796-802):
//
//     const __filename = import.meta.filename;
//     const __dirname  = import.meta.dirname;
//     const require    = __cjs_mod__.createRequire(import.meta.url);
//
//   On Electron < 30 the plugin falls back to `CJSShim_normal` (lines
//   787-795), which derives `__filename` from `fileURLToPath(import.meta.url)`
//   instead — equivalent semantics, slightly older Node target.
//
//   In either branch, if THIS file ALSO declared `const __filename = …`
//   at module scope, the two would collide as `SyntaxError: Identifier
//   '__filename' has already been declared` at app boot (verified
//   empirically — see Phase 1 T-023p-1-7 commit body). Sticking to
//   `import.meta.dirname` directly keeps the source bundler-agnostic and
//   avoids triggering the shim's `CJSyntaxRe` detection altogether.
//
// Why `.cjs` (not `.js`) for the preload filename:
//   Electron's sandboxed preload runtime (`sandbox: true` below) ONLY
//   supports CommonJS — verified empirically with Electron 41.6.1: an
//   ESM preload fails to register with `"SyntaxError: Cannot use import
//   statement outside a module"`. The explicit `.cjs` extension overrides
//   the package-level `"type": "module"` so Node loads the file as CJS
//   regardless of the package field. See `electron.vite.config.ts` header.

import { BrowserWindow } from "electron";
import path from "node:path";

// Forward-declared path: the preload bundle ships at T-023p-1-4 to
// `out/preload/index.cjs`. From `out/main/index.js`, `../preload/index.cjs`
// resolves correctly. `path.join` (absolute via `import.meta.dirname`)
// satisfies the Spec-023 baseline requirement that `preload` be an
// absolute path.
const PRELOAD_PATH = path.join(import.meta.dirname, "../preload/index.cjs");

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      preload: PRELOAD_PATH,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  // TODO(T-023p-1-5 / Tier 8 remainder): wire the `sidekicks://` custom-protocol
  // load here. Plan-023 §Implementation Steps step 3 specifies the renderer must
  // load via custom protocol, not `file://`. At Tier 1 the protocol handler
  // does not exist yet; the smoke test (T-023p-1-7) only asserts window
  // appearance + bridge-object presence, both of which an unloaded
  // `BrowserWindow` satisfies. The actual `window.loadURL(...)` lands at
  // Tier 8 remainder against this same surface.

  return window;
}
