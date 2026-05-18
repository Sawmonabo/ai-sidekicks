// Electron main-process entrypoint.
//
// Plan-023 Phase 1 (T-023p-1-3) substrate: single-instance lock + main window.
// Tier 8 remainder layers Sentry init, daemon supervisor (`utilityProcess.fork`),
// custom-protocol handler (`sidekicks://`), deep-link routing, auto-updater,
// crash reporter, and second-instance focus handling against this same surface.
//
// See docs/plans/023-desktop-shell-and-renderer.md §Tier 1 Partial PR Sequence > Phase 1 line 257.

import { queryObjects } from "node:v8";
import { setTimeout as wait } from "node:timers/promises";

import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";

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

// Plan-023 Phase 1 T-023p-1-7 smoke-probe affordance.
//
// When the bundle is built with `electron-vite build --mode=smoke` AND the
// runtime env-var `SIDEKICKS_SMOKE_PROBE=1` is set, the main process boots
// the window, loads `about:blank` into the renderer (so the preload script
// actually executes and registers `window.sidekicks`), queries the
// renderer for the Spec-023 §Security Hardening Baseline runtime invariants
// (sidekicks defined; require / process / global all undefined — the full
// Spec-023 §Acceptance Criteria line 602 set), prints a single-line JSON
// probe to stdout tagged with `[SIDEKICKS_SMOKE_PROBE]`, and exits. The
// smoke test at `apps/desktop/test/launch.smoke.test.ts` parses that line.
//
// Why this branch lives in the main entrypoint instead of the test:
//   • The Tier 1 `createMainWindow()` factory deliberately does NOT call
//     `window.loadURL(...)` — the `sidekicks://` custom-protocol load is
//     a Tier 8 remainder surface (see apps/desktop/src/main/window.ts TODO
//     line ~93). But preload scripts only execute when the renderer process
//     loads a document; an unloaded BrowserWindow never registers
//     `window.sidekicks`. The smoke branch loads `about:blank` to trigger
//     preload execution — this is the minimum content the renderer needs
//     to bootstrap, and it stays scoped to smoke-mode only so it does NOT
//     introduce a Tier-8-style protocol load into the default startup path.
//   • External CDP / chrome-remote-interface attachment was rejected at
//     Tier 1 (too heavyweight; new dep family). Renderer console.log
//     parsing was rejected because the renderer source is renderer-untrusted
//     per Spec-023 §Trust Stance — adding a probe there couples a non-test
//     surface to the test mechanism. Main-process `executeJavaScript`
//     keeps the test mechanism in the trusted boundary.
//
// Production-safety mechanism — compile-time dead-code elimination:
//
//   The OUTER condition `__SIDEKICKS_SMOKE_BUILD__` is a compile-time-static
//   identifier substituted by Vite's `define` (see
//   `apps/desktop/electron.vite.config.ts` `define` block). In a default
//   `electron-vite build` (release artifact), Vite textually replaces the
//   identifier with the literal `false`; Rollup's dead-code elimination then
//   collapses `if (false && expr) { ... }` and strips the ENTIRE probe body
//   from the emitted `out/main/index.js`. In `electron-vite build --mode=smoke`,
//   the identifier substitutes to `true` and the probe body ships in the
//   smoke bundle. The runtime env-var check on the INNER side
//   (`process.env["SIDEKICKS_SMOKE_PROBE"] === "1"`) remains as
//   defense-in-depth: even in a smoke bundle, the probe must be explicitly
//   opted-in per invocation.
//
//   Empirical proof of the production-safety guarantee — after a release
//   build (`pnpm --filter @ai-sidekicks/desktop build`), running:
//     grep -c SIDEKICKS_SMOKE_PROBE out/main/index.js
//     grep -c executeJavaScript     out/main/index.js
//     grep -c "about:blank"         out/main/index.js
//   all return 0. The probe code (the `[SIDEKICKS_SMOKE_PROBE]` tag, the
//   `webContents.executeJavaScript(...)` call, and the `about:blank` URL
//   string) is physically absent from the shipped bundle. The "no test
//   machinery in production binaries" property is not a verbatim Spec-023
//   bullet but a derived invariant from Spec-023 §Trust Stance (renderer-
//   untrusted; line 82) + §Pitfalls To Avoid (line 579: "`nodeIntegration:
//   true` or `sandbox: false` in any window must be treated as a build-
//   time error") — release binaries must not embed code paths that
//   weaken those guarantees, and a test-probe path that calls
//   `executeJavaScript` against the renderer is exactly such weakening.
const SMOKE_PROBE_TAG = "[SIDEKICKS_SMOKE_PROBE]";
const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";

// Plan-023 lifecycle-reachability probe. When the bundle is built with
// `electron-vite build --mode=smoke` AND `SIDEKICKS_GC_PROBE=1`, this
// function drives K iterations of GC pressure and samples
// `v8.queryObjects(BrowserWindow)` after each cycle. It emits a single
// summary line tagged `[SIDEKICKS_GC_PROBE]` that the regression test
// at `apps/desktop/test/lifecycle.gc.test.ts` parses.
//
// The probe asserts the observable lifecycle contract (window stays
// reachable across the `.then(...)` callback unwind; `window-all-closed`
// does not fire mid-loop). Per ADR-024 §Antithesis, the load-bearing
// reachability mechanism is Electron's native-side `BaseWindow::self_ref_`
// (`v8::Global<v8::Value>` strong-rooted from `InitWith` to native
// destruction) — the user-side module-scope `let mainWindow` is defensive
// consistency with the canonical community pattern, not the GC anchor.
// The probe therefore serves as a future-regression guard against
// Electron internals shifting `self_ref_` semantics, not as proof that
// removing `let mainWindow` would break a fix-state.
//
// Module-scope so the `setImmediate` callback's closure does not
// capture the `.then(...)` arrow's local `browserWindow` const. A
// closure that captured `browserWindow` would root the window for the
// lifetime of the scheduled task — narrowing the probe's signal scope
// to native-only retention regressions, which is the discriminating
// behavior we want.
//
// Compile-time-static gate is shared with the smoke probe below: in
// release builds Vite substitutes `__SIDEKICKS_SMOKE_BUILD__` to
// `false` and Rollup strips this function body alongside the probe
// branch.
let windowAllClosedFiredDuringProbe = false;

async function runGcProbe(): Promise<void> {
  const iterations = 20;
  const allocBytes = 8 * 1024 * 1024;
  const counts: number[] = [];
  const queryObjectsAvailable = typeof queryObjects === "function";
  const globalGcAvailable = typeof globalThis.gc === "function";

  for (let i = 0; i < iterations; i++) {
    if (globalGcAvailable) {
      globalThis.gc?.();
      globalThis.gc?.();
    }
    const throwaway = new Uint8Array(allocBytes);
    throwaway[0] = i & 0xff;
    if (globalGcAvailable) {
      globalThis.gc?.();
      globalThis.gc?.();
    }
    await wait(50);
    counts.push(queryObjects(BrowserWindow, { format: "count" }));
  }

  const min = counts.length > 0 ? Math.min(...counts) : 0;
  const max = counts.length > 0 ? Math.max(...counts) : 0;

  console.log(
    `${GC_PROBE_TAG} ${JSON.stringify({
      ok: true,
      queryObjectsAvailable,
      globalGcAvailable,
      iterations,
      counts,
      min,
      max,
      allClosedFired: windowAllClosedFiredDuringProbe,
    })}`,
  );
  app.exit(0);
}

// Module-scope reference holds the BrowserWindow alive after the
// `whenReady().then(...)` callback returns. Without this, V8 may
// garbage-collect the only live handle once the callback's stack frame
// unwinds, at which point Electron fires `window-all-closed` and the
// app quits unexpectedly. The smoke-probe path masks this because
// `app.exit(0)` runs before V8 reaches an idle GC. This is the
// canonical Electron main-process retention pattern. The
// `no-unused-vars` disable is load-bearing — the variable's "use" is
// V8 reachability, which the linter cannot observe.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let mainWindow: BrowserWindow | null = null;

if (!gotTheLock) {
  app.quit();
} else {
  app
    .whenReady()
    .then(() => {
      const browserWindow = createMainWindow();
      mainWindow = browserWindow;
      browserWindow.on("closed", () => {
        mainWindow = null;
      });

      // Production-safety: the OUTER condition is the compile-time-static
      // gate (Vite substitutes `false` in release bundles → Rollup
      // eliminates the whole branch). The INNER condition is the runtime
      // env-var opt-in so the probe never auto-runs even in a smoke
      // bundle without explicit opt-in. Both must hold for the probe
      // to execute.
      if (__SIDEKICKS_SMOKE_BUILD__ && process.env["SIDEKICKS_SMOKE_PROBE"] === "1") {
        const t0 = Date.now();
        browserWindow.webContents.once("did-finish-load", () => {
          const tWindow = Date.now() - t0;
          // Probe the renderer for the Spec-023 §Security Hardening Baseline
          // runtime invariants (sandbox: true + nodeIntegration: false +
          // contextIsolation: true should produce: `sidekicks` typeof
          // "object"; `require` / `process` / `global` all typeof
          // "undefined" — the full Spec-023 §Acceptance Criteria line 602
          // set). `JSON.stringify` is `executeJavaScript`'s required
          // serialization shape — `executeJavaScript` returns a thenable
          // resolving to the expression's value, which we then println-tag
          // on stdout.
          browserWindow.webContents
            .executeJavaScript(
              `JSON.stringify({
                sidekicks: typeof window.sidekicks,
                require: typeof window.require,
                process: typeof window.process,
                global: typeof window.global,
              })`,
            )
            .then((result: string) => {
              console.log(
                `${SMOKE_PROBE_TAG} ${JSON.stringify({
                  ok: true,
                  windowMs: tWindow,
                  probe: JSON.parse(result) as Record<string, string>,
                })}`,
              );
              app.exit(0);
            })
            .catch((err: unknown) => {
              console.error(`${SMOKE_PROBE_TAG} executeJavaScript failed:`, err);
              app.exit(2);
            });
        });
        // `about:blank` is the minimum URL Electron's renderer will load
        // without a registered protocol handler. It triggers preload-script
        // execution (and the `did-finish-load` event) without depending on
        // the Tier 8 `sidekicks://` handler.
        browserWindow.loadURL("about:blank").catch((err: unknown) => {
          console.error(`${SMOKE_PROBE_TAG} loadURL failed:`, err);
          app.exit(3);
        });
      } else if (__SIDEKICKS_SMOKE_BUILD__ && process.env["SIDEKICKS_GC_PROBE"] === "1") {
        // Register a probe-scoped `window-all-closed` listener BEFORE the
        // existing `app.quit()` handler below. `EventEmitter.on` invokes
        // listeners in registration order; the flag-setter runs first and
        // captures the event even if `app.quit()` would otherwise pre-empt
        // the probe's emit. The flag is read in `runGcProbe`'s JSON payload
        // and asserted false by `apps/desktop/test/lifecycle.gc.test.ts`
        // — a true value means the BrowserWindow lifecycle invariant (per
        // ADR-024) broke mid-probe.
        app.on("window-all-closed", () => {
          windowAllClosedFiredDuringProbe = true;
        });
        // Schedule on a fresh event-loop tick so the `.then(...)` arrow's
        // locals can unwind before `runGcProbe` samples the heap. The
        // arrow passed to `setImmediate` references only `runGcProbe`
        // (module-scope), so its closure does not capture `browserWindow`.
        setImmediate(() => {
          void runGcProbe();
        });
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
