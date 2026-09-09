// The exit a failed startup owes, and the two ways the record of it can fail first.
//
// `index.ts`'s terminal `.catch` writes two records — stderr for a developer watching
// the binary, the JSONL log for a launch nobody was watching — and then exits. The
// records are best-effort and the exit is the contract, and the ordering matters
// because the conditions that break a startup are exactly the conditions that break
// its record: a read-only home, a revoked profile directory, a full disk. So each
// failure inside the record has its own case here, and both assert the same thing.
//
// WHAT AN ESCAPED REJECTION COSTS, which is why this is worth a file. That handler is
// the last one on the chain, so a rejection leaving it is unhandled: the process dies
// through Node's own path instead of `app.exit`, `app.quit`'s hooks never run, and
// the sidecar drain `registerSidecarLifecycle` registers at position 0 is skipped —
// a startup failure orphaning the children a clean exit would have reaped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElectronMock } from "../../test/helpers/electron-mock.js";
import type { MainDiagnosticEntry, MainDiagnosticLog } from "./diagnostic-log.js";

// The shared `electron` mock, with its ordered log on: `app.exit` is recorded there
// as well as in `exitCodes`, and a suite about what runs after a failure wants both.
const electronMock = createElectronMock({ recordOrder: true });

vi.mock("electron", () => electronMock.moduleExports);

/**
 * Why the ready continuation rejects.
 *
 * The window factory rather than one of the installers before it, because it is the
 * last step and therefore the one whose failure leaves the most already done — the
 * shape a real startup failure has.
 */
const STARTUP_FAILURE = new Error("the main window could not be created");

vi.mock("./window.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./window.js")>()),
  createMainWindow: vi.fn(() => {
    throw STARTUP_FAILURE;
  }),
}));

/** Entries the startup log was handed. In memory: no case here touches a disk. */
const writtenEntries: MainDiagnosticEntry[] = [];

/** What `reportUnwrittenDiagnostics` does on the case currently running. */
let reportUnwrittenDiagnosticsOutcome: () => Promise<void> = async () => {};

vi.mock("./diagnostic-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diagnostic-log.js")>()),
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
 * Run the startup to its failure and let every continuation behind it settle.
 *
 * Twenty ticks rather than a poll: the handler's own body is one `await` deep and
 * the chain above it a few more, all microtasks, so the settled state is reached in
 * a bounded number of turns and a test that waited on a condition would hide the
 * red arm's failure behind a timeout instead of showing it.
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
    // Silenced rather than left to the terminal: both cases deliberately log a
    // failure, and a suite that printed them would read as a broken run.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits once when the log directory cannot even be resolved", async () => {
    // Electron throws from `getPath` when a path cannot be resolved, and `logs` is
    // the one a failing startup is least likely to reach.
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

    // The record was attempted and got as far as the entry: the failure under test
    // is the drain, not the write.
    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0]?.level).toBe("error");
    expect(electronMock.exitCodes).toEqual([1]);
  });

  it("exits once when the record lands cleanly", async () => {
    // The control. Without it the two cases above would pass over a handler that
    // exited before writing anything at all.
    await runStartupToFailure();

    expect(writtenEntries).toHaveLength(1);
    expect(writtenEntries[0]?.message).toContain(STARTUP_FAILURE.message);
    expect(electronMock.exitCodes).toEqual([1]);
  });
});
