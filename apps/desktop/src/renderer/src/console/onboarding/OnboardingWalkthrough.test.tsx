// The walkthrough: three steps in a rail, one open, and a footer that can finish.
//
// THE FINISH ACTION IS ALWAYS REACHABLE, which is "offered, never demanded" expressed
// as layout: completing with no provider ready is a legitimate terminal, so the
// summary and its action must not sit behind a step a person has to reach.
//
// THE CONNECTION SEAT RENDERS SCENARIO DATA, NOT A RESERVATION. What comes back from
// the choice window is an identifier and, where the option needed a secret, an opaque
// handle — both facts a person should see. The handle is rendered as PRESENCE and
// never as a value, and the case below is what keeps that true.
//
// AND THE THREE RELAY OPTIONS ARE ALL VISIBLE AT ONCE. Collapsing the third behind an
// advanced control is a named defect, so the count is the assertion.
//
// AND TELEMETRY IS ASKED AFTER THE RELAY CHOICE AND NOT BESIDE IT. That ordering has
// two enforcement points and both are cases here — the rail entry that will not open
// the step, and the control inside it that is not wired to anything — because either
// one alone leaves a way to record an answer to a question the corpus puts second.
// The positive control sits beside them: the scenario records the relay step, so the
// same control on the same step is offered there.
//
// AND THE FINISH ACTION IS REACHABLE WITHOUT BEING PRESSABLE. "Offered, never
// demanded" is group B's rule; group A is demanded, and this footer is on every step,
// so it was the one control that could dispatch `onboarding.complete` from a step
// nobody had answered. The gate has two enforcement points and both are cases here —
// the disabled control with its reason on screen, and the handler that is not wired —
// because the first alone still dispatched in this tier, which is what the telemetry
// pair next door already measured.
//
// AND A PER-PROVIDER ACT RE-RENDERS THE STEP. The readiness model publishes the
// projection and this window's act, and only the first used to be comparable — so an
// act published, React compared a reading that had not moved, and the row's buttons
// stayed enabled with the refusal off screen. What the case asserts is what is ON
// SCREEN after an act that touches no projection.
//
// THAT THE SIGN-IN REMEDY IS HANDED OVER AND NEVER PERFORMED is asserted next door in
// `OnboardingWalkthrough.no-sign-in.test.tsx`, which presses every control this step
// offers and finds the growth port untouched — split off when it took this file
// further past the package's ceiling.
//
// AND BOTH READINGS TAKE THE WINDOW TRIGGER SET. Both models implement
// `ReadTriggerTarget`, and implementing it is not the same as being wired to it: this
// walkthrough once performed the two arrival reads itself, so the contract was
// satisfied, the gate was green, and neither reading ever heard about a window
// regaining focus. The last case below is what makes the difference observable —
// what it asserts is a second call LEAVING this window, not a state on a model.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { withDaemonCall } from "../bridge/fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../bridge/readings/scheduled-read.test-support.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { FrameStore } from "../store/index.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import {
  bridgeWithGroupAAnswered,
  bridgeWithNoRelayChosen,
  bridgeWithStepsDone,
} from "./onboarding-state.test-support.js";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough.js";
import { mountAt } from "./OnboardingWalkthrough.test-support.js";
import { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import { RELAY_METHOD_OPTIONS_IN_ORDER } from "./relay/relay-choice.js";
import { ONBOARDING_STEPS, RESUME_OPENING } from "./steps/step-model.js";

/** The one control that puts a step away without answering it, whatever it reads. */
function dismissControl(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((one) => one.textContent === "Not now");
}

/** A bridge over the given one that counts every write this family can perform. */
function countingWrites(base: ConsoleBridge): {
  readonly bridge: ConsoleBridge;
  writes: () => number;
} {
  let writes = 0;
  const count = <Request, Value>(
    operation: (request: Request) => Promise<Value>,
  ): ((request: Request) => Promise<Value>) => {
    return async (request) => {
      writes += 1;
      return operation(request);
    };
  };
  return {
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        onboardingStepAdvance: count(base.growth.onboardingStepAdvance),
        onboardingStepSkip: count(base.growth.onboardingStepSkip),
        onboardingComplete: count(base.growth.onboardingComplete),
      },
    },
    writes: () => writes,
  };
}

/** The footer's one act, where the footer is offering one at all. */
function findFinishControl(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (one) => one.textContent === "Finish setting up",
  );
}

/** The footer's one act, whatever holds it. */
function finishControl(container: HTMLElement): HTMLButtonElement {
  const control = findFinishControl(container);
  if (control === undefined) {
    throw new Error("the footer offers no finish action");
  }
  return control;
}

/**
 * A node nobody has onboarded, over the fixture's OWN ledger.
 *
 * `bridgeWithNoRelayChosen` replaces the state read outright, so a step this window
 * records never appears in it — which is right for the cases that are about an
 * unsettled node and wrong for the one case that is about a node MOVING. The scenario
 * variant keeps the fixture's fold, so recording the relay step changes what the next
 * read answers, which is the whole of what that case observes.
 */
function freshNodeBridge(): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      ...ONBOARDING_SCENARIO,
      id: `${ONBOARDING_SCENARIO.id}-fresh-node`,
      replies: ONBOARDING_SCENARIO.replies.map((reply) =>
        reply.call === "growth:onboardingStateRead"
          ? { call: reply.call, result: { completedStepIds: [], isComplete: false } }
          : reply,
      ),
    },
  });
}

/** A bridge over the given one that counts what reached `onboarding.complete`. */
function countingCompletions(base: ConsoleBridge): {
  readonly bridge: ConsoleBridge;
  completions: () => number;
} {
  let completions = 0;
  return {
    bridge: {
      ...base,
      growth: {
        ...base.growth,
        onboardingComplete: async (request) => {
          completions += 1;
          return base.growth.onboardingComplete(request);
        },
      },
    },
    completions: () => completions,
  };
}

/** The one control that puts the telemetry question, whatever it currently reads. */
function telemetryPromptControl(container: HTMLElement): HTMLButtonElement {
  const control = [...container.querySelectorAll("button")].find((one) =>
    (one.textContent ?? "").startsWith("Answer"),
  );
  if (control === undefined) {
    throw new Error("the telemetry step offers no control that puts the question");
  }
  return control;
}

describe("the rail", () => {
  it("lists every step and says which are done, from the daemon's own set", async () => {
    const text = (await mountAt("relay")).textContent ?? "";
    expect(text).toContain("Where this node relays");
    expect(text).toContain("Telemetry");
    expect(text).toContain("Providers");
    // The scenario records the relay step and nothing else, so the rail shows a mixed
    // state rather than three identical entries.
    expect(text).toContain("Done");
    expect(text).toContain("Not done");
  });
});

describe("the relay step", () => {
  it("shows all three options with their consequence and their inputs", async () => {
    const text = (await mountAt("relay")).textContent ?? "";
    for (const option of RELAY_METHOD_OPTIONS_IN_ORDER) {
      expect(text).toContain(option.label);
      expect(text).toContain(option.consequence);
      expect(text).toContain(option.inputs);
    }
  });

  it("offers one action and collects nothing", async () => {
    const container = await mountAt("relay");
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
    // The scenario records this step as done, so the action reads as a change rather
    // than as a first answer — the step stays reachable after it has been settled.
    expect(labels).toContain("Choose a different relay");
  });

  it("mounts a fixture shell rather than a reservation once a choice resolves", async () => {
    const container = await mountAt("relay");
    const choose = [...container.querySelectorAll("button")].find(
      (one) => one.textContent === "Choose a different relay",
    );
    await act(async () => {
      choose?.click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    const text = container.textContent ?? "";
    // The scenario answers `self-host` with a handle, so the seat renders the
    // consequence of the option in force and the PRESENCE of the secret.
    expect(text).toContain("A credential for this relay is held by the host process");
    // And never the handle itself, which names a value this window may not read.
    expect(text).not.toContain("keystore:relay-join-token");
  });
});

describe("the telemetry step", () => {
  it("states what is collected, what is not, and how to change it later", async () => {
    const text = (await mountAt("telemetry")).textContent ?? "";
    expect(text).toContain("Counts of errors by class");
    expect(text).toContain("Anything said or written in a session");
    expect(text).toContain("sidekicks telemetry set off");
    expect(text).toContain("Telemetry is off unless it is turned on here");
  });

  it("offers the question once the relay choice is settled", async () => {
    // The scenario records the relay step, so this is the positive control for the
    // pair below: the same step, the same control, and nothing holding it.
    const container = await mountAt("telemetry");
    expect(telemetryPromptControl(container).disabled).toBe(false);
  });
});

describe("the telemetry step before the relay choice resolves", () => {
  it("refuses the question, and says which step it is waiting on", async () => {
    // `Spec-026 §Telemetry Opt-In` puts this question after the relay choice
    // resolves. An answer recorded ahead of it is the one thing here nothing can take
    // back — the question has been asked and answered — so the control is withdrawn
    // rather than merely discouraged, and the reason is on screen.
    const container = await mountAt("telemetry", bridgeWithNoRelayChosen());
    expect(telemetryPromptControl(container).disabled).toBe(true);
    // Scoped to the step, because the rail names every step on every render and an
    // assertion over the whole container would pass without the pane saying anything.
    const step = container.querySelector(
      `section[aria-label="${ONBOARDING_STEPS.telemetry.label}"]`,
    );
    expect(step?.textContent ?? "").toContain(ONBOARDING_STEPS.relay.label);
  });

  it("puts no question when that control is pressed anyway", async () => {
    // The claim the disabled attribute cannot make on its own: no handler is wired,
    // so nothing reaches `onboarding.telemetryPrompt` however the press arrives.
    const base = bridgeWithNoRelayChosen();
    let promptsPut = 0;
    const counted: ConsoleBridge = {
      ...base,
      growth: {
        ...base.growth,
        onboardingTelemetryPrompt: async (request) => {
          promptsPut += 1;
          return base.growth.onboardingTelemetryPrompt(request);
        },
      },
    };
    const container = await mountAt("telemetry", counted);
    await act(async () => {
      telemetryPromptControl(container).click();
      await crossMacrotaskBoundary();
    });
    expect(promptsPut).toBe(0);
  });

  it("keeps the rail from opening the step at all, with the reason on the entry", async () => {
    // The other half of the gate. A rail that let a person in and a pane that then
    // refused would be one rule stated twice; this asserts the entry itself is shut,
    // and that what it says is the reason rather than only "Not done".
    const container = await mountAt("relay", bridgeWithNoRelayChosen());
    const railEntry = [...container.querySelectorAll("button")].find((one) =>
      (one.textContent ?? "").startsWith(ONBOARDING_STEPS.telemetry.label),
    );
    expect(railEntry).toBeDefined();
    expect(railEntry?.disabled).toBe(true);
    expect(railEntry?.textContent ?? "").toContain(ONBOARDING_STEPS.relay.label);
  });
});

describe("the footer", () => {
  it("offers the finish action on every step, and names who is not ready", async () => {
    for (const step of ["relay", "telemetry", "providers"] as const) {
      const container = await mountAt(step);
      const labels = [...container.querySelectorAll("button")].map((one) => one.textContent);
      expect(labels, step).toContain("Finish setting up");
      expect(container.textContent, step).toContain("These providers are not ready");
      expect(container.textContent, step).toContain("codex");
    }
  });
});

describe("finishing before group A is answered", () => {
  it("finishes once both group-A answers are recorded, with no provider ready", async () => {
    // The positive control, and it is also the "offered, never demanded" claim: group
    // B is untouched on this node and completion is still offered.
    const counted = countingCompletions(bridgeWithGroupAAnswered());
    const container = await mountAt("providers", counted.bridge);
    const finish = finishControl(container);
    expect(finish.disabled).toBe(false);
    await act(async () => {
      finish.click();
      await crossMacrotaskBoundary();
    });
    expect(counted.completions()).toBe(1);
  });

  it("holds the action and says which answers are outstanding", async () => {
    const container = await mountAt("providers", bridgeWithNoRelayChosen());
    expect(finishControl(container).disabled).toBe(true);
    // Scoped to the footer, because the rail names every step on every render and an
    // assertion over the whole container would pass without the footer saying anything.
    const footer = container.querySelector('section[aria-label="Finish setting up"]');
    const said = footer?.textContent ?? "";
    expect(said).toContain(ONBOARDING_STEPS.relay.label);
    expect(said).toContain(ONBOARDING_STEPS.telemetry.label);
  });

  it("completes nothing when that control is pressed anyway", async () => {
    // The claim the disabled attribute cannot make on its own: no handler is wired, so
    // nothing reaches `onboarding.complete` however the press arrives — and a daemon
    // that accepted one would record this node as set up over two questions never put.
    const counted = countingCompletions(bridgeWithNoRelayChosen());
    const container = await mountAt("providers", counted.bridge);
    await act(async () => {
      finishControl(container).click();
      await crossMacrotaskBoundary();
    });
    expect(counted.completions()).toBe(0);
  });

  it("still holds it where only the relay half is answered", async () => {
    // The shipped scenario's own node: the relay step recorded and telemetry not, which
    // `Spec-026 §Telemetry Opt-In` refuses to proceed past without an explicit answer.
    const container = await mountAt("providers");
    expect(finishControl(container).disabled).toBe(true);
    const footer = container.querySelector('section[aria-label="Finish setting up"]');
    expect(footer?.textContent ?? "").toContain(ONBOARDING_STEPS.telemetry.label);
  });
});

describe("a per-provider act", () => {
  it("re-renders the step, though the projection behind it has not moved", async () => {
    // A probe that never settles: the only publish is `rechecking`, so nothing has
    // replaced the reading object. Under a subscription to the projection alone React
    // compared an unmoved value and rendered nothing, leaving the row's controls
    // enabled and any refusal off screen.
    const neverSettles = new Promise<never>(() => undefined);
    const { bridge } = withDaemonCall(
      createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
      async (call, passThrough) =>
        call.method === "providerAccount.probe" ? neverSettles : passThrough(),
    );
    const container = await mountAt("providers", bridge);
    const recheck = [...container.querySelectorAll("button")].find(
      (one) => one.textContent === "Check again",
    );
    expect(recheck).toBeDefined();
    expect(container.textContent ?? "").not.toContain("Checking this account again");

    await act(async () => {
      recheck?.click();
      await crossMacrotaskBoundary();
    });

    expect(container.textContent ?? "").toContain("Checking this account again");
    // And the control the act took away, which is the half a stale render leaves
    // pressable: a second press would put a second probe.
    expect(recheck?.disabled).toBe(true);
  });
});

describe("the window trigger set", () => {
  it("re-reads both node-scoped readings when the window regains focus", async () => {
    const held = withDaemonCall(
      createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
      async (_call, passThrough) => passThrough(),
    );
    // The flow reads through the growth port and the readiness model through the
    // daemon door, so counting one would prove the wiring of one. Delegating to the
    // real operation rather than answering for it keeps the walkthrough reading the
    // scenario's own state, which is what every other case here depends on.
    let stateReadCount = 0;
    const bridge: ConsoleBridge = {
      ...held.bridge,
      growth: {
        ...held.bridge.growth,
        onboardingStateRead: async (request) => {
          stateReadCount += 1;
          return held.bridge.growth.onboardingStateRead(request);
        },
      },
    };
    const readinessReadCount = (): number =>
      held.calls.filter((call) => call.method === "providerAccount.list").length;

    render(
      <OnboardingWalkthrough
        flow={new OnboardingFlow(bridge)}
        readiness={new ProviderReadinessModel(bridge, new FrameStore())}
        openAtStep="providers"
        onOpenAccountRegistry={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(stateReadCount).toBe(1);
    expect(readinessReadCount()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await crossMacrotaskBoundary();
    });
    // Both go through the scheduler on this reason, so the frozen clock has to reach
    // the window's deadline before either read is performed.
    await settleScheduledRead(bridge);

    expect(stateReadCount).toBe(2);
    expect(readinessReadCount()).toBe(2);
  });
});

describe("leaving the provider step", () => {
  it("puts it away without telling the daemon anything", async () => {
    // `Spec-026 §Provider Authentication (Group B)` has that group persist "no config
    // key, no partial-state entry, no keystore entry, and no event". The control here
    // used to dispatch `onboarding.stepSkip`, which wrote the provider step into the
    // daemon's own completed set — a second record of a step whose truth lives in the
    // account registry, and one that stayed true after every account was signed out.
    // What is asserted is every write this family can perform, rather than the one
    // method the defect happened to use.
    const counted = countingWrites(createFixtureBridge({ scenario: ONBOARDING_SCENARIO }));
    let dismissals = 0;
    const container = await mountAt("providers", counted.bridge, {
      handler: () => {
        dismissals += 1;
      },
    });

    const dismiss = dismissControl(container);
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss?.click();
      await crossMacrotaskBoundary();
    });

    expect(counted.writes()).toBe(0);
    // And it did the one thing it is for: the activation is put away locally.
    expect(dismissals).toBe(1);
  });

  it("says what pressing it does and does not do", async () => {
    const container = await mountAt("providers");
    expect(container.textContent ?? "").toContain("Not now simply puts this away");
  });

  it("offers no way out where the surface holding it refuses to close", async () => {
    // The lock is the overlay's, and this is the walkthrough honouring it: a control
    // offered over a dialog that will not close is a control that does nothing.
    const container = await mountAt("providers", undefined, { handler: undefined });
    expect(dismissControl(container)).toBeUndefined();
  });

  it("offers it on no step the model holds to an answer", async () => {
    for (const step of ["relay", "telemetry"] as const) {
      const container = await mountAt(step);
      expect(dismissControl(container), step).toBeUndefined();
    }
  });
});

describe("where a resume activation opens", () => {
  it("opens at the first step the daemon says is unresolved, not at the first step", async () => {
    // The regression itself. The collaboration command fires before this window has
    // necessarily read anything, so a step chosen at press time was chosen from a
    // snapshot reporting nothing done — `relay`, on a node that had settled it.
    const container = await mountAt(RESUME_OPENING, bridgeWithStepsDone("relay"));
    const title = container.querySelector(".meridian-onboarding__title");
    expect(title?.textContent).toBe(ONBOARDING_STEPS.telemetry.label);
  });

  it("opens at the first step where the daemon says nothing is done", async () => {
    // The other end of the same reading, so the case above is not passing on a
    // constant: a node nobody has set up still opens where it always did.
    const container = await mountAt(RESUME_OPENING, bridgeWithNoRelayChosen());
    const title = container.querySelector(".meridian-onboarding__title");
    expect(title?.textContent).toBe(ONBOARDING_STEPS.relay.label);
  });

  it("leaves a named opening exactly where it was asked to open", async () => {
    // The negative control for the pair above: only `resume` reads the completed set,
    // so the two group-B openings land on their own step whatever the node has settled.
    const container = await mountAt("providers", bridgeWithStepsDone("relay"));
    const title = container.querySelector(".meridian-onboarding__title");
    expect(title?.textContent).toBe(ONBOARDING_STEPS.providers.label);
  });

  it("stays on the step a person is looking at when their own act settles it", async () => {
    // Resolved ONCE. This node has nothing recorded, so the walkthrough opens at the
    // relay step; choosing a relay records that step and re-reads, and a pane that
    // re-derived its opening on every read would move to telemetry mid-confirmation —
    // taking the answer the person just gave off screen.
    const container = await mountAt(RESUME_OPENING, freshNodeBridge());
    const choose = [...container.querySelectorAll("button")].find(
      (one) => one.textContent === "Choose where this node relays",
    );
    expect(choose).toBeDefined();
    await act(async () => {
      choose?.click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    const title = container.querySelector(".meridian-onboarding__title");
    expect(title?.textContent).toBe(ONBOARDING_STEPS.relay.label);
    // And the confirmation it stayed for is on screen.
    expect(container.textContent ?? "").toContain(
      "A credential for this relay is held by the host process",
    );
  });
});

describe("a node the daemon reports as set up", () => {
  it("renders a terminal and offers the act no more", async () => {
    // What used to happen: `onboardingComplete` answered, the in-flight flag cleared,
    // and the same button came back live — so a second press dispatched the same act
    // again over a node already recorded as set up. The control retires on the READ.
    const container = await mountAt("providers", bridgeWithGroupAAnswered());
    expect(finishControl(container).disabled).toBe(false);

    await act(async () => {
      finishControl(container).click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });

    expect(findFinishControl(container)).toBeUndefined();
    expect(container.textContent ?? "").toContain("This node is set up");
  });

  it("keeps saying which providers are not ready", async () => {
    // `Spec-026`'s completion posture: what a person leaves with is the standing, and
    // it is as true after finishing as it was before.
    const container = await mountAt("providers", bridgeWithGroupAAnswered());
    await act(async () => {
      finishControl(container).click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(container.textContent ?? "").toContain("These providers are not ready");
  });

  it("still offers the act where the read has not said so — the negative control", async () => {
    // Without this the pair above would pass over a footer that simply never offers
    // the act. The same node, the same press, and a state read that keeps reporting
    // this node unfinished: the control comes back.
    const counted = countingCompletions(bridgeWithGroupAAnswered());
    const unfoldedBridge: ConsoleBridge = {
      ...counted.bridge,
      growth: {
        ...counted.bridge.growth,
        onboardingStateRead: async () => ({
          status: "served",
          value: { completedStepIds: ["relay", "telemetry"], isComplete: false },
        }),
      },
    };
    const container = await mountAt("providers", unfoldedBridge);
    await act(async () => {
      finishControl(container).click();
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(counted.completions()).toBe(1);
    expect(findFinishControl(container)?.disabled).toBe(false);
  });
});
