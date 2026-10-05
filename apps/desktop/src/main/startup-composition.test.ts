// Main's startup sequence, recorded by importing `index.ts` under a mocked `electron`. Two
// orderings are load-bearing beyond the rest: `protocol.registerSchemesAsPrivileged` before
// `app.whenReady()` (Electron refuses it after ready, and a non-`standard` scheme has no origin,
// so no IndexedDB or `localStorage`), and `protocol.handle` before the first window (or a window
// loads against an unhandled scheme). The crash reporter comes next after the scheme, so a crash
// anywhere later in startup is kept, and the second-launch listener is in place before ready, so a
// launch arriving while the app starts is heard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron-mock.js";

// The mock's `app.whenReady()` is a deferred the test releases by hand: awaiting the dynamic
// `import()` already drains several microtask ticks, so an already-resolved promise would run
// the ready continuation before the module-evaluation prefix could be observed.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// The supervisor reaches the person's real background service, and starts one when none
// answers; here it only records when the composition starts it and flushes it at quit.
vi.mock("./services/daemon/daemon-supervisor.js", () => ({
  connectMainToDaemon: vi.fn(),
  DaemonSupervisor: class {
    public start(): void {
      electronMock.record("supervisor.start");
    }

    public requestStart(): void {}

    public endService(): Promise<{ accepted: true }> {
      return Promise.resolve({ accepted: true });
    }

    public flushAtQuit(): Promise<void> {
      electronMock.record("supervisor.flushAtQuit");
      return Promise.resolve();
    }
  },
}));

/** The steps the sequence is asserted over; the bridge's handlers read as one step. */
const STARTUP_OPERATIONS: readonly string[] = [
  "protocol.registerSchemesAsPrivileged",
  "crashReporter.start",
  "app.requestSingleInstanceLock",
  "app.on:second-instance",
  "app.whenReady",
  "protocol.handle",
  "Menu.setApplicationMenu",
  "ipcMain.handle",
  "construct",
  "supervisor.start",
];

/** The startup steps, in the order they actually ran, each bridge handler folded into one. */
function startupSequence(): string[] {
  const sequence: string[] = [];
  for (const operation of electronMock.operations) {
    const step = operation.startsWith("ipcMain.handle:") ? "ipcMain.handle" : operation;
    if (STARTUP_OPERATIONS.includes(step) && sequence.at(-1) !== step) {
      sequence.push(step);
    }
  }
  return sequence;
}

/** Lets the ready continuation run to its end before assertions; everything is microtasks. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await Promise.resolve();
  }
}

/** Imports the entry point with `process.platform` reading `platform`, then releases ready. */
async function startMain(platform: NodeJS.Platform): Promise<void> {
  Object.defineProperty(process, "platform", { value: platform });
  await import("./index.js");
  electronMock.releaseReady();
  await drainMicrotasks();
}

const realPlatform = process.platform;

describe("main-process startup composition", () => {
  beforeEach(() => {
    electronMock.reset();
    electronMock.armReady();
    vi.resetModules();
    // The crash reporter reads the machine settings file under the home folder; one that does
    // not exist reads as the defaults, so the person's own settings never decide this suite.
    vi.stubEnv("HOME", "/sidekicks-startup-composition-home");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    vi.unstubAllEnvs();
  });

  it("runs every startup step in its order, the scheme before ready", async () => {
    await import("./index.js");

    // Ready is not released yet, so only module-evaluation calls are recorded. A
    // `registerRendererScheme()` moved inside `whenReady()` would drop the first entry.
    expect(startupSequence()).toEqual([
      "protocol.registerSchemesAsPrivileged",
      "crashReporter.start",
      "app.requestSingleInstanceLock",
      "app.on:second-instance",
      "app.whenReady",
    ]);

    electronMock.releaseReady();
    await drainMicrotasks();

    // The full sequence, so a swap of any two steps fails.
    expect(startupSequence()).toEqual(STARTUP_OPERATIONS);
  });

  it("keeps running on macOS when the last window closes, and quits after the service's flush", async () => {
    await startMain("darwin");

    electronMock.emitAppEvent("window-all-closed");
    expect(electronMock.operations, "closing the last window quit the app on macOS").not.toContain(
      "app.quit",
    );

    expect(electronMock.emitAppEvent("before-quit"), "the quit did not wait for the flush").toBe(
      true,
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(electronMock.operations.slice(-2)).toEqual(["supervisor.flushAtQuit", "app.quit"]);
  });
});
