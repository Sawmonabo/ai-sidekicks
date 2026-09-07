// The node this family's ordering cases are about: one whose relay choice is
// unresolved.
//
// THE SCENARIO OPENS PART-DONE, deliberately — `bridge/scenarios/onboarding.ts` has
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

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";

/**
 * The onboarding scenario, with the daemon reporting that no step is done.
 *
 * The completed set travels as the raw string list the wire carries, which
 * `completedStepsFrom` then narrows — so this is the reading the daemon would have
 * produced for a node nobody has set up, rather than a state assembled past it.
 */
export function bridgeWithNoRelayChosen(): ConsoleBridge {
  const base = createFixtureBridge({ scenario: ONBOARDING_SCENARIO });
  return {
    ...base,
    growth: {
      ...base.growth,
      onboardingStateRead: async () => ({
        status: "served",
        value: { completedStepIds: [], isComplete: false },
      }),
    },
  };
}
