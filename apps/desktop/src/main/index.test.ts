// Main's startup, recorded by importing `index.ts` under a mocked `electron`.
//
// In the sequence, two orderings are load-bearing beyond the rest:
// `protocol.registerSchemesAsPrivileged` before `app.whenReady()` (Electron refuses it after
// ready, and a non-`standard` scheme has no origin, so no IndexedDB or `localStorage`), and
// `protocol.handle` before the first window (or a window loads against an unhandled scheme). Main's
// log is opened before the crash reporter, which records in it, and the crash reporter starts
// before the single-instance lock, so a crash anywhere later in startup is kept, and the
// second-launch listener is in place before ready, so a launch arriving while the app starts is
// heard.
//
// A failed startup exits even when its own record fails first. The records (stderr, the JSONL
// log) are best-effort and the exit is the contract: the handler is last on the chain, so a
// rejection leaving it would be unhandled and the process would skip `app.exit`.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "#test/helpers/electron/mock/module.js";
import { handedDocument, windowOpenHandlerOf } from "#test/helpers/electron/mock/readers.js";
import type { MainDiagnosticEntry, MainDiagnosticLog } from "./services/diagnostic-log.js";

// The mock's `app.whenReady()` is a deferred the test releases by hand: awaiting the dynamic
// `import()` already drains several microtask ticks, so an already-resolved promise would run
// the ready continuation before the module-evaluation prefix could be observed.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

// The supervisor reaches the person's real background service, and starts one when none
// answers; here it only records when the composition starts it and flushes it at quit.
vi.mock("./services/daemon/supervisor.js", () => ({
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

/** Why a failing startup's ready continuation rejects: the last step, so most of it is done. */
const STARTUP_FAILURE = new Error("the hidden window could not be created");

/** Whether the hidden window throws `STARTUP_FAILURE` on the case currently running. */
let isHiddenWindowFailing = false;

const openHiddenWindow = vi.fn();

vi.mock("./windows/factory.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./windows/factory.js")>();
  openHiddenWindow.mockImplementation(
    (...options: Parameters<typeof original.openHiddenWindow>) => {
      if (isHiddenWindowFailing) {
        throw STARTUP_FAILURE;
      }
      return original.openHiddenWindow(...options);
    },
  );
  return { ...original, openHiddenWindow };
});

/** Entries the startup log was handed, kept in memory. */
const writtenEntries: MainDiagnosticEntry[] = [];

/** What `reportUnwrittenDiagnostics` does on the case currently running. */
let reportUnwrittenDiagnosticsOutcome: () => Promise<void> = async () => {};

vi.mock("./services/diagnostic-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/diagnostic-log.js")>()),
  createMainDiagnosticLog: vi.fn(
    () =>
      ({
        write: (entry: MainDiagnosticEntry) => {
          writtenEntries.push(entry);
        },
      }) as unknown as MainDiagnosticLog,
  ),
  reportUnwrittenDiagnostics: vi.fn(() => reportUnwrittenDiagnosticsOutcome()),
}));

/** The steps the sequence is asserted over; the bridge's handlers read as one step. */
const STARTUP_OPERATIONS: readonly string[] = [
  "protocol.registerSchemesAsPrivileged",
  "app.getPath:logs",
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

const realPlatform = process.platform;

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

/**
 * Lets the ready continuation run to its end before assertions. A fixed tick count, not a poll:
 * everything is microtasks, and a poll would hide a failure behind a timeout.
 */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await Promise.resolve();
  }
}

/** Imports the entry point with `process.platform` reading `platform`, then releases ready. */
async function startMain(platform: NodeJS.Platform = realPlatform): Promise<void> {
  Object.defineProperty(process, "platform", { value: platform });
  await import("./index.js");
  electronMock.releaseReady();
  await drainMicrotasks();
}

// The first import transforms main's whole module graph, which under the full parallel suite takes
// longer than one test's budget; it is paid once here, so each test times only the startup itself.
beforeAll(async () => {
  electronMock.armReady();
  vi.stubEnv("HOME", "/sidekicks-main-startup-home");
  await import("./index.js");
  vi.unstubAllEnvs();
}, 60_000);

beforeEach(() => {
  electronMock.reset();
  electronMock.armReady();
  vi.resetModules();
  writtenEntries.length = 0;
  reportUnwrittenDiagnosticsOutcome = async () => {};
  isHiddenWindowFailing = false;
  openHiddenWindow.mockClear();
  // The crash reporter reads the machine settings file under the home folder at import; one
  // that does not exist reads as the defaults, so the person's own settings never decide this
  // suite.
  vi.stubEnv("HOME", "/sidekicks-main-startup-home");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("main-process startup composition", () => {
  it("runs every startup step in its order, the scheme before ready", async () => {
    await import("./index.js");

    // Ready is not released yet, so only module-evaluation calls are recorded. A scheme
    // registration moved inside `whenReady()` would drop the first entry.
    expect(startupSequence()).toEqual([
      "protocol.registerSchemesAsPrivileged",
      "app.getPath:logs",
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
    const hiddenWindow = electronMock.constructed.at(-1) ?? expect.fail("no hidden window");
    const answer = windowOpenHandlerOf({
      baseWindow: hiddenWindow,
      view: hiddenWindow.contentView.children[0],
    })({ url: "about:blank", frameName: "window/w-1" }) as {
      createWindow: (options: object) => unknown;
    };
    answer.createWindow({ webContents: handedDocument() });
    const onlyWindow = electronMock.constructed.at(-1) ?? expect.fail("no window a person sees");

    onlyWindow.close();
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

describe("a failed startup exits, whatever the record of it does first", () => {
  beforeEach(() => {
    isHiddenWindowFailing = true;
    // Every case deliberately logs a failure; keep the run output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("exits once when the log directory cannot even be resolved", async () => {
    // Electron throws from `getPath` when a path cannot be resolved.
    electronMock.failPathLookup("logs", new Error("no logs directory on this host"));

    await startMain();

    expect(
      writtenEntries,
      "the log was reached, so this case is no longer exercising the failure it names",
    ).toHaveLength(0);
    expect(
      electronMock.exitCodes,
      "a startup whose own failure record threw did not exit, so Electron's quit path never ran",
    ).toEqual([1]);
  });

  it("exits once when the log's own failure report rejects", async () => {
    reportUnwrittenDiagnosticsOutcome = async () => {
      throw new Error("the log could not be drained");
    };

    await startMain();

    // The entry was written; the failure under test is the drain.
    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0]?.level).toBe("error");
    expect(electronMock.exitCodes).toEqual([1]);
  });

  it("refuses --fixture in a build without the catalog, before any window", async () => {
    // The fixture define is `false` here, the release shape. The failing window factory would
    // also exit 1, so what tells the cases apart is that no window was attempted and the record
    // names the argument.
    const launchArguments = process.argv;
    process.argv = [...launchArguments, "--fixture", "first-run"];
    try {
      await startMain();
    } finally {
      process.argv = launchArguments;
    }

    expect(openHiddenWindow).not.toHaveBeenCalled();
    expect(writtenEntries[0]?.message).toContain("--fixture");
    expect(electronMock.exitCodes).toEqual([1]);
  });

  it("exits once when the record lands cleanly", async () => {
    // The control: without it the cases above would pass over a handler that exits before
    // writing anything.
    await startMain();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0]?.message).toContain(STARTUP_FAILURE.message);
    expect(electronMock.exitCodes).toEqual([1]);
  });
});
