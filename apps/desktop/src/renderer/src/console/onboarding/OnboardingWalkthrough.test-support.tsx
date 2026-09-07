// What the walkthrough's two suites mount their cases with.
//
// The component takes a flow, a readiness model, an opening, and a way out, and both
// suites build all four the same way — over the shipped fixture and a real window
// store, then wait for the two settling passes an opening costs. Written once so the
// two files cannot drift into disagreeing about what has settled by the time a case
// asserts, which is the drift a second copy of a harness always ends in.

import { act, render } from "@testing-library/react";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../bridge/scenarios/onboarding.js";
import { FrameStore } from "../store/index.js";
import { OnboardingFlow } from "./onboarding-flow.js";
import { OnboardingWalkthrough } from "./OnboardingWalkthrough.js";
import { ProviderReadinessModel } from "./provider-readiness/provider-readiness.js";
import type { OnboardingOpening } from "./steps/step-model.js";

/**
 * What the surface holding this walkthrough offers as a way out.
 *
 * A WRAPPER RATHER THAN A BARE PARAMETER, because the value under test in one case is
 * `undefined` itself — a dialog that refuses to close — and a default parameter is
 * applied to an explicitly passed `undefined`, so the case would have been handed the
 * default and asserted nothing.
 */
export interface DismissalUnderTest {
  readonly handler: (() => void) | undefined;
}

/** Mount the walkthrough at one step and let both of its opening passes settle. */
export async function mountAt(
  openAtStep: OnboardingOpening,
  bridge: ConsoleBridge = createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
  dismissal: DismissalUnderTest = { handler: () => undefined },
): Promise<HTMLElement> {
  const rendered = render(
    <OnboardingWalkthrough
      flow={new OnboardingFlow(bridge)}
      readiness={new ProviderReadinessModel(bridge, new FrameStore())}
      openAtStep={openAtStep}
      accountScope={undefined}
      onOpenAccountRegistry={() => undefined}
      onDismiss={dismissal.handler}
    />,
  );
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await crossMacrotaskBoundary();
  });
  return rendered.container;
}
