// The rows, checked on the two things a derivation owes.
//
//   1. **The park discriminator is `parkReason` and never a phase's `state`.** So the
//      fixtures below deliberately put a park on a `running` phase and a `parkCause`
//      on a phase with no reason — the two shapes a `state`-reading projection gets
//      wrong in opposite directions.
//   2. **The rows really are derived from the wire shape rather than mirrored.** A
//      mirror agrees with its original until the original moves; the case at the
//      bottom drives a WHOLE wire phase through `phasePark` with no adaptation, so a
//      row that stopped being a subset of the substrate's declaration stops compiling
//      here rather than compiling on a vocabulary the wire has left behind.

import { describe, expect, it } from "vitest";

import type { WorkflowPhaseState } from "../bridge/index.js";
import { phasePark, type WorkflowPhaseStateRow } from "./run-list-rows.js";

function phase(overrides: Partial<WorkflowPhaseStateRow> = {}): WorkflowPhaseStateRow {
  return { phaseId: "phase-1", phaseName: "Draft", state: "running", ...overrides };
}

describe("the park discriminator", () => {
  it("reads a park off `parkReason` even on a phase whose state says running", () => {
    const park = phasePark(
      phase({ state: "running", parkReason: "waiting-human", parkCause: "Approval needed." }),
    );
    expect(park?.parkReason).toBe("waiting-human");
  });

  it("negative control: a phase carrying a cause and no reason is not parked", () => {
    // A projection that keyed on any of the other three members would call this
    // parked. `parkCause` is the trap, because the producer emits it whenever it
    // emits a reason, so it looks interchangeable and is not.
    expect(phasePark(phase({ parkCause: "Approval needed." }))).toBeUndefined();
  });

  it("negative control: a phase with no park members at all is not parked", () => {
    expect(phasePark(phase({ state: "pending" }))).toBeUndefined();
  });

  it("carries the armed schedule and the attention key through untouched", () => {
    const park = phasePark(
      phase({
        parkReason: "provider-usage-limited",
        parkCause: "Account allowance spent until 11:30.",
        autoResumeAt: "2026-09-01T11:30:00.000Z",
        parkAttentionKey: "account-7",
      }),
    );
    expect(park?.autoResumeAt).toBe("2026-09-01T11:30:00.000Z");
    expect(park?.parkAttentionKey).toBe("account-7");
  });
});

describe("the rows are a narrowing of the wire shape, not a second one", () => {
  /**
   * A whole wire phase, every member of it — including the four the row drops.
   *
   * Typed as the substrate's own declaration on purpose: this value is the case's
   * subject, and typing it as a row would assert nothing about the wire at all.
   */
  const WIRE_PHASE: WorkflowPhaseState = {
    phaseId: "phase-review",
    phaseRunId: "phase-run-01",
    attemptNumber: 2,
    state: "running",
    gateState: "open",
    formRevision: 0,
    parkReason: "waiting-human",
    parkCause: "Approval needed.",
    parkAttentionKey: "account-7",
  };

  it("reads a park straight off a wire phase, with nothing adapted in between", () => {
    expect(phasePark(WIRE_PHASE)?.parkReason).toBe("waiting-human");
  });

  it("negative control: the wire phase really does carry the members a row drops", () => {
    // Without this the case above would pass over a `WIRE_PHASE` that happened to
    // hold only the six members the row keeps, which proves nothing about the four
    // it does not.
    expect(WIRE_PHASE.gateState).toBe("open");
    expect(WIRE_PHASE.phaseRunId).toBe("phase-run-01");
    expect(WIRE_PHASE.attemptNumber).toBe(2);
    expect(WIRE_PHASE.formRevision).toBe(0);
  });
});
