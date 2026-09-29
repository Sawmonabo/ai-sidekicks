// The accounts shell, driven over a registry reading built from the contract types.
//
// Every state asserted below is one the wire can carry, and the sign-in cases drive the
// real plane through plain stub calls.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import {
  ACCOUNT_REGISTRY,
  UNREAD_ACCOUNT_REGISTRY,
  WIRE_LIMIT_IDS,
  mountShell,
  pressFirstStartControl,
  selectAccount,
  startControls,
} from "./accounts-fixture-body.test-support.js";
import { accountPlaneCalls, SIGN_IN_ATTEMPT } from "./account-plane-bridge.test-support.js";

afterEach(() => {
  cleanup();
});

describe("AccountsShell", () => {
  it("draws a loading absence before the registry answers", () => {
    const { container } = mountShell({ registry: UNREAD_ACCOUNT_REGISTRY });
    expect(container.textContent).toContain("account registry");
    expect(container.querySelectorAll(".meridian-accounts__row")).toHaveLength(0);
  });

  it("lists every account the registry holds", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(container.querySelectorAll(".meridian-accounts__row")).toHaveLength(
      ACCOUNT_REGISTRY.accounts.length,
    );
  });

  it("says an account has never been observed rather than dating it", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(container.textContent).toContain("Never observed");
  });

  it("offers the sign-in the readiness remedy names", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(startControls(container).length).toBeGreaterThan(0);
  });

  // The negative control for the case above: the authenticated entry carries no
  // remedy at all, so its readiness row offers nothing. One button per remedy-bearing
  // entry, never one per provider.
  it("offers no sign-in on the entry that needs nothing done", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    const readinessRows = container.querySelectorAll(".meridian-accounts__readiness");
    const rowsOfferingSignIn = [...readinessRows].filter((row) =>
      /start sign-in/iu.test(row.textContent ?? ""),
    );
    expect(rowsOfferingSignIn).toHaveLength(1);
    expect(readinessRows.length).toBeGreaterThan(rowsOfferingSignIn.length);
  });

  // Three of the selected account's limits share one window length, so each keeps its
  // own row. A limit identifier is the provider's spelling and never reaches the screen:
  // a row is named by the provider's label, or by its window length where it gave none.
  it("renders one quota row per limit and draws no limit identifier", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(container.querySelectorAll(".meridian-accounts__quota tbody tr")).toHaveLength(3);
    for (const limitId of WIRE_LIMIT_IDS) {
      expect(container.textContent).not.toContain(limitId);
    }
  });

  it("marks a reading taken under an older credential generation", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    // The account is chosen rather than assumed: a stale reading belongs to the entry
    // whose generation has moved past its last probe, and the detail under the list is
    // one account's.
    expect(container.textContent).not.toContain("Behind this account");
    selectAccount(container, "Claude — batch runs");
    expect(container.textContent).toContain("Behind this account");
  });

  it("offers a token field that is write-only and starts empty", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    const tokenInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(tokenInput).not.toBeNull();
    expect(tokenInput?.value).toBe("");
  });

  // The token is never a value the shell holds, so nothing on the page reads it back
  // and no other field on the form is masked. The negative control is the label
  // field, which is ordinary text input and must stay that way.
  it("masks the token field and nothing else", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0);
  });

  // The daemon runs at most one brokered flow at a time. A page that went on offering
  // the control would send a second start, and the operator would lose the code they
  // were typing and the only way to stop the flow.
  it("stops offering a start while a sign-in is running, and says what is holding it", async () => {
    const { container } = mountShell({
      registry: ACCOUNT_REGISTRY,
      operations: accountPlaneCalls({ login: SIGN_IN_ATTEMPT }),
    });
    await act(async () => {
      pressFirstStartControl(container);
      await crossMacrotaskBoundary();
    });

    // The flow the press started is on screen, with its code and its way out...
    expect(container.textContent).toContain("provider.example.test/device");
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
    // ...and no row offers a second start, with the reason where the control was
    // rather than the control being taken away.
    for (const control of startControls(container)) {
      expect(control.disabled).toBe(true);
    }
    expect(container.textContent).toContain("already running");
  });

  // The negative control for the case above: before anything is started the same
  // controls are pressable, so the assertion is about the flow rather than about a
  // page that never offered a sign-in at all.
  it("offers a pressable start before anything is running", () => {
    const { container } = mountShell({ registry: ACCOUNT_REGISTRY });
    expect(startControls(container).length).toBeGreaterThan(0);
    for (const control of startControls(container)) {
      expect(control.disabled).toBe(false);
    }
  });
});
