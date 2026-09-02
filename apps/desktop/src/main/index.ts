// Electron main-process entrypoint.
//
// Plan-023 Phase 1 (T-023p-1-3) substrate: single-instance lock + main window.
// Plan-023 Phase 1B (T-023p-1B-1) adds the renderer scheme registration and the
// bundle handler. Tier 8 remainder layers Sentry init, daemon supervisor
// (`utilityProcess.fork`), the `sidekicks://` DEEP-LINK handler (a different
// scheme from the renderer's — that one carries invite URLs), auto-updater,
// crash reporter, and second-instance focus handling against this same surface.
//
// Startup order is load-bearing and is asserted by `startup-order.test.ts`:
//
//   module top level ......... registerRendererScheme()      (before app.ready)
//   inside whenReady() ....... installRendererProtocol(...)  (before any window)
//                              installApplicationMenu()
//                              createMainWindow()
//
// A scheme registered after ready is refused by Electron, and a window created
// before the handler is installed would load against an unhandled scheme.
// Plan-023 Phase 3's T-023r-3-4 COMPOSES this order behind the crash reporter
// and the single-instance lock; it re-authors none of it. The crash reporter
// takes the top-level slot immediately AFTER `registerRendererScheme()` — the
// one named exception to its own crash-first rule (T-023r-3-2), because
// Electron pins the registration ahead of ready and the call touches no
// network, no file, and no crash-relevant state. `startup-order.test.ts`
// therefore asserts the two ORDERINGS (scheme before the first `whenReady()`,
// handler before the first `BrowserWindow`) and deliberately does NOT assert
// that this module imports `protocol.ts` first, which Phase 3 would break.
//
// See `docs/plans/023-desktop-shell-and-renderer.md §Tier 1 Partial PR Sequence`
// (Phase 1, the main-entrypoint bullet; Phase 1B, the `index.ts` bullet).

import path from "node:path";

import { app, type BrowserWindow } from "electron";
import { installApplicationMenu } from "./menu.js";
import { startGcProbe } from "./probes/gc-probe.js";
import { installReadinessBreadcrumbs, runSmokeProbe } from "./probes/smoke-probe.js";
import { installRendererProtocol, registerRendererScheme } from "./protocol.js";
import { createMainWindow } from "./window.js";
import { registerSidecarLifecycle } from "./sidecar-lifecycle.js";

// The `electron-vite` output layout puts the main bundle at `out/main/index.js`
// and the renderer tree at `out/renderer/` (see `electron.vite.config.ts`
// per-target `outDir`), so the renderer root is this module's sibling directory.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// Plan-023 I-023-11. This runs at module evaluation, which is strictly before
// `app.ready` fires — Electron refuses `registerSchemesAsPrivileged` after ready,
// and a scheme that is not `standard` has no origin and therefore no IndexedDB
// and no `localStorage`, which is where the console persists layout, scroll
// position, selection, pins, and expansion sets — UI state ONLY. Drafts are
// deliberately NOT in that set: composer text, form values, paths, and code a
// participant has typed and not sent live in their window's in-memory store for
// that window's lifetime and are gone when it closes, because participant-
// authored content's only durable homes are the daemon's encrypted, PII-mapped
// stores (`Spec-023 §Console Design (Meridian)` §Persistence on the renderer
// scheme; Spec-022).
registerRendererScheme();

// Compile-time-static flag. `electron-vite build --mode=smoke` substitutes
// this with the literal `true`; the default `electron-vite build` substitutes
// it with the literal `false` (see `apps/desktop/electron.vite.config.ts`
// `define` block). This is the production-safety mechanism — in release
// bundles the value resolves to `false`, the entire smoke-probe branch
// below short-circuits to dead code, and Rollup's tree-shaker eliminates
// it from `out/main/index.js`. Empirically verifiable: grep the release
// bundle for `SIDEKICKS_SMOKE_PROBE`, `executeJavaScript`, or `about:blank`
// — all return zero matches (see commit message for the proof).
declare const __SIDEKICKS_SMOKE_BUILD__: boolean;

// Plan-023 §Risks And Blockers: without `requestSingleInstanceLock()`, a
// `sidekicks://invite/<token>` deep-link arriving at a second instance would
// race with the first instance's daemon state. The lock is the correct pattern
// even at Tier 1, before the deep-link handler ships at Tier 8 remainder.
const gotTheLock = app.requestSingleInstanceLock();

// The two probes live in `./probes/`, not here (Plan-023 Phase 1B).
//
// `runSmokeProbe` boots the window, waits for the REAL renderer bundle's
// `did-finish-load`, reads the `Spec-023 §Security Hardening Baseline` runtime
// invariants plus the Phase-1B origin properties out of the renderer, fetches
// the served `index.html` to read back its CSP header, prints one
// `[SIDEKICKS_SMOKE_PROBE]`-tagged JSON line, and exits.
// `startGcProbe` drives the ADR-024 window-reachability loop and prints one
// `[SIDEKICKS_GC_PROBE]`-tagged line. Each module's header carries its own
// rationale; what belongs HERE is the startup order and the gates.
//
// Both gates are two-condition and the outer condition is the SAME
// compile-time-static identifier. `electron-vite build --mode=smoke`
// substitutes `__SIDEKICKS_SMOKE_BUILD__` with the literal `true`; a default
// `electron-vite build` substitutes the literal `false`, Rollup collapses
// `if (false && …)`, and — because the probe modules are then referenced by
// nothing and declare no top-level side effects — drops both modules from
// `out/main/index.js` entirely. Empirically: after a release build,
// `grep -c SIDEKICKS_SMOKE_PROBE out/main/index.js` and
// `grep -c executeJavaScript out/main/index.js` both return 0, and
// `about:blank` is absent from both bundles now that the blank-document arm is
// retired. The inner condition is a per-invocation runtime env-var opt-in, so
// even a smoke bundle never auto-runs a probe.
//
// "No test machinery in production binaries" is not a verbatim Spec-023 bullet
// but a derived invariant from `Spec-023 §Trust Stance` (renderer-untrusted)
// plus §Pitfalls To Avoid ("`nodeIntegration: true` or `sandbox: false` in any
// window must be treated as a build-time error"): a release binary must not
// embed a path that weakens those guarantees, and a probe calling
// `executeJavaScript` against the renderer is exactly such a path.

// Module-scope handle for the BrowserWindow. Defensive consistency
// with the canonical Electron main-process retention pattern. Per
// ADR-024 §Antithesis, the load-bearing reachability mechanism is
// Electron's native-side `BaseWindow::self_ref_`
// (`v8::Global<v8::Value>` strong-rooted from `InitWith` to native
// destruction) — a freshly constructed `BrowserWindow` is anchored
// on the V8 root set without any user-side help. Keeping
// `let mainWindow` is zero-cost insurance against future Electron
// releases shifting `self_ref_` semantics (asymmetric risk: one
// identifier vs. silent regression on a future Electron release).
//
// The `no-unused-vars` disable is intentional — eslint observes that
// nothing reads the variable, but its role is being-assigned for
// defensive pattern consistency, not being-read.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let mainWindow: BrowserWindow | null = null;

if (!gotTheLock) {
  app.quit();
} else {
  // Plan-001 §Cross-Plan Obligations CP-001-1 (Plan-024 §I-024-4):
  // sidecar-cleanup handler MUST register BEFORE any other
  // `app.on('will-quit', ...)` registration. Under Electron's
  // EventEmitter semantics, listener invocation order equals
  // registration order — late registration would let downstream
  // handlers close resources the drain depends on, orphaning active
  // PTY children to the global console (the `microsoft/node-pty#904`
  // SIGABRT-on-exit failure mode).
  //
  // The PtyHost getter currently returns `null` (no daemon PtyHost is
  // provisioned at Tier 1) — the registration still runs at position 0
  // unconditionally so the FIFO-ordering invariant holds the moment a
  // PtyHost lands in a later Tier. See `sidecar-lifecycle.ts`'s
  // `PtyHostGetter` rustdoc for the lazy-getter rationale.
  registerSidecarLifecycle(app, () => null);

  app
    .whenReady()
    .then(() => {
      // BEFORE any window: a `BrowserWindow` constructed ahead of the handler
      // could begin a load against an unhandled scheme.
      installRendererProtocol(RENDERER_ROOT);
      installApplicationMenu();

      // Production-safety: the OUTER condition is the compile-time-static
      // gate (Vite substitutes `false` in release bundles → Rollup
      // eliminates the whole branch). The INNER condition is the runtime
      // env-var opt-in so the probe never auto-runs even in a smoke
      // bundle without explicit opt-in. Both must hold for the probe
      // to execute.
      const smokeProbeRequested =
        __SIDEKICKS_SMOKE_BUILD__ && process.env["SIDEKICKS_SMOKE_PROBE"] === "1";

      // Sampled before the factory call, not after it: the window this measures
      // is the load's, and `createMainWindow` starts that load.
      const probeStartedAt = Date.now();

      // `did-finish-load` is registered through `beforeLoad` rather than on the
      // returned window. The load starts inside the factory, so a listener
      // attached afterwards is on time only because Electron happens to emit on
      // a later tick — a property of the runtime, not of this code. See
      // `WindowLoadOptions`.
      const browserWindow = createMainWindow({
        beforeLoad: (window) => {
          if (smokeProbeRequested) {
            // Registered here, ahead of the load, so a boot that never reaches
            // `did-finish-load` still says WHERE it stopped. The breadcrumb at
            // the top of the callback below is what separates "never got here"
            // from "got here and the probe round trip hung" — without it the
            // two produce the identical observable, no probe line at all.
            const traceReadiness = installReadinessBreadcrumbs(window, probeStartedAt);
            window.webContents.once("did-finish-load", () => {
              traceReadiness("did-finish-load");
              const windowMs = Date.now() - probeStartedAt;
              void runSmokeProbe(window, windowMs);
            });
          }
        },
      });
      mainWindow = browserWindow;
      browserWindow.on("closed", () => {
        mainWindow = null;
      });

      // The GC probe owns its own listener registration and its own deferral
      // (see `./probes/gc-probe.ts#startGcProbe`), so nothing scheduled here
      // closes over `browserWindow` and roots the window the probe measures.
      if (
        !smokeProbeRequested &&
        __SIDEKICKS_SMOKE_BUILD__ &&
        process.env["SIDEKICKS_GC_PROBE"] === "1"
      ) {
        startGcProbe(app);
      }
    })
    .catch((err: unknown) => {
      // Tier 1 substrate: structured logging routes through Sentry main at
      // Tier 8 remainder. Until then, surface startup failures on stderr.
      console.error("[ai-sidekicks/desktop] startup failed:", err);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    // Quit on all platforms at Tier 1; macOS-specific dock-keep-alive behavior
    // wires in at Tier 8 remainder once the full app lifecycle is wired.
    app.quit();
  });
}
