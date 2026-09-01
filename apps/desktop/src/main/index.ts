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
import { queryObjects } from "node:v8";
import { setTimeout as wait } from "node:timers/promises";

import { app, BrowserWindow, net } from "electron";
import { installApplicationMenu } from "./menu.js";
import { installRendererProtocol, registerRendererScheme, RENDERER_INDEX_URL } from "./protocol.js";
import { createMainWindow } from "./window.js";
import { registerSidecarLifecycle } from "./sidecar-lifecycle.js";

// The `electron-vite` output layout puts the main bundle at `out/main/index.js`
// and the renderer tree at `out/renderer/` (see `electron.vite.config.ts`
// per-target `outDir`), so the renderer root is this module's sibling directory.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// Plan-023 I-023-11. This runs at module evaluation, which is strictly before
// `app.ready` fires — Electron refuses `registerSchemesAsPrivileged` after ready,
// and a scheme that is not `standard` has no origin and therefore no IndexedDB
// and no `localStorage`, which is where the console persists layouts, drafts,
// and pins (`Spec-023 §Console Design (Meridian)` §Persistence on the renderer
// scheme).
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

// Plan-023 Phase 1 T-023p-1-7 smoke-probe affordance, moved onto the real
// bundle at Phase 1B (T-023p-1B-2).
//
// When the bundle is built with `electron-vite build --mode=smoke` AND the
// runtime env-var `SIDEKICKS_SMOKE_PROBE=1` is set, the main process boots the
// window, waits for the REAL renderer bundle's `did-finish-load`, queries the
// renderer for the Spec-023 §Security Hardening Baseline runtime invariants
// (sidekicks defined; require / process / global all undefined — the full
// `Spec-023 §Acceptance Criteria` set) plus the Phase-1B origin properties
// (`sidekicks-renderer:` scheme, `app` host, IndexedDB present, a
// `localStorage` round-trip, and a mounted React tree), fetches the served
// `index.html` from the main process to read back its CSP header, prints a
// single-line JSON probe to stdout tagged with `[SIDEKICKS_SMOKE_PROBE]`, and
// exits. The smoke test at `apps/desktop/test/launch.smoke.test.ts` parses that
// line.
//
// The `about:blank` arm is RETIRED. It existed because the Tier-1
// `createMainWindow()` deliberately loaded nothing, so the only way to make the
// preload execute was to load a blank document — which proved a window existed
// and nothing about the bundle. Now that the factory loads the bundle over the
// renderer scheme, the probe proves the bundle is actually served. The
// `__SIDEKICKS_SMOKE_BUILD__` define gates only the probe's ASSERTIONS; the load
// itself is the production path.
//
// Why this branch lives in the main entrypoint instead of the test:
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
//   both return 0, and `about:blank` is absent from BOTH bundles now that the
//   arm is retired — the smoke test asserts that against the smoke bundle,
//   which is the one where the probe body actually survives. The probe code
//   (the `[SIDEKICKS_SMOKE_PROBE]` tag and the
//   `webContents.executeJavaScript(...)` call) is physically absent from the
//   shipped bundle. The "no test
//   machinery in production binaries" property is not a verbatim Spec-023
//   bullet but a derived invariant from `Spec-023 §Trust Stance` (renderer-
//   untrusted) + §Pitfalls To Avoid ("`nodeIntegration:
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

/**
 * The smoke probe body (Plan-023 T-023p-1B-2), run once the REAL renderer
 * bundle has finished loading.
 *
 * Two readings, both taken from the trusted side:
 *
 *   1. `executeJavaScript` against the renderer, asserting the
 *      `Spec-023 §Security Hardening Baseline` runtime invariants (bridge
 *      present; `require` / `process` / `global` all absent) AND the origin
 *      properties Phase 1B's privileged scheme is what makes true — the
 *      `sidekicks-renderer:` protocol, the `app` host, a live `indexedDB`, a
 *      `localStorage` round-trip, and a mounted React tree. A scheme registered
 *      without `standard: true` has no origin, so the storage readings would be
 *      the first thing to fail (Plan-023 I-023-11).
 *   2. `net.fetch` from the main process against the served `index.html`, to
 *      read back the `Content-Security-Policy` header the handler attaches. The
 *      header is the policy's ONLY carrier — the shipped `index.html` has no
 *      meta tag — so a header that silently stopped being attached would
 *      otherwise be invisible to every automated check.
 *
 * Both readings ride ONE stdout line so the test parses one JSON object.
 *
 * The renderer expression resolves a promise rather than reading `#root`
 * synchronously: React 19's `createRoot().render()` schedules the initial mount
 * through the Scheduler's `MessageChannel` task, which is not guaranteed to have
 * flushed by `did-finish-load`. The wait is bounded and its timer is cleared on
 * every exit path, so an unmounted tree fails the assertion instead of hanging
 * the probe.
 */
async function runSmokeProbe(browserWindow: BrowserWindow, windowMs: number): Promise<void> {
  const rendererReadings = `
    (() => {
      const readLocalStorage = () => {
        try {
          const probeKey = "__sidekicks_smoke_probe__";
          window.localStorage.setItem(probeKey, "ok");
          const readBack = window.localStorage.getItem(probeKey);
          window.localStorage.removeItem(probeKey);
          return readBack === "ok";
        } catch {
          return false;
        }
      };
      const rootChildren = () =>
        new Promise((resolve) => {
          const deadline = Date.now() + 3000;
          const poll = () => {
            const rootElement = document.getElementById("root");
            const childCount = rootElement === null ? 0 : rootElement.childElementCount;
            if (childCount > 0 || Date.now() >= deadline) {
              resolve(childCount);
              return;
            }
            window.setTimeout(poll, 25);
          };
          poll();
        });
      return rootChildren().then((childCount) =>
        JSON.stringify({
          sidekicks: typeof window.sidekicks,
          require: typeof window.require,
          process: typeof window.process,
          global: typeof window.global,
          protocol: window.location.protocol,
          host: window.location.host,
          indexedDB: typeof window.indexedDB,
          localStorageRoundTrip: readLocalStorage(),
          rootChildren: childCount,
        }),
      );
    })()
  `;

  let serialisedReadings: string;
  try {
    serialisedReadings = (await browserWindow.webContents.executeJavaScript(
      rendererReadings,
    )) as string;
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} executeJavaScript failed:`, error);
    app.exit(2);
    return;
  }

  let contentSecurityPolicy: string | null;
  try {
    const indexResponse = await net.fetch(RENDERER_INDEX_URL);
    contentSecurityPolicy = indexResponse.headers.get("content-security-policy");
    // Release the streamed body rather than leaving the file handle open for
    // the (short) remainder of the process's life.
    await indexResponse.body?.cancel();
  } catch (error: unknown) {
    console.error(`${SMOKE_PROBE_TAG} index fetch failed:`, error);
    app.exit(4);
    return;
  }

  console.log(
    `${SMOKE_PROBE_TAG} ${JSON.stringify({
      ok: true,
      windowMs,
      probe: JSON.parse(serialisedReadings) as Record<string, unknown>,
      contentSecurityPolicy,
    })}`,
  );
  app.exit(0);
}

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
        const probeStartedAt = Date.now();
        browserWindow.webContents.once("did-finish-load", () => {
          const windowMs = Date.now() - probeStartedAt;
          void runSmokeProbe(browserWindow, windowMs);
        });
      } else if (__SIDEKICKS_SMOKE_BUILD__ && process.env["SIDEKICKS_GC_PROBE"] === "1") {
        // Register a probe-scoped `window-all-closed` listener. The
        // module-level `app.quit()` handler below registers at module-
        // eval time (synchronously, before `whenReady` resolves), so
        // this listener is invoked second. That is fine: `EventEmitter`
        // invokes every registered listener synchronously within a
        // single `emit()` call, so the flag is set during the same
        // `emit()` pass as `app.quit()`'s synchronous return — Electron's
        // `app.quit` only schedules the quit sequence (`before-quit` /
        // `will-quit` / `quit`) on later ticks, so it cannot pre-empt
        // the second listener. The flag is read in `runGcProbe`'s JSON
        // payload and asserted false by
        // `apps/desktop/test/lifecycle.gc.test.ts` — a true value means
        // the BrowserWindow lifecycle invariant (per ADR-024) broke
        // mid-probe.
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
