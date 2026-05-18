// `createMainWindow()` — `BrowserWindow` factory for the Electron main process.
//
// The `webPreferences` block below is the verbatim Spec-023 §Security Hardening
// Baseline lock-in (lines 104-116 of docs/specs/023-desktop-shell-and-renderer.md).
// Every value is asserted at build time by `apps/desktop/build/assert-webprefs.ts`;
// any drift fails `pnpm build` before the bundle is shipped. The build-time
// assertion is the enforcement mechanism for Plan-023 §Done Checklist line 356
// and Spec-023 §Anti-Patterns (lines 579-580: `nodeIntegration: true` or
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
// Preload path: resolved relative to `__dirname` so the factory works under
// the `electron-vite build` output layout (`out/main/index.js` →
// `out/preload/index.js`). The preload file itself is authored at T-023p-1-4.

import { BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `__dirname` is not defined in ESM; reconstruct from `import.meta.url`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Forward-declared path: the preload bundle ships at T-023p-1-4 to
// `out/preload/index.js`. From `out/main/index.js`, `../preload/index.js`
// resolves correctly. `path.join` (absolute via `__dirname`) satisfies
// the Spec-023 baseline requirement that `preload` be an absolute path.
const PRELOAD_PATH = path.join(__dirname, "../preload/index.js");

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
