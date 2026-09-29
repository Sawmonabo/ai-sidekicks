// Electron main-process entrypoint.
//
// Today this is the single-instance lock, the renderer scheme registration, the
// bundle handler, and the main window. Later work layers Sentry init, the
// daemon supervisor (`utilityProcess.fork`), the `sidekicks://` DEEP-LINK
// handler (a different scheme from the renderer's), the auto-updater, the crash
// reporter, and second-instance focus handling against this same surface.
//
// Startup order is load-bearing and is asserted by `startup-order.test.ts`:
//
//   module top level ......... registerRendererScheme()      (before app.ready)
//   inside whenReady() ....... installRendererProtocol(...)  (before any window)
//                              installApplicationMenu()
//                              createMainWindow()
//
// A scheme registered after ready is refused by Electron, and a window created
// before the handler is installed would load against an unhandled scheme. When
// the crash reporter lands it COMPOSES this order rather than re-authoring it,
// taking the top-level slot immediately AFTER `registerRendererScheme()` — the
// one named exception to its own crash-first rule, because Electron pins the
// registration ahead of ready and the call touches no network, no file, and no
// crash-relevant state. `startup-order.test.ts` therefore asserts the two
// ORDERINGS (scheme before the first `whenReady()`, handler before the first
// `BrowserWindow`) and deliberately does NOT assert that this module imports
// `protocol.ts` first, which the crash reporter would break.

import path from "node:path";

import { app } from "electron";
import { fixtureLaunchSwitches, type FixtureLaunch } from "@shared/fixture-launch.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";
import { createMainDiagnosticLog, reportUnwrittenDiagnostics } from "./services/diagnostic-log.js";
import { installApplicationMenu } from "./menu.js";
import { startGcProbe } from "./probes/gc-probe.js";
import { installReadinessBreadcrumbs, runSmokeProbe } from "./probes/smoke-probe.js";
import { installRendererProtocol, registerRendererScheme } from "./services/renderer-protocol.js";
import { createMainWindow } from "./windows/window.js";
import { installActivationPolicy } from "./windows/window-reveal.js";

// The `electron-vite` output layout puts the main bundle at `out/main/index.js`
// and the renderer tree at `out/renderer/` (see `electron.vite.config.ts`
// per-target `outDir`), so the renderer root is this module's sibling directory.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// This runs at module evaluation, which is strictly before `app.ready` fires —
// Electron refuses `registerSchemesAsPrivileged` after ready, and a scheme that
// is not `standard` has no origin and therefore no IndexedDB and no
// `localStorage`, which is where the console persists layout, scroll position,
// selection, pins, and expansion sets — UI state ONLY. Drafts are deliberately
// NOT in that set: composer text, form values, paths, and code a user has
// typed and not sent live in their window's in-memory store for that window's
// lifetime and are gone when it closes, because user-authored content's
// only durable homes are the daemon's encrypted, PII-mapped stores.
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

// The console's fixture gate, substituted for this target by the same `define`
// block: `true` in the development and fixtures builds, `false` in every other,
// the release build included.
declare const __FIXTURE_BUILD__: boolean;

/**
 * The fixture launch this command line asks for, checked, or `undefined` for a normal launch.
 *
 * A build without the catalog refuses `--fixture` rather than launching normally. The
 * `if`/`else` shape is what lets a release bundle fold to the refusal alone: the define
 * becomes `false`, the catalog check and its dynamic import go, and the scenarios with them.
 */
async function resolveFixtureLaunch(): Promise<FixtureLaunch | undefined> {
  const launch = parseFixtureLaunch(process.argv.slice(1));
  if (launch === undefined) {
    return undefined;
  }
  if (__FIXTURE_BUILD__) {
    await checkFixtureLaunchAgainstCatalog(launch);
    return launch;
  } else {
    throw new Error(
      "--fixture needs a development or fixtures build, and this build carries no scenarios",
    );
  }
}

// Without `requestSingleInstanceLock()`, a `sidekicks://` deep link arriving at a
// second instance would race with the first instance's daemon state. The lock is the
// correct pattern even before the deep-link handler ships.
const gotTheLock = app.requestSingleInstanceLock();

// The two probes live in `./probes/`, not here.
//
// `runSmokeProbe` boots the window, waits for the REAL renderer bundle's
// `did-finish-load`, reads the hardening invariants plus the renderer-scheme
// origin properties out of the renderer, fetches the served `index.html` to
// read back its CSP header, prints one `[SIDEKICKS_SMOKE_PROBE]`-tagged JSON
// line, and exits. `startGcProbe` drives the window-reachability loop and prints
// one `[SIDEKICKS_GC_PROBE]`-tagged line. Each module's header carries its own
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
// "No test machinery in production binaries" follows from the two rules this
// shell is built on: the renderer is untrusted, and a disabled sandbox or
// enabled node integration in any window is a build-time error. A release binary
// must not embed a path that weakens those guarantees, and a probe calling
// `executeJavaScript` against the renderer is exactly such a path.

if (!gotTheLock) {
  app.quit();
} else {
  app
    .whenReady()
    .then(async () => {
      // First, so a launch this build cannot play stops before anything is installed and
      // before any window exists.
      const fixtureLaunch = await resolveFixtureLaunch();

      // Test builds only, and only when the launching harness asked for it: the
      // macOS accessory activation policy has to be in place before the first
      // reveal could activate the application. A release bundle folds the call
      // to nothing. See `./window-reveal.ts`.
      installActivationPolicy(app);
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
      createMainWindow({
        // Empty for a normal launch. A fixture launch reaches the window as renderer
        // switches, which the preload reads once, before the page's first render.
        additionalArguments:
          fixtureLaunch === undefined ? [] : fixtureLaunchSwitches(fixtureLaunch),
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

      // The GC probe owns its own listener registration and its own deferral
      // (see `./probes/gc-probe.ts#startGcProbe`), so nothing scheduled here
      // closes over the window and roots the window the probe measures.
      if (
        !smokeProbeRequested &&
        __SIDEKICKS_SMOKE_BUILD__ &&
        process.env["SIDEKICKS_GC_PROBE"] === "1"
      ) {
        startGcProbe(app);
      }
    })
    .catch(async (startupFailure: unknown) => {
      // Two records, because they reach two different readers and neither covers the
      // other. stderr is what a developer running the binary sees; the JSONL log is
      // what survives a launch nobody was watching, which is the only kind a startup
      // failure usually is. Drained before the exit — a queued append does not
      // survive `app.exit`.
      //
      // And if the second record did not land, that goes to the first: the log never
      // throws at this handler, so an unread failure would leave a startup failure
      // recorded nowhere at all while the exit path behaved as though it were.
      console.error("[ai-sidekicks/desktop] startup failed:", startupFailure);
      try {
        const startupLog = createMainDiagnosticLog(app.getPath("logs"));
        startupLog.write({
          at: new Date().toISOString(),
          level: "error",
          source: "main/index",
          message: `startup failed: ${startupFailure instanceof Error ? startupFailure.message : String(startupFailure)}`,
        });
        await reportUnwrittenDiagnostics(startupLog, (message) => {
          console.error(message);
        });
      } catch (loggingFailure) {
        // The conditions that break a startup are the conditions that break the
        // record of one — a read-only home, a revoked profile directory, a full
        // disk — so this is the arm most likely to be taken on the launches this
        // whole block exists for. `app.getPath` throws when a path cannot be
        // resolved, and the directory has to be created before the first append.
        console.error(
          "[ai-sidekicks/desktop] the startup log could not be written:",
          loggingFailure,
        );
      } finally {
        // THE EXIT IS THE CONTRACT AND THE RECORD IS BEST-EFFORT, which is why it is
        // here rather than after the record. This handler is the terminal one on the
        // chain, so a rejection escaping it is an UNHANDLED one: the process dies
        // through Node's own path instead of Electron's and `app.quit`'s hooks never
        // run.
        app.exit(1);
      }
    });

  app.on("window-all-closed", () => {
    // Quit on all platforms for now; macOS-specific dock-keep-alive behavior
    // wires in once the full app lifecycle is wired.
    app.quit();
  });
}
