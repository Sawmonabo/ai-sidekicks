// What the overlay's two suites mount their cases with.
//
// The overlay is driven the same way by both — a window to render into, a mount that
// lets the opening reads settle, and an activation raised the way the runtime raises
// one — and this is that, written once. The suite that asserts the openings and the
// one that asserts the lock would otherwise each carry a mount, and two mounts that
// waited differently would be two answers to "what has settled by the time a case
// asserts", which is the drift a second copy of a harness always ends in.

import { act, render } from "@testing-library/react";

import type { ConsoleBridge } from "../bridge/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { consoleCommands } from "../palette/index.js";
import { FrameStore } from "../store/index.js";
import { onboardingActivation } from "./onboarding-activation.js";
import { OnboardingOverlay } from "./OnboardingOverlay.js";
import { onboardingWalkthroughMount } from "./onboarding-walkthrough-mount.js";
import type { ConsoleSurfaceContext } from "../seats/index.js";
import type { OnboardingOpening } from "./steps/step-model.js";
import type { ProviderAccountId } from "@ai-sidekicks/contracts";

/**
 * The window this overlay is mounted in, over a REAL frame store.
 *
 * A hand-shaped object carrying `navigate` alone was enough while this surface only
 * navigated; it publishes its open state now, so a stand-in would have to grow every
 * method the overlay reaches and would answer for none of them.
 */
export function contextOver(bridge: ConsoleBridge, frameStore: FrameStore): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge,
    frameStore,
    sessionStore: undefined,
  } as unknown as ConsoleSurfaceContext;
}

/** Mount the overlay and let its opening reads settle. */
export async function mount(
  bridge: ConsoleBridge,
  frameStore: FrameStore = new FrameStore(),
): Promise<void> {
  render(<OnboardingOverlay context={contextOver(bridge, frameStore)} />);
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/**
 * Raise an activation and let the walkthrough's own opening reads settle.
 *
 * The walkthrough arrives on its own chunk, so the render that follows an activation
 * draws the reserved region. Resolved through the MOUNT the overlay itself renders —
 * one home for that wait rather than a per-suite race — and only then the boundaries
 * the steps' own opening reads need.
 */
export async function activateAt(
  openAtStep: OnboardingOpening,
  accountScope?: ProviderAccountId,
): Promise<void> {
  await act(async () => {
    onboardingActivation.request({ openAtStep, accountScope });
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await onboardingWalkthroughMount.load();
    await crossMacrotaskBoundary();
  });
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/**
 * Drop both palette entries this overlay contributes.
 *
 * Every suite that mounts it registers them, and testing-library's own cleanup runs
 * after a file's `afterEach` — so a command still registered at that point is a leak
 * rather than a leftover, and the next file to mount would find the registry already
 * holding an id it is about to add.
 */
export function unregisterOnboardingCommands(): void {
  for (const id of ["onboarding.open", "onboarding.setUpProviders"]) {
    consoleCommands.unregister(id);
  }
}
