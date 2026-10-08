// Electron main-process entrypoint. Startup order is load-bearing: a release build's refusal of the
// remote-debugging switches first, then the renderer scheme's registration at module top level,
// before `app.ready`, then the profile keyed to the install, main's log, the crash reporter, the
// refusal's log line and the single-instance lock, then the kept appearance, the registry of
// windows and its lifecycle, and the `sidekicks://` link handler, so a second launch or a link
// arriving during start, a link that launches the app on macOS among them, is heard; inside
// `whenReady()`, in order, `installRendererProtocol`, `installApplicationMenu`, the Dock icon of a
// development run, the macOS menu-bar icon, the bridge handlers, the hidden window, whose console
// document opens every window a person sees, and the background service's start and watch.
// `index.test.ts` asserts the order of these Electron calls, all but the profile's, which a
// packaged build skips, and the two icons'. Electron refuses a scheme registered after ready, and a
// window created before the handler is installed loads against an unhandled scheme.

import { homedir } from "node:os";
import path from "node:path";

import {
  app,
  crashReporter,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
  type NativeImage,
} from "electron";
import { appFactsSwitches, supportedPlatform } from "#shared/app-facts.js";
import { fixtureLaunchSwitches, type FixtureLaunch } from "#shared/fixture-launch.js";
import { KeptAppearance } from "./appearance/kept-record.js";
import { APPEARANCE_FILE_NAME, AppearanceRecordFile } from "./appearance/record-file.js";
import { readAppFacts } from "./bridge/app-facts.js";
import { machineClockReaderFor } from "./bridge/machine-clock/platform.js";
import { DaemonForwarding } from "./bridge/daemon.js";
import { FilePathRefs } from "./bridge/file-path/refs.js";
import { installBridgeHandlers } from "./bridge/install-handlers.js";
import { PASTED_IMAGES_FOLDER_NAME, PastedImages } from "./bridge/native/file-intake.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";
import { installApplicationMenu } from "./menu.js";
import { firstWindowContents } from "./probes/first-window-contents.js";
import { startGcProbe } from "./probes/gc.js";
import { installReadinessBreadcrumbs, runSmokeProbe } from "./probes/smoke.js";
import { installAppLinkHandler } from "./services/app-link.js";
import { createCrashReporterDependencies, startCrashReporter } from "./services/crash-reporter.js";
import { DaemonLink } from "./services/daemon/link/status.js";
import { connectMainToDaemon, DaemonSupervisor } from "./services/daemon/supervisor.js";
import { installQuitFlush } from "./services/daemon/quit-flush.js";
import { attachToServiceProcess } from "./services/daemon/service/process.js";
import { resolveServiceProgram } from "./services/daemon/service/program.js";
import { startServiceDetached } from "./services/daemon/service/start.js";
import {
  createMainDiagnosticLog,
  reportUnwrittenDiagnostics,
  type MainDiagnosticLog,
} from "./services/diagnostic-log.js";
import { keyProfileToInstall } from "./services/install-profile.js";
import { logRefusedRemoteDebugging, refuseRemoteDebugging } from "./services/remote-debugging.js";
import { describeFailure } from "#shared/failure-message.js";
import { installRendererProtocol, registerRendererScheme } from "./services/renderer/protocol.js";
import { resolveResourceFile, type InstallLocation } from "./services/resource-file.js";
import { OpenWindows } from "./windows/registry.js";
import { WINDOW_PLACES_FILE_NAME, WindowPlaceFile } from "./windows/places/file.js";
import { installActivationPolicy, isMenuBarIconShown } from "./windows/reveal.js";

/** Where main records a line while it has no log of its own: the startup is failing then. */
const STDERR_LOG: Pick<MainDiagnosticLog, "write"> = {
  write: (entry) => {
    console.error(`[ai-sidekicks/desktop] ${entry.source}: ${entry.message}`);
  },
};

// The build writes the main bundle to `out/main/` and the renderer to `out/renderer/`.
const RENDERER_ROOT = path.join(import.meta.dirname, "../renderer");

// The app icon at the Dock's size, inset by the system's icon margin, for a development run.
const DOCK_ICON_FILE = "dock-icon.png";

// The macOS menu-bar icon's resting face. The `Template` suffix makes macOS draw it in the menu
// bar's own color, and the image loads with its `@2x` beside it.
const MENU_BAR_IDLE_FACE_FILE = "menu-bar-idleTemplate.png";

// First, so no failure later in this script leaves the switches to be served: Electron starts the
// debugging server once the script ends, whether startup failed or not. A release build serves no
// debugging connection; the development build and the test-tier builds keep it for a debugger and
// Playwright.
const refusedRemoteDebugging =
  !import.meta.env.DEV && !__TEST_TIER_BUILD__ ? refuseRemoteDebugging(app.commandLine) : [];

// Runs at module evaluation, before `app.ready`: Electron refuses scheme registration after
// ready, and a scheme that is not `standard` has no origin, so no IndexedDB or `localStorage`,
// which hold the app's UI state.
registerRendererScheme();

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
  createCrashReporterDependencies(
    crashReporter,
    homedir(),
    "log" in mainLogOpening ? mainLogOpening.log : STDERR_LOG,
  ),
);

logRefusedRemoteDebugging(
  refusedRemoteDebugging,
  "log" in mainLogOpening ? mainLogOpening.log : STDERR_LOG,
);

// Compile-time flag: `true` in `electron-vite build --mode=smoke`, `false` in the default
// build. In a release bundle the smoke branch folds away and Rollup drops the probe modules.
declare const __SMOKE_BUILD__: boolean;

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

// One instance owns the profile and its state; a second launch quits, and the first routes the link
// it carries, or, carrying none, brings its window used last forward (`installAppLinkHandler`).
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

/** An image from the package's `resources/` folder; throws when it is missing or not an image. */
function readResourceImage(fileName: string, location: InstallLocation): NativeImage {
  const imagePath = resolveResourceFile(fileName, location);
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) {
    throw new Error(`the image at ${imagePath} could not be read`);
  }
  return image;
}

/**
 * Start the application once Electron is ready. A failed start is recorded and exits with 1;
 * the record is best-effort and the exit is the contract.
 */
function startApplication(): void {
  // Before ready: the kept scheme reaches the platform before anything paints, and the registry's
  // lifecycle and the link handler are installed, so a second launch or a link arriving while the
  // app starts is heard, a link held until the console document reads it. The executor runs now;
  // joined with ready at once, a failure here is the startup failure below.
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
    // macOS hands the link that launched the app to `open-url` before ready; a second launch can
    // arrive while the app starts.
    installAppLinkHandler({ app, windows: openWindows, log });
    resolve({ log, appearance, openWindows });
  });
  Promise.all([windowsReading, app.whenReady()])
    .then(async ([{ log, appearance, openWindows }]) => {
      const installLocation: InstallLocation = {
        isPackaged: app.isPackaged,
        mainBundleFolder: import.meta.dirname,
        resourcesPath: process.resourcesPath,
      };
      // First, so a launch this build cannot play stops before anything is installed.
      const fixtureLaunch = await resolveFixtureLaunch();

      // Test builds only, and only when the harness asked: the macOS accessory activation
      // policy must be in place before the first reveal could activate the application.
      installActivationPolicy(app);
      // Before any window, which could otherwise load against an unhandled scheme. The stamp is
      // read at each serve: the record as it stands, the scheme the platform draws in, and whether
      // this load is a safe start.
      installRendererProtocol(
        RENDERER_ROOT,
        {
          get record() {
            return appearance.record;
          },
          get platformScheme() {
            return appearance.resolvedScheme;
          },
          get isSafeStart() {
            return openWindows.isSafeStart;
          },
        },
        log,
      );
      installApplicationMenu(appearance, log, openWindows, installLocation);
      // A development run is the stock Electron app, whose bundle shows Electron's icon in the
      // Dock; an installed app's bundle carries its own. `dock` exists only on macOS.
      if (!app.isPackaged && app.dock !== undefined) {
        app.dock.setIcon(readResourceImage(DOCK_ICON_FILE, installLocation));
      }
      // On macOS the menu-bar icon stays when the last window closes, and a click on it brings
      // the window used last back.
      if (isMenuBarIconShown()) {
        openWindows.installMenuBarIcon(
          new Tray(readResourceImage(MENU_BAR_IDLE_FACE_FILE, installLocation)),
        );
      }
      const daemonLink = new DaemonLink();
      const supervisor = new DaemonSupervisor({
        link: daemonLink,
        connect: connectMainToDaemon,
        startService: () =>
          startServiceDetached(resolveServiceProgram(installLocation), process.env),
        attachServiceProcess: attachToServiceProcess,
        log,
      });
      // One table of the file tokens handed to the pages: the native members mint them and the
      // daemon relay swaps them for paths.
      const filePathRefs = new FilePathRefs();
      // The pictures pasted into the composer: the native member writes them, and the daemon
      // relay removes each once the service has copied it.
      const pastedImages = new PastedImages({
        folder: path.join(app.getPath("userData"), PASTED_IMAGES_FOLDER_NAME),
        filePathRefs,
        log,
      });
      installBridgeHandlers({
        userData: app.getPath("userData"),
        daemonForwarding: new DaemonForwarding({
          link: daemonLink,
          filePathRefs,
          pastedImages,
          supervisor,
          log,
        }),
        filePathRefs,
        pastedImages,
        supervisor,
        daemonLink,
        log,
        windowContext: { appearance, openWindows },
      });

      // Read after ready because the locales are unknown before it. A fact out of range stops the
      // launch here rather than reaching a page as an unchecked value.
      const platform = supportedPlatform(process.platform);
      const machineClock = machineClockReaderFor(platform);
      const appSwitches = appFactsSwitches(readAppFacts(platform, machineClock));
      // Heard from here on, so a region or clock changed while the app runs redraws every figure.
      machineClock.watch?.((clock) => {
        openWindows.announceMachineClock(clock);
      }, log);

      // The probes in `./probes/` are gated twice: the compile-time `__SMOKE_BUILD__` (a release
      // bundle references nothing there, so Rollup drops the modules) and a per-run env var, so
      // even a smoke bundle never auto-runs one. A release binary must not embed a path such as
      // `executeJavaScript` against the renderer, which is untrusted.
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
        installQuitFlush(app, () => supervisor.flushAtQuit(), {
          log,
          reportUnwrittenLog: (message) => {
            console.error(message);
          },
        });
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
