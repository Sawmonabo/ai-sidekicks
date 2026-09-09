// The node this family's ordering cases are about: one whose relay choice is
// unresolved.
//
// THE SCENARIO OPENS PART-DONE, deliberately — `bridge/scenario/onboarding.ts` has
// the relay step already recorded so the rail shows a mixed state. That is the right
// default for almost every case in this family and the wrong one for the ones that
// are ABOUT an unsettled relay choice: the overlay's lock, and the telemetry step's
// ordering. Both need a state read that answers "nothing is done", both live in
// different files, and both used to build one by hand.
//
// A REPLACED OPERATION RATHER THAN A SECOND SCENARIO, because what these cases vary
// is one reply and not a world. Everything else — the readiness read the footer
// summarises, the relay options, the clock — stays the scenario's, so a case that
// asserts about the telemetry control is not silently also asserting about a bridge
// nobody else uses.
//
// AND THE PROGRESS IS A PARAMETER, because the completion gate needs the other end of
// the same axis: group A answered, which the shipped scenario is deliberately not.
// One replaced operation taking the set it reports, rather than a second helper per
// point on it, which is how two fixtures that disagree about a reply come to exist.

import { createFixtureBridge, type ConsoleBridge, type GrowthOutcome } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenario/onboarding.js";
import type { OnboardingStepId } from "./steps/step-model.js";

/**
 * Whether this window's caller has finished onboarding, as the daemon would report it.
 *
 * A CLASS RATHER THAN A CLOSED-OVER `let`, on `FixtureOnboardingLedger`'s reason: the
 * completion fold is state two replaced operations have to agree about, and the
 * fixture's own ledger performs exactly this fold over the read it serves. A helper
 * that replaces the state read drops that fold, so a case pressing _Finish setting up_
 * saw the reply and never the node moving.
 */
class CompletionRecord {
  #hasCompleted = false;

  public get hasCompleted(): boolean {
    return this.#hasCompleted;
  }

  /** Record an ACCEPTED completion, and answer the write untouched. */
  public foldAccepted(write: GrowthOutcome<void>): GrowthOutcome<void> {
    if (write.status === "served") {
      this.#hasCompleted = true;
    }
    return write;
  }
}

/**
 * The onboarding scenario, with the daemon reporting exactly these steps done.
 *
 * The completed set travels as the raw string list the wire carries, which
 * `completedStepsFrom` then narrows — so this is the reading the daemon would have
 * produced for a node in that state, rather than a state assembled past it.
 *
 * A completion this window records folds into the same reply, exactly as the fixture's
 * own ledger folds one: `isComplete` is what retires the footer's act, so a helper
 * that hard-coded `false` would make every completion case assert against a node the
 * daemon says is still unfinished.
 */
export function bridgeWithStepsDone(
  ...completedStepIds: readonly OnboardingStepId[]
): ConsoleBridge {
  const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
  const completion = new CompletionRecord();
  return {
    ...base,
    growth: {
      ...base.growth,
      onboardingStateRead: async () => ({
        status: "served",
        value: { completedStepIds: [...completedStepIds], isComplete: completion.hasCompleted },
      }),
      onboardingComplete: async (request) =>
        completion.foldAccepted(await base.growth.onboardingComplete(request)),
    },
  };
}

/** A node nobody has set up: no step recorded, so group A is wholly outstanding. */
export function bridgeWithNoRelayChosen(): ConsoleBridge {
  return bridgeWithStepsDone();
}

/** A node whose two group-A questions are both answered, and nothing else. */
export function bridgeWithGroupAAnswered(): ConsoleBridge {
  return bridgeWithStepsDone("relay", "telemetry");
}
