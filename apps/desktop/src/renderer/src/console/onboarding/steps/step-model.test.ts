// The step model is fail-closed in both directions.
//
// A completed-step id this build does not recognise is DROPPED rather than guessed
// into a neighbouring step, and a step the daemon does not mention is simply not
// done. Neither direction invents progress, and both are how a newer daemon against
// an older console stays legible rather than confidently wrong.

import { describe, expect, it } from "vitest";

import {
  completedStepsFrom,
  completionBlockedReason,
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

  it("makes the provider step the one step that can be skipped", () => {
    // Stated as the positive set rather than its complement, because that is the set
    // `Spec-026` closes: group B is offered and never demanded, and BOTH group-A
    // steps refuse to be left unanswered — the relay choice by being non-dismissible
    // and telemetry by admitting no silent default.
    const skippable = ONBOARDING_STEPS_IN_ORDER.filter((step) => step.isSkippable);
    expect(skippable.map((step) => step.id)).toStrictEqual(["providers"]);
  });
});

describe("what holds the completion action", () => {
  it("names both group-A steps while neither is answered", () => {
    const reason = completionBlockedReason(completedStepsFrom([]));
    expect(reason).toBeDefined();
    expect(reason).toContain(ONBOARDING_STEPS.relay.label);
    expect(reason).toContain(ONBOARDING_STEPS.telemetry.label);
  });

  it("names only the one still outstanding once the other is answered", () => {
    const reason = completionBlockedReason(completedStepsFrom(["relay"]));
    expect(reason).toContain(ONBOARDING_STEPS.telemetry.label);
    expect(reason).not.toContain(ONBOARDING_STEPS.relay.label);
  });

  it("holds nothing once both group-A answers are recorded", () => {
    // With the provider step deliberately absent: group B is offered and never
    // demanded, so onboarding completes over a node with no account registered.
    expect(completionBlockedReason(completedStepsFrom(["relay", "telemetry"]))).toBeUndefined();
  });

  it("is asked of the group the dismissal lock is asked of, and of no second field", () => {
    // The claim the sentence above rests on: what "mandatory" means here is a step's
    // GROUP, and the steps outside that group hold nothing. A second rule keyed on
    // skippability would agree today and drift the first time the two diverge.
    const mandatory = ONBOARDING_STEPS_IN_ORDER.filter(
      (step) => step.group === MANDATORY_STEP_GROUP,
    );
    expect(mandatory.map((step) => step.id)).toStrictEqual(["relay", "telemetry"]);
    expect(completionBlockedReason(completedStepsFrom(["providers"]))).toBe(
      completionBlockedReason(completedStepsFrom([])),
    );
  });
});
