// Whether the store's run partition says a run is running.
//
// THE CASES THAT MATTER ARE THE DISAGREEMENTS. A fold that answered from the raw
// timeline passed every positive case here and still put 8.9's aside on a run the rest
// of the console did not consider running: a tolerant `run.running` beat whose payload
// contradicts its own kind — or names no state at all — is refused by the run-lifecycle
// projector and reaches the `run` partition never, while a fold keyed on `event.kind`
// alone read it as a start. So the disagreement cases drive the REAL projector rather
// than hand-building the partition, because a partition written by hand cannot show
// that the two readings ever differed.
//
// The events come off the store family's own builder, which is where this package
// decided what an admitted event looks like. A local one written beside these cases
// would be the third derivation the lease suites' repair already ended once.

import { describe, expect, it } from "vitest";

import { RUN_LIFECYCLE_PROJECTORS } from "../../frame/run-projection/run-lifecycle-projector.js";
import { emptyPartitions } from "../../store/entities.js";
import { EntityProjectionRunner } from "../../store/entity-projection.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import type { ConsoleEntity } from "../../store/index.js";
import { hasSteppableRun } from "./steppable-run-model.js";

const SESSION_ID = "session-1";

/** One run entity as the projector would have written it. */
function runEntity(runId: string, state: string | undefined): ConsoleEntity {
  return { kind: "run", id: runId, ...(state === undefined ? {} : { state }) };
}

/** A run partition holding the given rows, keyed as the store keys them. */
function partitionOf(...runs: readonly ConsoleEntity[]): Readonly<Record<string, ConsoleEntity>> {
  return Object.fromEntries(runs.map((run) => [run.id, run]));
}

/**
 * The `run` partition the real projector produces from these beats.
 *
 * The projection runner and the frame's registered projectors, not a stand-in: the
 * whole claim under test is that this surface reads what the projector admitted, and a
 * local re-implementation of the admission rule would assert only that two copies of
 * it agree.
 */
function projectedRunPartition(
  ...beats: readonly Parameters<typeof eventOfKind>[]
): Readonly<Record<string, ConsoleEntity>> {
  const runner = new EntityProjectionRunner(RUN_LIFECYCLE_PROJECTORS);
  let partitions = emptyPartitions();
  for (const beat of beats) {
    const projected = runner.run(partitions, eventOfKind(...beat));
    expect(projected).toBeDefined();
    partitions = { ...partitions, ...projected };
  }
  return partitions.run;
}

describe("whether a run can be stepped into", () => {
  it("says nothing about a session with no runs", () => {
    expect(hasSteppableRun({})).toBe(false);
  });

  it("reads a running run as steppable", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", "running")))).toBe(true);
  });

  it("stops saying so once the run finishes", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", "completed")))).toBe(false);
  });

  it("stops saying so once the run pauses", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", "paused")))).toBe(false);
  });

  it("stops saying so while a run waits on an approval", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", "waiting_for_approval")))).toBe(false);
  });

  it("keeps saying so while a second run is still going", () => {
    expect(
      hasSteppableRun(partitionOf(runEntity("run-1", "completed"), runEntity("run-2", "running"))),
    ).toBe(true);
  });

  it("does not read a queued run as steppable", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", "queued")))).toBe(false);
  });

  it("says nothing about a run the projection carries no state for", () => {
    expect(hasSteppableRun(partitionOf(runEntity("run-1", undefined)))).toBe(false);
  });

  it("reads a validated running run as steppable", () => {
    const runs = projectedRunPartition([
      SESSION_ID,
      "run.running",
      1,
      { sessionId: SESSION_ID, runId: "run-1", newState: "running" },
    ]);
    expect(runs["run-1"]?.state).toBe("running");
    expect(hasSteppableRun(runs)).toBe(true);
  });

  it("does not read a run.running whose payload contradicts its kind as steppable", () => {
    // The finding. This beat is well-formed to the envelope schema and refused by the
    // projector, so the console holds no running run — and a fold keyed on the kind
    // alone offered a step-in for a run nothing else on screen calls running.
    const runs = projectedRunPartition([
      SESSION_ID,
      "run.running",
      1,
      { sessionId: SESSION_ID, runId: "run-1", newState: "failed" },
    ]);
    expect(runs["run-1"]).toBeUndefined();
    expect(hasSteppableRun(runs)).toBe(false);
  });

  it("does not read a run.running carrying no state as steppable", () => {
    // The quiet half of the same disagreement: absence used to pass the projector and
    // now does not, and a kind-keyed fold never asked in the first place.
    const runs = projectedRunPartition([
      SESSION_ID,
      "run.running",
      1,
      { sessionId: SESSION_ID, runId: "run-1" },
    ]);
    expect(runs["run-1"]).toBeUndefined();
    expect(hasSteppableRun(runs)).toBe(false);
  });

  it("stops saying so once the projector folds the run's terminal", () => {
    const runs = projectedRunPartition(
      [
        SESSION_ID,
        "run.running",
        1,
        { sessionId: SESSION_ID, runId: "run-1", newState: "running" },
      ],
      [
        SESSION_ID,
        "run.completed",
        2,
        { sessionId: SESSION_ID, runId: "run-1", newState: "completed" },
      ],
    );
    expect(hasSteppableRun(runs)).toBe(false);
  });
});
