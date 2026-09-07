// A refused cancellation does not take the sign-in off the screen.
//
// THE DEFECT, AT THE SURFACE. `providerAccount.loginCancel` refusing means the console
// could not put the request or the node declined it — neither of which stops the
// provider's own login process, which the daemon spawned unmodified and reads nothing
// from. The page used to install that refusal as the flow: the verification URI and the
// code the operator was typing went off screen, the cancel control went with them, and
// every start control came back — so the next press would race a process that may well
// still have been running.
//
// SO THE CASES BELOW ARE ABOUT WHAT IS ON SCREEN AFTER A REFUSED CANCEL, and about the
// two things that DO end a flow: a cancel that answered, and the node's own tail
// reporting the attempt finished. `signin-plane.test.ts` states the same rule at the
// plane; these drive it through the deck the shell ships against, because "the code is
// still there and the control is still offered" is a claim about the rendered card.

import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  growthUnavailable,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../../../../bridge/index.js";
import type { ProviderAccountLoginCancelResponse } from "@ai-sidekicks/contracts";
import { settleScriptedRead } from "../../../../bridge/readings/scheduled-read.test-support.js";
import { SETTINGS_PROVIDER_ACCOUNT_LOGIN } from "../../../../bridge/scenarios/settings/account-plane.js";
import {
  bridgeHoldingTheTail,
  bridgeHoldingTheTailAndCountingCalls,
  pressFirstStartControl,
  renderSettledShell,
  startControls,
} from "./accounts-shell-mount.test-support.js";

afterEach(() => {
  cleanup();
});

/**
 * The registry read the shell asks for. A literal because the reply registry keys its
 * own rows by this string and exports no constant — minting one for a test would be a
 * second spelling of a name the registry already owns.
 */
const REGISTRY_READ_METHOD = "providerAccount.list";

/** The verification URI the deck's brokered attempt answers with. */
const VERIFICATION_URI = SETTINGS_PROVIDER_ACCOUNT_LOGIN.verificationUri;

/** The deck's tail, with the cancel verb answering what this case asked for. */
function bridgeCancellingWith(
  cancel: GrowthOutcome<ProviderAccountLoginCancelResponse>,
): ReturnType<typeof bridgeHoldingTheTail> {
  const plane = bridgeHoldingTheTail();
  const bridge: ConsoleBridge = {
    ...plane.bridge,
    growth: {
      ...plane.bridge.growth,
      providerAccountLoginCancel: async () => await Promise.resolve(cancel),
    },
  };
  return { bridge, deliver: plane.deliver };
}

/** Start the deck's sign-in and press its cancel control once. */
async function startAndCancel(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = await renderSettledShell(bridge);
  pressFirstStartControl();
  await settleScriptedRead(bridge);
  const [cancel] = screen.getAllByRole<HTMLButtonElement>("button", {
    name: /cancel sign-in/iu,
  });
  await act(async () => {
    cancel?.click();
    await settleScriptedRead(bridge);
  });
  return container;
}

describe("the sign-in card, when a cancellation is refused", () => {
  it("keeps the attempt on screen with the refusal beside it", async () => {
    const refusal = growthUnavailable("providerAccountLoginCancel");
    const container = await startAndCancel(bridgeCancellingWith(refusal).bridge);

    expect(container.textContent).toContain(VERIFICATION_URI);
    expect(container.textContent).toContain(refusal.code);
    expect(container.querySelector('[aria-label="Sign-in in progress"]')).not.toBeNull();
  });

  it("goes on offering the cancel and goes on refusing a start", async () => {
    const container = await startAndCancel(
      bridgeCancellingWith(growthUnavailable("providerAccountLoginCancel")).bridge,
    );

    // The control is the operator's only way to ask again, and every start stays
    // disabled because the single flight is still claimed.
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
    expect(startControls().every((control) => control.disabled)).toBe(true);
    expect(container.textContent).toContain("still being tracked here");
  });

  // THE NEGATIVE CONTROL for both: a cancel the node ANSWERS ends the flow, card and
  // all. Without it the cases above would hold for a page that had simply stopped
  // clearing the card at all.
  it("clears the card when the cancellation is honoured", async () => {
    const container = await startAndCancel(
      bridgeCancellingWith({ status: "served", value: { status: "cancelled" } }).bridge,
    );

    expect(container.querySelector('[aria-label="Sign-in in progress"]')).toBeNull();
    expect(container.textContent).toContain("The sign-in was cancelled");
    expect(startControls().every((control) => control.disabled)).toBe(false);
  });

  it("clears the card when the registry reports the attempt finished", async () => {
    // The other ending, and the one that releases a plane a refused cancel left
    // holding: the account plane's own tail carries the completion, correlated on the
    // attempt id the start answered with.
    const plane = bridgeCancellingWith(growthUnavailable("providerAccountLoginCancel"));
    const container = await startAndCancel(plane.bridge);
    expect(container.textContent).toContain(VERIFICATION_URI);

    act(() => {
      plane.deliver({
        kind: "login_completed",
        attemptId: SETTINGS_PROVIDER_ACCOUNT_LOGIN.attemptId,
        accountId: "acct-codex-personal",
        outcome: "succeeded",
      });
    });

    expect(container.querySelector('[aria-label="Sign-in in progress"]')).toBeNull();
    expect(startControls().every((control) => control.disabled)).toBe(false);
  });

  it("asks the registry for a fresh read once the completion has landed", async () => {
    // The third thing a completion owes. A flow ending says nothing about the account —
    // the daemon reads nothing the provider's login binary writes — so the page asks the
    // node rather than assuming, and that question is a call this case counts.
    const plane = bridgeHoldingTheTailAndCountingCalls();
    const container = await renderSettledShell(plane.bridge);
    pressFirstStartControl();
    await settleScriptedRead(plane.bridge);
    const readsBefore = plane.calls.filter((call) => call.method === REGISTRY_READ_METHOD).length;

    act(() => {
      plane.deliver({
        kind: "login_completed",
        attemptId: SETTINGS_PROVIDER_ACCOUNT_LOGIN.attemptId,
        accountId: "acct-codex-personal",
        outcome: "succeeded",
      });
    });
    await settleScriptedRead(plane.bridge);

    expect(
      plane.calls.filter((call) => call.method === REGISTRY_READ_METHOD).length,
    ).toBeGreaterThan(readsBefore);
    expect(container.querySelector('[aria-label="Sign-in in progress"]')).toBeNull();
  });

  // And the negative control for THAT: the tail is node-scoped, so another window's
  // brokered flow completes on it too. A completion naming a different attempt must
  // leave this card exactly where it was.
  it("leaves the card alone for a completion naming another attempt", async () => {
    const plane = bridgeCancellingWith(growthUnavailable("providerAccountLoginCancel"));
    const container = await startAndCancel(plane.bridge);

    act(() => {
      plane.deliver({
        kind: "login_completed",
        attemptId: "an-attempt-another-window-started",
        accountId: "acct-codex-personal",
        outcome: "succeeded",
      });
    });

    expect(container.textContent).toContain(VERIFICATION_URI);
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
  });
});
