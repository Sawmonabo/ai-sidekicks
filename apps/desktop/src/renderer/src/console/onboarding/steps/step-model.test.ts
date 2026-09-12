// The step model is fail-closed in both directions.
//
// A completed-step id this build does not recognise is DROPPED rather than guessed
// into a neighbouring step, and a step the daemon does not mention is simply not
// done. Neither direction invents progress, and both are how a newer daemon against
// an older console stays legible rather than confidently wrong.

import { describe, expect, it } from "vitest";

import {
  completedStepsFrom,
  completionStanding,
  firstUnresolvedStep,
  MANDATORY_STEP_GROUP,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEPS,
  ONBOARDING_STEPS_IN_ORDER,
} from "./step-model.js";

describe("the completed-step set", () => {
  it("keeps every id this build knows", () => {
    const completed = completedStepsFrom([...ONBOARDING_STEP_IDS]);
    for (const stepId of ONBOARDING_STEP_IDS) {
      expect(completed.has(stepId)).toBe(true);
    }
  });

  it("drops an id this build does not know rather than guessing at it", () => {
    const completed = completedStepsFrom(["relay", "relays", "provider", "", "PROVIDERS"]);
    expect([...completed]).toStrictEqual(["relay"]);
  });

  it("treats an unmentioned step as not done", () => {
    expect(completedStepsFrom([]).has("relay")).toBe(false);
  });
});

describe("where a resumed walkthrough opens", () => {
  it("opens at the first step nothing says is done", () => {
    expect(firstUnresolvedStep(completedStepsFrom(["relay"]))).toBe("telemetry");
    expect(firstUnresolvedStep(completedStepsFrom(["relay", "telemetry"]))).toBe("providers");
  });

  it("names no step once every one of them is done", () => {
    expect(firstUnresolvedStep(completedStepsFrom([...ONBOARDING_STEP_IDS]))).toBeUndefined();
  });
});

describe("the steps as data", () => {
  it("renders in the order the id tuple declares", () => {
    expect(ONBOARDING_STEPS_IN_ORDER.map((step) => step.id)).toStrictEqual([
      ...ONBOARDING_STEP_IDS,
    ]);
  });

  it("gives every step a label and a summary rather than defaulting to its id", () => {
    for (const stepId of ONBOARDING_STEP_IDS) {
      const step = ONBOARDING_STEPS[stepId];
      expect(step.label).not.toBe(stepId);
      expect(step.summary.length).toBeGreaterThan(20);
    }
  });

  it("makes the provider step the one step that may be left unanswered", () => {
    // Stated as the positive set rather than its complement, because that is the closed
    // set: group B is offered and never demanded, and BOTH group-A steps refuse to be
    // left unanswered — the relay choice by being non-dismissible and telemetry by
    // admitting no silent default.
    const leavable = ONBOARDING_STEPS_IN_ORDER.filter((step) => step.mayBeLeftUnanswered);
    expect(leavable.map((step) => step.id)).toStrictEqual(["providers"]);
  });
});

describe("what holds the completion action", () => {
  /** The held arm's own sentence, so a case asserting about it says which arm it read. */
  function heldReason(...completedStepIds: readonly string[]): string {
    const standing = completionStanding(completedStepsFrom(completedStepIds), false);
    if (standing.kind !== "held") {
      throw new Error(`expected the act to be held, and it was ${standing.kind}`);
    }
    return standing.reason;
  }

  it("names both group-A steps while neither is answered", () => {
    const reason = heldReason();
    expect(reason).toContain(ONBOARDING_STEPS.relay.label);
    expect(reason).toContain(ONBOARDING_STEPS.telemetry.label);
  });

  it("names only the one still outstanding once the other is answered", () => {
    const reason = heldReason("relay");
    expect(reason).toContain(ONBOARDING_STEPS.telemetry.label);
    expect(reason).not.toContain(ONBOARDING_STEPS.relay.label);
  });

  it("holds nothing once both group-A answers are recorded", () => {
    // With the provider step deliberately absent: group B is offered and never
    // demanded, so onboarding completes over a node with no account registered.
    expect(completionStanding(completedStepsFrom(["relay", "telemetry"]), false)).toStrictEqual({
      kind: "offered",
    });
  });

  it("is asked of the group the dismissal lock is asked of, and of no second field", () => {
    // The claim the sentence above rests on: what "mandatory" means here is a step's
    // GROUP, and the steps outside that group hold nothing. A second rule keyed on
    // whether a step may be left would agree today and drift the first time the two
    // diverge.
    const mandatory = ONBOARDING_STEPS_IN_ORDER.filter(
      (step) => step.group === MANDATORY_STEP_GROUP,
    );
    expect(mandatory.map((step) => step.id)).toStrictEqual(["relay", "telemetry"]);
    expect(heldReason("providers")).toBe(heldReason());
  });
});

describe("what retires the completion action", () => {
  it("settles once the daemon's own read reports this node set up", () => {
    // The arm nothing used to read. `onboarding.complete` answering is the daemon
    // accepting the act; THIS is the node having moved, and only it retires the
    // control — which is why the footer cannot offer the act a second time.
    expect(completionStanding(completedStepsFrom(["relay", "telemetry"]), true)).toStrictEqual({
      kind: "settled",
    });
  });

  it("settles over an outstanding group-A step, because the daemon is the authority", () => {
    // The console never re-derives completion from the step set: a node the daemon
    // reports complete is complete, whatever this build makes of the ids it was sent.
    expect(completionStanding(completedStepsFrom([]), true)).toStrictEqual({ kind: "settled" });
  });

  it("offers the act again where the reading has not said so", () => {
    // The negative control for the pair above: `isRecordedComplete` is the only input
    // that reaches the settled arm, so an unanswered read leaves the act exactly where
    // the group-A condition puts it.
    expect(completionStanding(completedStepsFrom(["relay", "telemetry"]), false).kind).toBe(
      "offered",
    );
  });
});
