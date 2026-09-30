// What the sign-in card does when a flow ends. A flow ends by a cancel the daemon answered or
// by the registry reporting the attempt finished; either way the card goes, the start controls
// come back, and the registry is read again, since a flow ending says nothing about the
// account. `sign-in-flow-tracker.test.ts` states the same rules on the tracker; these drive
// them through the fixture body because the card and control are claims about the rendered page.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "./account-plane-bridge.test-support.js";
import {
  ACCOUNT_REGISTRY,
  mountAccountsPage,
  pressFirstStartControl,
  registryReportingCompleted,
  startControls,
  type MountedAccountsPage,
} from "./accounts-fixture-body.test-support.js";

afterEach(() => {
  cleanup();
});

const SIGN_IN_CARD = '[aria-label="Sign-in in progress"]';

/** Mount the fixture body with a start and a cancel that answer, and press its start once. */
async function mountWithLiveSignIn(): Promise<MountedAccountsPage> {
  const mounted = mountAccountsPage({
    registry: ACCOUNT_REGISTRY,
    operations: accountPlaneCalls({
      login: PROVIDER_SIGN_IN_ATTEMPT,
      cancel: { status: "canceled" },
    }),
  });
  await act(async () => {
    pressFirstStartControl(mounted.container);
    await crossMacrotaskBoundary();
  });
  return mounted;
}

describe("the sign-in card, when a flow ends", () => {
  it("clears the card and asks for a fresh read when the cancellation is honored", async () => {
    const { container, requestRegistryRead } = await mountWithLiveSignIn();
    expect(container.querySelector(SIGN_IN_CARD)).not.toBeNull();

    await act(async () => {
      screen.getByRole<HTMLButtonElement>("button", { name: /cancel sign-in/iu }).click();
      await crossMacrotaskBoundary();
    });

    expect(container.querySelector(SIGN_IN_CARD)).toBeNull();
    expect(container.textContent).toContain("The sign-in was canceled");
    expect(startControls(container).every((control) => control.disabled)).toBe(false);
    expect(requestRegistryRead).toHaveBeenCalledTimes(1);
  });

  it("clears the card and asks for a fresh read when the registry says it finished", async () => {
    const { container, requestRegistryRead, showRegistry } = await mountWithLiveSignIn();

    act(() => {
      showRegistry(registryReportingCompleted(PROVIDER_SIGN_IN_ATTEMPT.attemptId));
    });

    expect(container.querySelector(SIGN_IN_CARD)).toBeNull();
    expect(startControls(container).every((control) => control.disabled)).toBe(false);
    expect(requestRegistryRead).toHaveBeenCalledTimes(1);
  });

  // The registry's report is node-wide, so another window's flow completes on it too; a
  // completion naming a different attempt must leave this card where it was.
  it("leaves the card alone for a completion naming another attempt", async () => {
    const { container, requestRegistryRead, showRegistry } = await mountWithLiveSignIn();

    act(() => {
      showRegistry(registryReportingCompleted("an-attempt-another-window-started"));
    });

    expect(container.textContent).toContain(PROVIDER_SIGN_IN_ATTEMPT.verificationUri);
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
    expect(requestRegistryRead).not.toHaveBeenCalled();
  });
});
