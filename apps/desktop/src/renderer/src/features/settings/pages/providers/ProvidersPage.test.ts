// The Providers page, driven over a registry reading built from the contract types.
// Every state asserted is one the wire can carry, and the sign-in cases drive the real tracker
// through plain stub calls.

import type {
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts/provider/account/record";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import {
  ACCOUNT_REGISTRY,
  mountAccountsPage,
  pressFirstStartControl,
  signInAddressOf,
  startControls,
  WIRE_LIMIT_IDS,
} from "./ProvidersPage.test-support.js";
import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "./account-plane-bridge.test-support.js";
import type { ReadAccountList } from "./ProvidersPage.js";

afterEach(() => {
  cleanup();
});

describe("ProvidersPage", () => {
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
      operations: accountPlaneCalls({ signIn: PROVIDER_SIGN_IN_ATTEMPT }),
    });
    await act(async () => {
      pressFirstStartControl(container);
      await crossMacrotaskBoundary();
    });

    // The flow the press started is on screen, with its code and its way out...
    expect(signInAddressOf(container)).toContain("provider.example.test/device");
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
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

  // An expired code is a dead end unless the card offers the way back: ending the old flow and
  // starting the same account's sign-in again, in that order, since the daemon holds one flow.
  it("says an expired code expired and signs the same account in again on Sign in again", async () => {
    const operations = accountPlaneCalls({
      signIn: { ...PROVIDER_SIGN_IN_ATTEMPT, expiresAt: "2000-01-01T00:00:00.000Z" },
      cancel: { status: "canceled" },
    });
    const { container } = mountAccountsPage({ registry: ACCOUNT_REGISTRY, operations });
    await act(async () => {
      pressFirstStartControl(container);
      await crossMacrotaskBoundary();
    });
    expect(container.textContent).toContain("Code expired · Sign in again");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
      await crossMacrotaskBoundary();
    });

    expect(operations.cancelSignIn).toHaveBeenCalledWith({
      attemptId: PROVIDER_SIGN_IN_ATTEMPT.attemptId,
    });
    // The first `Sign in` is the Claude default's; both starts are for that one account.
    const [firstStart, secondStart] = operations.signIn.mock.calls.map(([request]) => request);
    expect(operations.signIn).toHaveBeenCalledTimes(2);
    expect(secondStart).toStrictEqual(firstStart);
  });
});

/**
 * The registry with its Claude default read as a token account whose login expired. Cast: the
 * generated readiness type carries its remedy's schema reference, which no literal satisfies.
 */
const EXPIRED_TOKEN_REGISTRY: ReadAccountList = {
  ...ACCOUNT_REGISTRY,
  readiness: ACCOUNT_REGISTRY.readiness.map((entry) =>
    entry.provider === "claude"
      ? ({
          provider: entry.provider,
          state: "reauthRequired",
          resolvedAccountId: "pa-0001" as ProviderAccountId,
          remedy: { kind: "pasteToken", accountId: "pa-0001" as ProviderAccountId },
        } as ProviderReadiness)
      : entry,
  ),
};

describe("ProvidersPage — a fresh token for an expired token account", () => {
  // A fresh token pasted without the account it belongs to would register a second account and
  // leave the expired one, with its spend and history, behind.
  it("replaces the token on the account the remedy names and clears the field", async () => {
    const register = accountPlaneCalls({
      register: { account: ACCOUNT_REGISTRY.accounts[0] as ReadAccountList["accounts"][0] },
    }).register;
    const { container } = mountAccountsPage({
      registry: EXPIRED_TOKEN_REGISTRY,
      operations: { register },
    });
    const field = screen.getByLabelText<HTMLInputElement>(
      "Paste the token you minted at the provider.",
    );
    fireEvent.change(field, { target: { value: "fresh-token" } });
    await act(async () => {
      fireEvent.submit(field.form as HTMLFormElement);
      await crossMacrotaskBoundary();
    });

    expect(register.mock.calls).toStrictEqual([
      [
        {
          provider: "claude",
          billingMode: "subscription",
          accountId: "pa-0001",
          nonInteractiveToken: "fresh-token",
        },
      ],
    ]);
    expect(field.value).toBe("");
    expect(container.textContent).toContain("Token saved. Stored in the keychain.");
  });
});
