// Electron main-process entrypoint. Startup order is load-bearing and `index.test.ts` asserts
// it: the renderer scheme's registration at module top level, before `app.ready`, then the crash
// reporter, then the profile keyed to the install and the single-instance lock, then the kept
// appearance, the registry of windows and its lifecycle, so a second launch during start is heard;
// inside `whenReady()`, in order, `installRendererProtocol`, `installApplicationMenu`, the bridge
// handlers, the hidden window, whose console document opens every window a person sees, and the
// background service's start and watch. Electron refuses a scheme registered after ready, and a
// window created before the handler is installed loads against an unhandled scheme.

import { homedir, totalmem } from "node:os";
import path from "node:path";

import { app, crashReporter, nativeTheme, screen } from "electron";
import { appFactsSwitches, supportedArch, supportedPlatform } from "#shared/app-facts.js";
import { fixtureLaunchSwitches, type FixtureLaunch } from "#shared/fixture-launch.js";
import { KeptAppearance } from "./appearance/kept-appearance.js";
import { APPEARANCE_FILE_NAME, AppearanceRecordFile } from "./appearance/record-file.js";
import { DaemonForwarding } from "./bridge/daemon.js";
import { FilePathRefs } from "./bridge/file-path/file-path-refs.js";
import { installBridgeHandlers } from "./bridge/install-bridge-handlers.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";
import { installApplicationMenu } from "./menu.js";
import { firstWindowContents } from "./probes/first-window-contents.js";
import { startGcProbe } from "./probes/gc-probe.js";
import { installReadinessBreadcrumbs, runSmokeProbe } from "./probes/smoke-probe.js";
import { processCrashReporterHost, startCrashReporter } from "./services/crash-reporter.js";
import { DaemonLink } from "./services/daemon/daemon-link.js";
import { connectMainToDaemon, DaemonSupervisor } from "./services/daemon/daemon-supervisor.js";
import { installQuitFlush } from "./services/daemon/quit-flush.js";
import { attachToServiceProcess } from "./services/daemon/service/service-process.js";
import { resolveServiceProgram } from "./services/daemon/service/service-program.js";
import { startServiceDetached } from "./services/daemon/service/start.js";
import {
  createMainDiagnosticLog,
  reportUnwrittenDiagnostics,
  type MainDiagnosticLog,
} from "./services/diagnostic-log.js";
import { keyProfileToInstall } from "./services/install-profile.js";
import { describeFailure } from "./services/failure-message.js";
import {
  installRendererProtocol,
  RendererSchemeRegistration,
} from "./services/renderer/protocol.js";
import { OpenWindows } from "./windows/open-windows.js";
import { WINDOW_PLACES_FILE_NAME, WindowPlaceFile } from "./windows/places/place-file.js";
import { installActivationPolicy } from "./windows/reveal.js";

/** Where main records a line while it has no log of its own: the startup is failing then. */
const STDERR_LOG: Pick<MainDiagnosticLog, "write"> = {
  write: (entry) => {
    console.error(`[ai-sidekicks/desktop] ${entry.source}: ${entry.message}`);
  },
};

// The build writes the main bundle to `out/main/` and the renderer to `out/renderer/`.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// Runs at module evaluation, before `app.ready`: Electron refuses scheme registration after
// ready, and a scheme that is not `standard` has no origin, so no IndexedDB or `localStorage`,
// which hold the app's UI state.
new RendererSchemeRegistration().register();

// The lock, the crash reports and the logs all live under the profile folder, so it is keyed to
// the install first: a development build and a shipped one never share a lock or a profile.
keyProfileToInstall(app);

// Main's one log, handed to everything that writes it: two logs over one file could interleave a
// line. Opened before the crash reporter, which records in it a settings file it could not read; a
// logs folder that cannot be resolved fails the startup below, and until then stderr stands in.
const mainLogOpening = openMainLog();

// Next and ahead of everything else, so a crash anywhere later in startup is kept. It touches no
// network and reads one value of the machine's settings file.
startCrashReporter(
  processCrashReporterHost(
    crashReporter,
    homedir(),
    "log" in mainLogOpening ? mainLogOpening.log : STDERR_LOG,
  ),
);

// Compile-time flag: `true` in `electron-vite build --mode=smoke`, `false` in the default
// build. In a release bundle the smoke branch folds away and Rollup drops the probe modules.
declare const __SMOKE_BUILD__: boolean;

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

// One instance owns the profile and its state; a second launch quits, and the first brings its
// window used last forward (`OpenWindows.installLifecycle`).
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  startApplication();
}

/** Main's log, or why its folder could not be resolved. */
function openMainLog(): { readonly log: MainDiagnosticLog } | { readonly failure: unknown } {
  try {
    return { log: createMainDiagnosticLog(app.getPath("logs")) };
  } catch (failure) {
    return { failure };
  }
}

// The probes live in `./probes/`. Both are gated twice: the compile-time
// `__SMOKE_BUILD__` (a release bundle references nothing there, so Rollup drops the
// modules) and a per-run env var, so even a smoke bundle never auto-runs one. A release binary
// must not embed a path such as `executeJavaScript` against the renderer, which is untrusted.

/**
 * Start the application once Electron is ready. A failed start is recorded and exits with 1;
 * the record is best-effort and the exit is the contract.
 */
function startApplication(): void {
  // Before ready: the kept scheme reaches the platform before anything paints, and the registry's
  // lifecycle is installed so a second launch arriving while the app starts is heard. The executor
  // runs now; joined with ready at once, a failure here is the startup failure below.
  const windowsReading = new Promise<{
    readonly log: MainDiagnosticLog;
    readonly appearance: KeptAppearance;
    readonly openWindows: OpenWindows;
  }>((resolve) => {
    if ("failure" in mainLogOpening) {
      throw mainLogOpening.failure;
    }
    const { log } = mainLogOpening;
    const appearance = new KeptAppearance({
      file: new AppearanceRecordFile({
        filePath: path.join(app.getPath("userData"), APPEARANCE_FILE_NAME),
        log,
        now: () => new Date(),
      }),
      nativeTheme,
    });
    const openWindows = new OpenWindows({
      placeFile: new WindowPlaceFile(
        path.join(app.getPath("userData"), WINDOW_PLACES_FILE_NAME),
        log,
      ),
      screen,
      appearance,
      log,
    });
    openWindows.installLifecycle(app);
    resolve({ log, appearance, openWindows });
  });
  Promise.all([windowsReading, app.whenReady()])
    .then(async ([{ log, appearance, openWindows }]) => {
      // First, so a launch this build cannot play stops before anything is installed.
      const fixtureLaunch = await resolveFixtureLaunch();

      // Test builds only, and only when the harness asked: the macOS accessory activation
      // policy must be in place before the first reveal could activate the application.
      installActivationPolicy(app);
      // Before any window: a window constructed ahead of the handler could load against an
      // unhandled scheme.
      // Read at each serve: the record as it stands, the scheme the platform draws in, and whether
      // this load is a safe start.
      installRendererProtocol(RENDERER_ROOT, {
        get record() {
          return appearance.record;
        },
        get platformScheme() {
          return nativeTheme.shouldUseDarkColors ? "dark" : "light";
        },
        get isSafeStart() {
          return openWindows.isSafeStart;
        },
      });
      installApplicationMenu(appearance, { log, now: () => new Date() });
      const daemonLink = new DaemonLink();
      const supervisor = new DaemonSupervisor({
        link: daemonLink,
        connect: connectMainToDaemon,
        startService: () =>
          startServiceDetached(
            resolveServiceProgram({
              isPackaged: app.isPackaged,
              mainBundleFolder: import.meta.dirname,
              resourcesPath: process.resourcesPath,
            }),
            process.env,
          ),
        attachServiceProcess: attachToServiceProcess,
        log,
        now: () => new Date(),
      });
      // One table of the file tokens handed to the pages: the native members mint them and the
      // daemon relay swaps them for paths.
      const filePathRefs = new FilePathRefs();
      installBridgeHandlers({
        userData: app.getPath("userData"),
        daemonForwarding: new DaemonForwarding({
          link: daemonLink,
          filePathRefs,
          supervisor,
          log,
          now: () => new Date(),
        }),
        filePathRefs,
        supervisor,
        daemonLink,
        log,
        windowContext: { appearance, openWindows },
      });

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
      const smokeProbeRequested = __SMOKE_BUILD__ && process.env["SIDEKICKS_SMOKE_PROBE"] === "1";

      // Sampled before the hidden window, which starts the load being timed.
      const probeStartedAt = Date.now();

      // `did-finish-load` is registered in `beforeLoad` because the load starts inside the
      // factory; a listener attached afterward would depend on Electron's event timing.
      openWindows.openHiddenWindow({
        // The app's facts and any fixture launch reach the console document as renderer switches,
        // which the preload reads once, before the page's first render.
        additionalArguments:
          fixtureLaunch === undefined
            ? appSwitches
            : [...appSwitches, ...fixtureLaunchSwitches(fixtureLaunch)],
        beforeLoad: ({ view }) => {
          if (smokeProbeRequested) {
            // Registered ahead of the load so a boot that never reaches `did-finish-load`
            // still shows where it stopped.
            const traceReadiness = installReadinessBreadcrumbs(view.webContents, probeStartedAt);
            const drawnContents = firstWindowContents(app);
            view.webContents.once("did-finish-load", () => {
              traceReadiness("did-finish-load");
              const windowMs = Date.now() - probeStartedAt;
              void runSmokeProbe(view.webContents, drawnContents, windowMs);
            });
          }
        },
      });

      // A fixture launch plays its scenario against the fixture bridge, so no service is
      // reached. Otherwise main looks for the service and starts it when none answers; a quit
      // waits for the service's flush, at most 10 seconds, and leaves it, every run and every
      // shell running.
      if (fixtureLaunch === undefined) {
        supervisor.start();
        installQuitFlush(app, () => supervisor.flushAtQuit(), { log, now: () => new Date() });
      }

      // The GC probe registers its own listener and defers itself, so nothing scheduled here
      // closes over the window it measures.
      if (!smokeProbeRequested && __SMOKE_BUILD__ && process.env["SIDEKICKS_GC_PROBE"] === "1") {
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
        const startupLog =
          "log" in mainLogOpening
            ? mainLogOpening.log
            : createMainDiagnosticLog(app.getPath("logs"));
        startupLog.write({
          at: new Date().toISOString(),
          level: "error",
          source: "main/index",
          message: `startup failed: ${describeFailure(startupFailure)}`,
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
}
