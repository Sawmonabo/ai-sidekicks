// Do the fixture's four runs actually carry the four states, the two park reasons and
// the frozen pin the surfaces need?
//
// A claim about CONTENT, which no wire-truth predicate can answer: every one of these
// rows is shaped exactly as the contract admits, and a table that shipped four running
// runs would validate perfectly and leave the park banner, the countdown arm and the
// frozen-pin label with no subject anywhere.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import { WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import type { WorkflowPhaseState, WorkflowRunSnapshot } from "../workflow-projection.js";

/** Every phase across every run, so a claim about parks can be made over all of them. */
function everyPhase(): readonly WorkflowPhaseState[] {
  return WORKFLOWS_SCENARIO_RUNS.flatMap((run) => run.phaseStates);
}

/** The phases of one run that are parked right now, read through the wire's own discriminator. */
function parkedPhasesOf(run: WorkflowRunSnapshot): readonly WorkflowPhaseState[] {
  return run.phaseStates.filter((phase) => phase.parkReason !== undefined);
}

/** The one run in a given state, asserted to be the only one so a case cannot pass on a neighbour. */
function soleRunInState(state: WorkflowRunSnapshot["state"]): WorkflowRunSnapshot {
  const matches = WORKFLOWS_SCENARIO_RUNS.filter((run) => run.state === state);
  expect(matches).toHaveLength(1);
  const [only] = matches;
  if (only === undefined) {
    throw new Error(`no run in state ${state}`);
  }
  return only;
}

describe("the workflows scenario — the four runs", () => {
  it("carries one run in each of the four states the surfaces render", () => {
    expect(WORKFLOWS_SCENARIO_RUNS).toHaveLength(4);
    expect(soleRunInState("running").phaseStates.some((phase) => phase.state === "running")).toBe(
      true,
    );
    expect(soleRunInState("cancelled")).toBeDefined();
    // Two runs are suspended — the parked one and the frozen-pin one — which is what
    // gives the attention fold something to fold.
    expect(WORKFLOWS_SCENARIO_RUNS.filter((run) => run.state === "suspended")).toHaveLength(2);
  });

  it("parks nothing on the working run and nothing on the cancelled one", () => {
    // The live-scoping rule, asserted where it is easiest to violate: a settled run
    // that kept a stale park member would render as still waiting forever.
    expect(parkedPhasesOf(soleRunInState("running"))).toStrictEqual([]);
    expect(parkedPhasesOf(soleRunInState("cancelled"))).toStrictEqual([]);
  });

  it("carries both park reasons, and arms a resume on exactly one of them", () => {
    const parked = everyPhase().filter((phase) => phase.parkReason !== undefined);
    const armed = parked.filter((phase) => phase.autoResumeAt !== undefined);
    const humanParks = parked.filter((phase) => phase.parkReason === "waiting-human");

    expect(parked).toHaveLength(3);
    expect(armed).toHaveLength(1);
    expect(humanParks).toHaveLength(1);
    // The unscheduled usage-limit park is the third: a park a banner must read as
    // awaiting resume rather than as scheduled. Without it the fixture could only ever
    // drive the countdown arm.
    expect(
      parked.filter(
        (phase) =>
          phase.parkReason === "provider-usage-limited" && phase.autoResumeAt === undefined,
      ),
    ).toHaveLength(1);
  });

  it("gives every parked phase the cause its reason obliges", () => {
    // `parkCause` is present whenever `parkReason` is, by the producer's own rule. A
    // reason with no cause would render a park with an empty sentence, which reads as
    // an engine that had no reason rather than as a malformed response.
    for (const phase of everyPhase()) {
      expect(phase.parkCause === undefined).toBe(phase.parkReason === undefined);
    }
  });

  it("arms the attention key only where the resume instant is armed beside it", () => {
    // The registered shape gives `parkAttentionKey` the same presence rule as
    // `autoResumeAt`: both are armed by the park and cleared on exit, so a row
    // carrying one without the other is a response no daemon has the state to build.
    // The suite above checks `parkCause` against `parkReason` and checked this pair
    // nowhere — the presence rules were transcribed one member at a time, and a rule
    // that binds TWO members has no home in a per-member loop. That is how a fixture
    // row carrying the key with no instant validated, folded, and screenshotted.
    for (const phase of everyPhase()) {
      expect(phase.parkAttentionKey === undefined, phase.phaseId).toBe(
        phase.autoResumeAt === undefined,
      );
    }
  });

  it("negative control: one park arms both members, so the pair rule is not vacuous", () => {
    // Without this, a table that armed no park anywhere would satisfy the rule above
    // by holding neither member at all — and the countdown arm would have no subject.
    const armed = everyPhase().filter((phase) => phase.autoResumeAt !== undefined);

    expect(armed).toHaveLength(1);
    expect(armed[0]?.parkAttentionKey).toBeDefined();
  });

  it("carries the cancellation reason where the contract puts it", () => {
    const cancelled = soleRunInState("cancelled");

    expect(cancelled.failureReason).toBeDefined();
    expect(cancelled.endedAt).toBeDefined();
    // Completed phase outputs stay addressable on a run that will not move again.
    expect(cancelled.phaseStates.some((phase) => phase.state === "completed")).toBe(true);
  });

  it("pins exactly one run behind its definition's latest version", () => {
    const latestVersionIds = new Set(
      WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.latestWorkflowVersionId),
    );
    const behind = WORKFLOWS_SCENARIO_RUNS.filter(
      (run) => !latestVersionIds.has(run.workflowVersionId),
    );

    expect(behind).toHaveLength(1);
    // The other arm, so the case above is an inequality rather than a table where no
    // run's pin ever matches a definition at all.
    expect(WORKFLOWS_SCENARIO_RUNS.length - behind.length).toBe(3);
  });
});
