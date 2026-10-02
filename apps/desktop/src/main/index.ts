// Electron main-process entrypoint. Startup order is load-bearing and `startup-order.test.ts`
// asserts it: `registerRendererScheme()` at module top level, before `app.ready`; then inside
// `whenReady()`, in order, `installRendererProtocol`, `installApplicationMenu`,
// `installBridgeHandlers` and `createMainWindow`. Electron refuses a scheme registered after
// ready, and a window created before the handler is installed loads against an unhandled scheme.

import { totalmem } from "node:os";
import path from "node:path";

import { app } from "electron";
import { appFactsSwitches, supportedArch, supportedPlatform } from "@shared/app-facts.js";
import { fixtureLaunchSwitches, type FixtureLaunch } from "@shared/fixture-launch.js";
import { installBridgeHandlers } from "./bridge/install-bridge-handlers.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";
import { createMainDiagnosticLog, reportUnwrittenDiagnostics } from "./services/diagnostic-log.js";
import { installApplicationMenu } from "./menu.js";
import { startGcProbe } from "./probes/gc-probe.js";
import { installReadinessBreadcrumbs, runSmokeProbe } from "./probes/smoke-probe.js";
import { installRendererProtocol, registerRendererScheme } from "./services/renderer-protocol.js";
import { createMainWindow } from "./windows/window.js";
import { installActivationPolicy } from "./windows/window-reveal.js";

// The build writes the main bundle to `out/main/` and the renderer to `out/renderer/`.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// Runs at module evaluation, before `app.ready`: Electron refuses scheme registration after
// ready, and a scheme that is not `standard` has no origin, so no IndexedDB or `localStorage`,
// which hold the app's UI state.
registerRendererScheme();

// Compile-time flag: `true` in `electron-vite build --mode=smoke`, `false` in the default
// build. In a release bundle the smoke branch folds away and Rollup drops the probe modules.
declare const __SIDEKICKS_SMOKE_BUILD__: boolean;

// The fixture gate, substituted by the same `define` block: `true` in the development and
// fixtures builds, `false` in every other, the release build included.
declare const __FIXTURE_BUILD__: boolean;

/**
 * The fixture launch this command line asks for, checked, or `undefined` for a normal launch.
 * The `if`/`else` shape lets a release bundle fold to the refusal alone: the catalog check,
 * its dynamic import and the scenarios all go.
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

// One instance owns the profile and its state; a second launch quits.
const gotTheLock = app.requestSingleInstanceLock();

// The probes live in `./probes/`. Both are gated twice: the compile-time
// `__SIDEKICKS_SMOKE_BUILD__` (a release bundle references nothing there, so Rollup drops the
// modules) and a per-run env var, so even a smoke bundle never auto-runs one. A release binary
// must not embed a path such as `executeJavaScript` against the renderer, which is untrusted.

if (!gotTheLock) {
  app.quit();
} else {
  app
    .whenReady()
    .then(async () => {
      // First, so a launch this build cannot play stops before anything is installed.
      const fixtureLaunch = await resolveFixtureLaunch();

      // Test builds only, and only when the harness asked: the macOS accessory activation
      // policy must be in place before the first reveal could activate the application.
      installActivationPolicy(app);
      // Before any window: a window constructed ahead of the handler could load against an
      // unhandled scheme.
      installRendererProtocol(RENDERER_ROOT);
      installApplicationMenu();
      installBridgeHandlers({ userData: app.getPath("userData") });

      // Read after ready because the locale is unknown before it. An unsupported platform or
      // architecture stops the launch here rather than reaching a page as an unchecked value.
      const appSwitches = appFactsSwitches({
        version: app.getVersion(),
        platform: supportedPlatform(process.platform),
        arch: supportedArch(process.arch),
        locale: app.getLocale(),
        physicalMemoryBytes: totalmem(),
      });

      // Both conditions must hold: the compile-time smoke flag and the runtime opt-in.
      const smokeProbeRequested =
        __SIDEKICKS_SMOKE_BUILD__ && process.env["SIDEKICKS_SMOKE_PROBE"] === "1";

      // Sampled before `createMainWindow`, which starts the load being timed.
      const probeStartedAt = Date.now();

      // `did-finish-load` is registered in `beforeLoad` because the load starts inside the
      // factory; a listener attached afterward would depend on Electron's event timing.
      createMainWindow({
        // The app's facts and any fixture launch reach the window as renderer switches, which
        // the preload reads once, before the page's first render.
        additionalArguments:
          fixtureLaunch === undefined
            ? appSwitches
            : [...appSwitches, ...fixtureLaunchSwitches(fixtureLaunch)],
        beforeLoad: (window) => {
          if (smokeProbeRequested) {
            // Registered ahead of the load so a boot that never reaches `did-finish-load`
            // still shows where it stopped.
            const traceReadiness = installReadinessBreadcrumbs(window, probeStartedAt);
            window.webContents.once("did-finish-load", () => {
              traceReadiness("did-finish-load");
              const windowMs = Date.now() - probeStartedAt;
              void runSmokeProbe(window, windowMs);
            });
          }
        },
      });

      // The GC probe registers its own listener and defers itself, so nothing scheduled here
      // closes over the window it measures.
      if (
        !smokeProbeRequested &&
        __SIDEKICKS_SMOKE_BUILD__ &&
        process.env["SIDEKICKS_GC_PROBE"] === "1"
      ) {
        startGcProbe(app);
      }
    })
    .catch(async (startupFailure: unknown) => {
      // Two records for two readers: stderr for a developer watching, the JSONL log for a
      // launch nobody watched. The log is drained before the exit because a queued append does
      // not survive `app.exit`; the log never throws at this handler, so an unwritten one is
      // reported to stderr.
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
        // The conditions that break a startup (a read-only home, a full disk) also break
        // its log, and `app.getPath` throws when a path cannot be resolved.
        console.error(
          "[ai-sidekicks/desktop] the startup log could not be written:",
          loggingFailure,
        );
      } finally {
        // The exit is the contract and the record is best-effort. A rejection escaping this
        // terminal handler would be unhandled: the process would die through Node's path and
        // `app.quit`'s hooks would not run.
        app.exit(1);
      }
    });

  app.on("window-all-closed", () => {
    // Quit on every platform, macOS included.
    app.quit();
  });
}
