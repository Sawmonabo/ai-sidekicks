// A failed startup exits even when its own record fails first. The records (stderr, the JSONL
// log) are best-effort and the exit is the contract: the handler is last on the chain, so a
// rejection leaving it would be unhandled and the process would skip `app.exit`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "@test/helpers/electron/mock/electron-mock.js";
import type { MainDiagnosticEntry, MainDiagnosticLog } from "./services/diagnostic-log.js";

const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

/** Why the ready continuation rejects: the last step, so most of the startup is already done. */
const STARTUP_FAILURE = new Error("the console window could not be created");

const openConsoleWindow = vi.fn(() => {
  throw STARTUP_FAILURE;
});

vi.mock("./windows/window.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows/window.js")>()),
  openConsoleWindow,
}));

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

/**
 * Run the startup to its failure and let every continuation settle. A fixed tick count, not a
 * poll: everything is microtasks, and a poll would hide a failure behind a timeout.
 */
async function runStartupToFailure(): Promise<void> {
  await import("./index.js");
  electronMock.releaseReady();
  for (let tick = 0; tick < 20; tick++) {
    await Promise.resolve();
  }
}

describe("a failed startup exits, whatever the record of it does first", () => {
  beforeEach(() => {
    electronMock.reset();
    electronMock.armReady();
    vi.resetModules();
    writtenEntries.length = 0;
    reportUnwrittenDiagnosticsOutcome = async () => {};
    openConsoleWindow.mockClear();
    // Every case deliberately logs a failure; keep the run output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The crash reporter reads the machine settings file under the home folder at import; one
    // that does not exist reads as the defaults, so the person's own settings stay out of it.
    vi.stubEnv("HOME", "/sidekicks-startup-failure-home");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exits once when the log directory cannot even be resolved", async () => {
    // Electron throws from `getPath` when a path cannot be resolved.
    electronMock.failPathLookup("logs", new Error("no logs directory on this host"));

    await runStartupToFailure();

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

    await runStartupToFailure();

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
      await runStartupToFailure();
    } finally {
      process.argv = launchArguments;
    }

    expect(openConsoleWindow).not.toHaveBeenCalled();
    expect(writtenEntries[0]?.message).toContain("--fixture");
    expect(electronMock.exitCodes).toEqual([1]);
  });

  it("exits once when the record lands cleanly", async () => {
    // The control: without it the cases above would pass over a handler that exits before
    // writing anything.
    await runStartupToFailure();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0]?.message).toContain(STARTUP_FAILURE.message);
    expect(electronMock.exitCodes).toEqual([1]);
  });
});
