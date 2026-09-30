// The accounts fixture body, driven over a registry reading built from the contract types.
// Every state asserted is one the wire can carry, and the sign-in cases drive the real tracker
// through plain stub calls.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  ACCOUNT_REGISTRY,
  mountAccountsPage,
  pressFirstStartControl,
  startControls,
} from "./accounts-fixture-body.test-support.js";
import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "./account-plane-bridge.test-support.js";

afterEach(() => {
  cleanup();
});

describe("AccountsFixtureBody", () => {
  // The token is never held by the fixture body, so nothing reads it back and no other field is
  // masked; the label field is the negative control and must stay ordinary text.
  it("offers one write-only token field that starts empty, and masks nothing else", () => {
    const { container } = mountAccountsPage({ registry: ACCOUNT_REGISTRY });
    const tokenInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(tokenInput).not.toBeNull();
    expect(tokenInput?.value).toBe("");
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0);
  });

  // The daemon runs at most one brokered flow at a time; a second start would cost the operator
  // the code they were typing and the way to stop the flow.
  it("stops offering a start while a sign-in is running, and says what is holding it", async () => {
    const { container } = mountAccountsPage({
      registry: ACCOUNT_REGISTRY,
      operations: accountPlaneCalls({ login: PROVIDER_SIGN_IN_ATTEMPT }),
    });
    await act(async () => {
      pressFirstStartControl(container);
      await crossMacrotaskBoundary();
    });

    // The flow the press started is on screen, with its code and its way out...
    expect(container.textContent).toContain("provider.example.test/device");
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
    // ...and no row offers a second start, with the reason where the control was.
    for (const control of startControls(container)) {
      expect(control.disabled).toBe(true);
    }
    expect(container.textContent).toContain("already running");
  });

  // Negative control: before anything is started the same controls are pressable, so the
  // assertion is about the flow and not a page that never offered a sign-in.
  it("offers a pressable start before anything is running", () => {
    const { container } = mountAccountsPage({ registry: ACCOUNT_REGISTRY });
    expect(startControls(container).length).toBeGreaterThan(0);
    for (const control of startControls(container)) {
      expect(control.disabled).toBe(false);
    }
  });
});
