// Which settlement a row is in, and the one refusal that ends the run rather than
// the act.
//
// Driven on the records directly rather than through a mounted row: the reading is a
// walk over what the surface holds, and the two claims — newest settlement wins, and
// only `run.not_found` means gone — are both about that walk.

import { describe, expect, it } from "vitest";

import { refuse } from "../../../core/index.js";
import { goneRunIds, readRunControlSettlement } from "./run-control-reading.js";
import type { RunControlAck } from "@ai-sidekicks/contracts";
import { type RunControlOutcome } from "./run-control-dispatch.js";
import { type RunControlRecord, type RunControlSurface } from "./run-control-surface.js";

const FIRST_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const SECOND_RUN = "c4a1b2d3-5e6f-4071-8b82-0d3e4f506172";

function refusedRecord(runId: string, code: string, recordId: string): RunControlRecord {
  return {
    recordId,
    runId,
    control: "pause",
    composite: false,
    outcome: { kind: "refused", control: "pause", refusal: refuse("run-control", code, "…") },
  };
}

function acknowledgedRecord(runId: string, recordId: string): RunControlRecord {
  const outcome: RunControlOutcome = {
    kind: "acknowledged",
    control: "pause",
    ack: { runId, currentState: "paused", runVersion: 8 } as RunControlAck,
  };
  return { recordId, runId, control: "pause", composite: false, outcome };
}

/** A surface holding exactly the records a case is about. Nothing else is read. */
function surfaceHolding(records: readonly RunControlRecord[]): RunControlSurface {
  return {
    dispatcher: {} as RunControlSurface["dispatcher"],
    records,
    inFlightKeys: new Set<string>(),
    dispatch: () => ({ admitted: true, dispatchToken: "token" }),
  };
}

describe("which settlement the row is in", () => {
  it("answers with the newest settlement for this run and no earlier one", () => {
    // A refusal superseded by a control that worked is not what the row is in, and
    // leaving it up would report a state the daemon has moved past.
    const surface = surfaceHolding([
      refusedRecord(FIRST_RUN, "run.version_conflict", "one"),
      acknowledgedRecord(FIRST_RUN, "two"),
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).refusal).toBeUndefined();
  });

  it("reads past another run's newer settlement to reach this run's own", () => {
    const surface = surfaceHolding([
      refusedRecord(FIRST_RUN, "run.version_conflict", "one"),
      acknowledgedRecord(SECOND_RUN, "two"),
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).refusal?.code).toBe("run.version_conflict");
  });

  it("answers with nothing for a run this surface has never dispatched against", () => {
    const surface = surfaceHolding([acknowledgedRecord(FIRST_RUN, "one")]);
    const reading = readRunControlSettlement(surface, SECOND_RUN);

    expect(reading.refusal).toBeUndefined();
    expect(reading.isGone).toBe(false);
  });
});

describe("the one refusal that means the run is gone", () => {
  it("reads `run.not_found` as gone", () => {
    const surface = surfaceHolding([refusedRecord(FIRST_RUN, "run.not_found", "one")]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(true);
  });

  it.each([
    ["a stale comparand", "run.version_conflict"],
    ["a transition the run does not admit", "run.invalid_transition"],
    ["a driver that cannot do it", "driver.capability_unsupported"],
    ["a vanished session", "session.not_found"],
  ])("negative control: %s leaves the run there", (_name, code) => {
    // Every other refusal is about the ACT. The same control may work on the next
    // press, and withdrawing the strip for one would take away a control that works.
    const surface = surfaceHolding([refusedRecord(FIRST_RUN, code, "one")]);
    const reading = readRunControlSettlement(surface, FIRST_RUN);

    expect(reading.refusal?.code).toBe(code);
    expect(reading.isGone).toBe(false);
  });

  it("stops being gone once a later control on that run settled another way", () => {
    // Not a hypothetical: the daemon answering `run.not_found` and then answering at
    // all is a disagreement, and the newest answer is the one the row is in.
    const surface = surfaceHolding([
      refusedRecord(FIRST_RUN, "run.not_found", "one"),
      acknowledgedRecord(FIRST_RUN, "two"),
    ]);

    expect(readRunControlSettlement(surface, FIRST_RUN).isGone).toBe(false);
  });
});

describe("every gone run, as one set", () => {
  it("names each run whose newest settlement said so, once", () => {
    const surface = surfaceHolding([
      refusedRecord(FIRST_RUN, "run.not_found", "one"),
      refusedRecord(FIRST_RUN, "run.not_found", "two"),
      refusedRecord(SECOND_RUN, "run.version_conflict", "three"),
    ]);

    expect([...goneRunIds(surface)]).toStrictEqual([FIRST_RUN]);
  });

  it("names nobody on a surface that has settled nothing", () => {
    expect([...goneRunIds(surfaceHolding([]))]).toStrictEqual([]);
  });
});
