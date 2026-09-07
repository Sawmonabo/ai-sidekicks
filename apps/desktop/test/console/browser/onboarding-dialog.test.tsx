// The browser tier: the two window-scoped overlays lay out and trap focus for real.
//
// WHY THIS CANNOT LIVE IN THE UNIT TIER. `console-unit` runs happy-dom, which returns
// zeroes for every rect — so a claim that the walkthrough fits inside the viewport,
// or that its rail and pane sit side by side rather than stacked, passes vacuously
// there. And happy-dom's `focus()` lands on any element at all, while Chromium
// refuses a non-focusable one and a real focus trap either holds or it does not.
//
// TWO OVERLAYS AND ONE CLAIM EACH. The walkthrough is the taller surface and is the
// one whose popup can overflow a short window, so it carries the geometry case. The
// sign-in card is the one a person is put in mid-ceremony, so it carries the focus
// case: a dialog whose focus escaped would leave a keyboard user typing into the
// console behind a modal they cannot see past.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { pressKeys, renderSettled } from "../console-harness.js";

import { createFixtureBridge } from "../../../src/renderer/src/console/bridge/index.js";
import { crossMacrotaskBoundary } from "../../../src/renderer/src/console/core/macrotask-boundary.test-support.js";
import { ONBOARDING_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/onboarding.js";
import { onboardingActivation } from "../../../src/renderer/src/console/onboarding/index.js";
import { OnboardingOverlay } from "../../../src/renderer/src/console/onboarding/OnboardingOverlay.js";
import { SignInOverlay } from "../../../src/renderer/src/console/sign-in/SignInOverlay.js";
import { FrameStore } from "../../../src/renderer/src/console/store/index.js";
import type { ConsoleSurfaceContext } from "../../../src/renderer/src/console/seats/index.js";

/**
 * The three members these overlays read, and nothing this tier does not exercise.
 *
 * The frame store is the REAL class rather than a stub with `navigate` on it: the
 * sign-in card publishes into it while it is open, so a stub would have to grow a
 * method every time the card learns to say something — and the day it did not, this
 * tier would fail on the fixture rather than on the geometry it is here to measure.
 */
function surfaceContext(): ConsoleSurfaceContext {
  return {
    route: { kind: "sessions" },
    bridge: createFixtureBridge({ scenario: ONBOARDING_SCENARIO }),
    frameStore: new FrameStore(),
  } as unknown as ConsoleSurfaceContext;
}

/** The dialog popup Base UI portals into the document, whichever overlay opened it. */
function popupFor(className: string): HTMLElement {
  const popup = document.querySelector<HTMLElement>(`.${className}`);
  if (popup === null) {
    throw new Error(`no ${className} is on screen`);
  }
  return popup;
}

describe("browser — the walkthrough lays out inside the window", () => {
  it("fits the viewport and scrolls inside itself rather than past the bottom", async () => {
    await renderSettled(<OnboardingOverlay context={surfaceContext()} />);
    await act(async () => {
      onboardingActivation.request({ openAtStep: "providers", accountScope: undefined });
      await crossMacrotaskBoundary();
    });

    const popup = popupFor("meridian-onboarding__popup");
    const box = popup.getBoundingClientRect();
    // The rect is real here and all zeroes under happy-dom, which is the whole
    // reason this case is in this tier.
    expect(box.height).toBeGreaterThan(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    // Content taller than the popup scrolls INSIDE it; the page never grows sideways.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("puts the rail beside the pane rather than stacking them", async () => {
    await renderSettled(<OnboardingOverlay context={surfaceContext()} />);
    await act(async () => {
      onboardingActivation.request({ openAtStep: "relay", accountScope: undefined });
      await crossMacrotaskBoundary();
    });

    const rail = popupFor("meridian-onboarding__rail").getBoundingClientRect();
    const pane = popupFor("meridian-onboarding__pane").getBoundingClientRect();
    expect(rail.width).toBeGreaterThan(0);
    expect(pane.left).toBeGreaterThanOrEqual(rail.right);
  });
});

describe("browser — the sign-in card holds the keyboard", () => {
  it("keeps focus inside the popup across a tab cycle", async () => {
    await renderSettled(<SignInOverlay context={surfaceContext()} />);
    const { consoleCommands } = await import("../../../src/renderer/src/console/palette/index.js");
    await act(async () => {
      consoleCommands.invoke("signIn.open", {});
      await crossMacrotaskBoundary();
    });

    const popup = popupFor("meridian-sign-in__popup");
    const passkey = [...popup.querySelectorAll("button")].find(
      (control) => control.textContent === "Sign in with a passkey",
    );
    // Asserted before it is focused: optional-chaining past a missing control would
    // leave the claim below satisfied by the dialog's own autofocus, so a renamed
    // button would take this case green over a trap it never exercised.
    expect(passkey).toBeDefined();
    passkey?.focus();
    expect(popup.contains(document.activeElement)).toBe(true);

    // Enough presses to walk past the popup's own controls: a trap that leaked would
    // have handed the ring to the document body by now.
    await pressKeys("{Tab}{Tab}{Tab}{Tab}");
    expect(popup.contains(document.activeElement)).toBe(true);

    consoleCommands.unregister("signIn.open");
  });
});
