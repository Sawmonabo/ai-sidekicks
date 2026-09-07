// The walkthrough's conversation with the daemon, over the fixture that scripts it.
//
// FOUR CLAIMS, AND EACH ONE IS A SHAPE THE FLOW MUST NOT TAKE. A read that REJECTED
// must not leave the walkthrough loading forever. A relay identifier this build does
// not recognise must not be recorded as the nearest of the three. A settlement that
// arrives after the flow was retired must publish nowhere. And a build whose
// onboarding wire is unregistered must render the refusal rather than an empty
// progress list — "nobody has onboarded this node" and "this build cannot ask" are
// different facts.
//
// AND A FIFTH GROUP IS ABOUT THE ORDER TWO REPLIES LAND IN, which no single call can
// state. Every read answers the same question, so an older reply arriving late is not
// extra information — it is the state as it was, and publishing it takes the rail
// backwards past a step the person has already recorded. Three cases pin the three
// ways that happens: two reads racing, a read overtaken by an act, and a read landing
// on top of a refusal a person is owed.
//
// AND A SIXTH, WHICH IS ABOUT THE VALUE RATHER THAN THE CALL. The completed set every
// surface stands on is minted where the reading is published, and the last suite is
// what keeps it from becoming a shared one again: `ReadonlySet` is a compile-time view
// of a runtime-mutable collection, so a single held object is one stray `add` away
// from contaminating the baseline of every later activation in the renderer — a
// contamination that outlives the window, since nothing at module scope is ever
// retired. What the cases assert is IDENTITY and the absence of carry-over, which a
// type cannot state.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import { bridgeWithGroupAAnswered } from "./onboarding-state.test-support.js";
import { firstUnresolvedStep } from "./steps/step-model.js";
import type { ConsoleScenario } from "../bridge/scenario-runtime/index.js";

function flowOver(scenario: ConsoleScenario): OnboardingFlow {
  return new OnboardingFlow(createFixtureBridge({ scenario }));
}

/** One answer a held state read resolves with. The shape the read's own signature has. */
interface HeldStateAnswer {
  readonly completedStepIds: readonly string[];
  readonly isComplete: boolean;
}

/**
 * A bridge whose state reads answer in whatever order the case chooses.
 *
 * THE ANSWERS ARE THE CASE'S AND NOT THE FIXTURE'S, deliberately. What is under test
 * is the flow's own ordering, so each read is given the reading it would have got at
 * the moment it was DISPATCHED — the point being that one of them is stale by the time
 * it lands. Driving this through the fixture's own recorded state would make the case
 * depend on which of two in-flight calls the frozen clock released first, which is the
 * one thing it must not be sensitive to.
 *
 * Every gate exists before any read starts, so a case may open one for a read that has
 * not been dispatched yet: opening is a statement about ORDER and never about timing,
 * and a case that had to wait for a read to arrive before releasing it would be a poll
 * loop dressed as a test.
 */
function heldStateReads(
  answers: readonly HeldStateAnswer[],
  scenario: ConsoleScenario = ONBOARDING_SCENARIO,
): { readonly bridge: ConsoleBridge; readonly release: (index: number) => void } {
  const fixture = createFixtureBridge({ scenario });
  const gates = answers.map(() => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open: (): void => open() };
  });
  let dispatchedReadCount = 0;
  const bridge: ConsoleBridge = {
    ...fixture,
    growth: {
      ...fixture.growth,
      onboardingStateRead: async () => {
        const index = dispatchedReadCount;
        dispatchedReadCount += 1;
        const gate = gates[index];
        const answer = answers[index];
        if (gate === undefined || answer === undefined) {
          // Named rather than resolved with whatever the last answer was: a case that
          // read more times than it scripted is asserting against an order it never
          // stated, and the failure should say so.
          throw new Error(`state read ${index + 1} is not scripted by this case`);
        }
        await gate.opened;
        return { status: "served", value: answer };
      },
    },
  };
  return {
    bridge,
    release: (index: number): void => {
      gates[index]?.open();
    },
  };
}

/** The onboarding scenario with one call left unscripted, so that call refuses. */
function scenarioWithout(call: string): ConsoleScenario {
  return {
    ...ONBOARDING_SCENARIO,
    id: `${ONBOARDING_SCENARIO.id}-without-${call}`,
    replies: ONBOARDING_SCENARIO.replies.filter((reply) => reply.call !== call),
  };
}

describe("reading where this node is", () => {
  it("reads the scripted progress and narrows it to steps this build knows", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.read();
    const { reading } = flow.snapshot;
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") {
      return;
    }
    expect([...reading.completed]).toStrictEqual(["relay"]);
    expect(reading.isComplete).toBe(false);
  });

  it("renders a refusal on a build whose onboarding wire is unregistered", async () => {
    // The refusal a SHIPPED build answers with, since no daemon registers these five
    // methods. Without this the walkthrough would render an empty progress list on
    // every such build — a claim about the node that nothing checked.
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const unregistered: ConsoleBridge = {
      ...fixture,
      growth: {
        ...fixture.growth,
        onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
      },
    };
    const flow = new OnboardingFlow(unregistered);
    await flow.read();
    const { reading } = flow.snapshot;
    expect(reading.kind).toBe("unreadable");
    if (reading.kind !== "unreadable") {
      return;
    }
    expect(reading.refusal.code).toBe("wire-unregistered");
  });
});

describe("the relay choice", () => {
  it("records the step once a recognised identifier comes back", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.presentRelayChoice();
    const { relayChoice } = flow.snapshot;
    expect(relayChoice).toStrictEqual({
      kind: "chosen",
      methodId: "self-host",
      // Carried as a VALUE: `Spec-026 §Persistence` keeps the relay address in
      // plaintext config, and the connection body displays it rather than describing
      // it — which is the opposite disposition from the handle beside it.
      relayUrl: "https://relay.internal.example/",
      hasCredentialHandle: true,
    });
  });

  it("records nothing for an identifier this build does not recognise", async () => {
    const flow = flowOver({
      ...ONBOARDING_SCENARIO,
      replies: ONBOARDING_SCENARIO.replies.map((reply) =>
        reply.call === "growth:onboardingPresentChoice"
          ? {
              call: reply.call,
              result: { relayMethodId: "byo-relay", credentialHandle: undefined },
            }
          : reply,
      ),
    });
    await flow.presentRelayChoice();
    expect(flow.snapshot.relayChoice).toStrictEqual({
      kind: "unrecognised",
      reportedId: "byo-relay",
    });
  });

  it("renders the refusal a rejected call carried, rather than staying in flight", async () => {
    const flow = flowOver({
      ...ONBOARDING_SCENARIO,
      replies: ONBOARDING_SCENARIO.replies.map((reply) =>
        reply.call === "growth:onboardingPresentChoice"
          ? {
              call: reply.call,
              refusal: { code: "onboarding.already_resolved", message: "A choice is recorded." },
            }
          : reply,
      ),
    });
    await flow.presentRelayChoice();
    const { relayChoice } = flow.snapshot;
    expect(relayChoice.kind).toBe("refused");
    if (relayChoice.kind !== "refused") {
      return;
    }
    expect(relayChoice.refusal.code).toBe("onboarding.already_resolved");
  });
});

describe("the telemetry question", () => {
  it("records the answer it was given, and never a default", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    await flow.presentTelemetryPrompt();
    expect(flow.snapshot.telemetry).toStrictEqual({ kind: "answered", enabled: false });
  });
});

describe("supersession", () => {
  it("publishes nothing after the walkthrough was retired", async () => {
    const flow = flowOver(ONBOARDING_SCENARIO);
    const pending = flow.read();
    flow.supersede();
    await pending;
    // Still the opening state: the settlement belonged to a walkthrough that is gone.
    expect(flow.snapshot.reading).toStrictEqual({ kind: "reading" });
  });
});

describe("the order two state reads land in", () => {
  const OPENING_ANSWER: HeldStateAnswer = { completedStepIds: ["relay"], isComplete: false };
  const POST_ACT_ANSWER: HeldStateAnswer = {
    completedStepIds: ["relay", "telemetry"],
    isComplete: false,
  };

  it("discards an opening read that lands after the act it was started before", async () => {
    // The regression itself. The opening read was dispatched against this node as it
    // was before the step was recorded, so its reply is not late news — it is the
    // previous state, and publishing it takes the rail back to a step the person has
    // already answered and leaves them pressing the same control again.
    const { bridge, release } = heldStateReads([OPENING_ANSWER, POST_ACT_ANSWER]);
    const flow = new OnboardingFlow(bridge);

    const openingRead = flow.read();
    const recorded = flow.advance("telemetry");
    release(1);
    await recorded;
    expect([...flow.snapshot.completedSteps].sort()).toStrictEqual(["relay", "telemetry"]);

    release(0);
    await openingRead;

    expect([...flow.snapshot.completedSteps].sort()).toStrictEqual(["relay", "telemetry"]);
    expect(firstUnresolvedStep(flow.snapshot.completedSteps)).toBe("providers");
  });

  it("discards an older read that lands after a newer one, with no act between", async () => {
    // The same rule without an act to blame it on: two reads answer one question, so
    // the newest reply is the answer and the older one has nothing left to say.
    const { bridge, release } = heldStateReads([OPENING_ANSWER, POST_ACT_ANSWER]);
    const flow = new OnboardingFlow(bridge);

    const older = flow.read();
    const newer = flow.read();
    release(1);
    await newer;
    release(0);
    await older;

    expect([...flow.snapshot.completedSteps].sort()).toStrictEqual(["relay", "telemetry"]);
  });

  it("keeps a refused act's refusal in front of a read that started before it", async () => {
    // The arm no re-read follows, which is why the act retires the read key at its own
    // SETTLEMENT rather than leaving the next read to do it: nothing here supersedes
    // the opening read except the act, and a person owed a refusal must not have it
    // quietly replaced by a progress list.
    const { bridge, release } = heldStateReads(
      [OPENING_ANSWER],
      scenarioWithout("growth:onboardingComplete"),
    );
    const flow = new OnboardingFlow(bridge);

    const openingRead = flow.read();
    await flow.complete();
    expect(flow.snapshot.reading.kind).toBe("unreadable");

    release(0);
    await openingRead;

    expect(flow.snapshot.reading.kind).toBe("unreadable");
  });
});

describe("the completed-step baseline", () => {
  it("hands two flows collections that are not the same object", async () => {
    // The claim a module-level `new Set()` could not make. Two activations of this
    // walkthrough get two baselines, so nothing one of them does can be waiting for
    // the next.
    const first = flowOver(ONBOARDING_SCENARIO);
    const second = flowOver(ONBOARDING_SCENARIO);
    expect(first.snapshot.completedSteps).not.toBe(second.snapshot.completedSteps);
  });

  it("mints a fresh one on every reading publish, so no publish shares the last one", async () => {
    const fixture = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
    const unregistered: ConsoleBridge = {
      ...fixture,
      growth: {
        ...fixture.growth,
        onboardingStateRead: async () => growthUnavailable("onboardingStateRead"),
      },
    };
    const flow = new OnboardingFlow(unregistered);
    const atOpen = flow.snapshot.completedSteps;
    await flow.read();
    // The refusal arm reports nothing done, exactly as the opening state does — and
    // it says so with its own value rather than by handing back the one it was given.
    expect(flow.snapshot.reading.kind).toBe("unreadable");
    expect([...flow.snapshot.completedSteps]).toStrictEqual([]);
    expect(flow.snapshot.completedSteps).not.toBe(atOpen);
  });

  it("keeps a mutation of one flow's baseline out of the next flow's", async () => {
    // The contamination itself, performed. `ReadonlySet` is the compile-time view, so
    // the cast is what a stray line of renderer code would do by accident — and the
    // point is that the damage stops at the flow that took it.
    const first = flowOver(ONBOARDING_SCENARIO);
    (first.snapshot.completedSteps as Set<"relay">).add("relay");

    const second = flowOver(ONBOARDING_SCENARIO);
    expect([...second.snapshot.completedSteps]).toStrictEqual([]);
    // And the consequence a person would have met: a resumed walkthrough opening past
    // the step nobody answered.
    expect(firstUnresolvedStep(second.snapshot.completedSteps)).toBe("relay");
  });

  it("carries the answered arm's own set rather than a copy of it", async () => {
    // The projection is not a second record: on the read arm it IS what the narrowing
    // produced, so there is no second place for the two to disagree.
    const flow = new OnboardingFlow(bridgeWithGroupAAnswered());
    await flow.read();
    const { reading, completedSteps } = flow.snapshot;
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") {
      return;
    }
    expect(completedSteps).toBe(reading.completed);
    expect([...completedSteps].sort()).toStrictEqual(["relay", "telemetry"]);
  });
});
