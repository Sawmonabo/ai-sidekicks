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
  WIRE_LIMIT_IDS,
} from "./accounts-fixture-body.test-support.js";
import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "./account-plane-bridge.test-support.js";

afterEach(() => {
  cleanup();
});

describe("AccountsFixtureBody", () => {
  // Three of the selected account's limits share one window length, so each keeps its own row.
  // A limit identifier never reaches the screen; a row is named by the provider's label, or by
  // its window length where it gave none.
  it("renders one quota row per limit and draws no limit identifier", () => {
    const { container } = mountAccountsPage({ registry: ACCOUNT_REGISTRY });
    expect(container.querySelectorAll(".meridian-accounts__quota tbody tr")).toHaveLength(3);
    for (const limitId of WIRE_LIMIT_IDS) {
      expect(container.textContent).not.toContain(limitId);
    }
  });

  // The daemon runs at most one brokered flow at a time; a second start would cost the person
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
