// Whether the log says a run is running, per run and newest write winning.
//
// The fold's whole job is to be silent when nothing is running, so the negative
// controls are the point: a fold that answered `true` for any run event would pass a
// single positive case and put 8.9's aside on every terminal that has ever run
// anything.
//
// The events come off the store family's own builder, which is where this package
// decided what an admitted event looks like. A local one written beside these cases
// would be the third derivation the lease suites' repair already ended once.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "../../store/session-event.test-support.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import { hasSteppableRun } from "./steppable-run-model.js";

const SESSION_ID = "session-1";

/**
 * One run event at an explicit position, and its run where it names one.
 *
 * The sequence is a parameter rather than a counter, because the fold's tie-breaker IS
 * the position: a case about newest-write-wins has to be able to state which write is
 * newer, and a shared counter hides that behind call order.
 */
function runEvent(sequence: number, kind: string, runId: string | undefined): ConsoleSessionEvent {
  return eventOfKind(SESSION_ID, kind, sequence, runId === undefined ? undefined : { runId });
}

describe("whether a run can be stepped into", () => {
  it("says nothing about a session with no events", () => {
    expect(hasSteppableRun([])).toBe(false);
  });

  it("reads a running run as steppable", () => {
    expect(hasSteppableRun([runEvent(1, "run.running", "run-1")])).toBe(true);
  });

  it("stops saying so once the run finishes", () => {
    expect(
      hasSteppableRun([runEvent(1, "run.running", "run-1"), runEvent(2, "run.completed", "run-1")]),
    ).toBe(false);
  });

  it("stops saying so once the run pauses", () => {
    expect(
      hasSteppableRun([runEvent(1, "run.running", "run-1"), runEvent(2, "run.paused", "run-1")]),
    ).toBe(false);
  });

  it("stops saying so while a run waits on an approval", () => {
    expect(
      hasSteppableRun([
        runEvent(1, "run.running", "run-1"),
        runEvent(2, "run.waiting_for_approval", "run-1"),
      ]),
    ).toBe(false);
  });

  it("keeps saying so while a second run is still going", () => {
    expect(
      hasSteppableRun([
        runEvent(1, "run.running", "run-1"),
        runEvent(2, "run.running", "run-2"),
        runEvent(3, "run.completed", "run-1"),
      ]),
    ).toBe(true);
  });

  it("lets the log's position decide, not the order the events arrived in", () => {
    // The fold is newest-write-wins per run, and "newest" is the sequence rather than
    // the array order — a fold that took the last entry it saw would answer `false`.
    expect(
      hasSteppableRun([runEvent(9, "run.running", "run-1"), runEvent(4, "run.completed", "run-1")]),
    ).toBe(true);
  });

  it("does not read a queued run as steppable", () => {
    expect(hasSteppableRun([runEvent(1, "run.queued", "run-1")])).toBe(false);
  });

  it("ignores an event that is not a run's", () => {
    expect(hasSteppableRun([runEvent(1, "pty.control_changed", "run-1")])).toBe(false);
  });

  it("ignores a run event whose payload names no run", () => {
    expect(hasSteppableRun([runEvent(1, "run.running", undefined)])).toBe(false);
  });
});
