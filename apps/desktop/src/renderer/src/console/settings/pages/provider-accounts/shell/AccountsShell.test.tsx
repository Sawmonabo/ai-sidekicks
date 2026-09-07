// The accounts shell, driven against the deck it actually ships in.
//
// THE SCENARIO IS THE REAL ONE. `SETTINGS_SCENARIO` is the story the scenario
// selector opens, so every state asserted below is a state a reviewer can reach in a
// running fixture build rather than one that exists only in this file. That is the
// property the lane's own rule asks for and the reason nothing here hand-builds a
// registry reply.
//
// THE ONE STATE IT CANNOT REACH FROM THE DECK IS THE REFUSAL, because the deck
// answers this read. That case overrides the bound call so the failed arm is drawn
// too — every arm of the read is rendered somewhere.
//
// AND THE READ IS THE NODE'S, NOT THIS PAGE'S. The registry, the readiness projection
// and the quota rows all reach this shell through `bridge/quotas/`, which is the one
// reader of the account plane in a window and the one holder of its live tail. Two
// cases below are about exactly that and could not have passed while this page ran a
// read of its own: a frame pushed down the tail reaches the rows, and mounting the
// page costs ONE `providerAccount.list`.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderAccount } from "@ai-sidekicks/contracts";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../../../bridge/index.js";
import { PROVIDER_ACCOUNT_SUBSCRIBE_STREAM } from "../../../../bridge/daemon/daemon-streams.js";
import {
  withCapturedStream,
  withDaemonCall,
  type BridgeUnderTest,
  type StreamUnderTest,
} from "../../../../bridge/fixture/fixture-bridge.test-support.js";
import { settleScriptedRead } from "../../../../bridge/readings/scheduled-read.test-support.js";
import { SETTINGS_PROVIDER_ACCOUNT_LIST } from "../../../../bridge/scenarios/settings-account-plane.js";
import { SETTINGS_SCENARIO } from "../../../../bridge/scenarios/settings.js";
import { LiveAnnouncerProvider } from "../../../../primitives/index.js";
import { AccountsShell } from "./AccountsShell.js";

afterEach(() => {
  cleanup();
});

function renderShell(bridge: ConsoleBridge): HTMLElement {
  const { container } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <LiveAnnouncerProvider>
        <AccountsShell bridge={bridge} />
      </LiveAnnouncerProvider>
    </SidekicksBridgeProvider>,
  );
  return container;
}

/** Mount, carry the debounced read past its window and past the reply's latency. */
async function renderSettledShell(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = renderShell(bridge);
  await settleScriptedRead(bridge);
  return container;
}

function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

/** Every start-sign-in control the readiness list is currently offering. */
function startControls(): HTMLButtonElement[] {
  return screen.getAllByRole<HTMLButtonElement>("button", { name: /start sign-in/iu });
}

/** Press the first of them, the way a person reaching the remedy does. */
function pressFirstStartControl(): void {
  const [control] = startControls();
  if (control === undefined) {
    throw new Error("the readiness list offered no sign-in control to press");
  }
  fireEvent.click(control);
}

/** Open one account's detail the way a person does — by pressing its row. */
function selectAccount(container: HTMLElement, displayLabel: string): void {
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".meridian-accounts__row")];
  const row = rows.find((button) => (button.textContent ?? "").includes(displayLabel));
  if (row === undefined) {
    throw new Error(`the registry rendered no account row labelled ${displayLabel}`);
  }
  fireEvent.click(row);
}

/** One account off the deck's own reply, so no case here invents a registry row. */
function registryAccountAt(ordinal: number): ProviderAccount {
  const account = SETTINGS_PROVIDER_ACCOUNT_LIST.accounts[ordinal];
  if (account === undefined) {
    throw new Error(`the settings deck holds no registry account at ordinal ${String(ordinal)}`);
  }
  return account;
}

/** How many rows the list is currently drawing for one account's label. */
function rowsLabelled(container: HTMLElement, displayLabel: string): number {
  return [...container.querySelectorAll(".meridian-accounts__row")].filter((row) =>
    (row.textContent ?? "").includes(displayLabel),
  ).length;
}

/** The deck, with the account plane's live tail in this case's hands. */
function bridgeHoldingTheTail(): StreamUnderTest {
  return withCapturedStream(fixtureBridge(), PROVIDER_ACCOUNT_SUBSCRIBE_STREAM);
}

/** The deck, with every daemon call answered by the deck and counted on the way. */
function bridgeCountingItsCalls(): BridgeUnderTest {
  return withDaemonCall(fixtureBridge(), async (_call, passThrough) => await passThrough());
}

describe("AccountsShell", () => {
  it("draws a loading absence before the registry answers", () => {
    const container = renderShell(fixtureBridge());
    expect(container.textContent).toContain("account registry");
    expect(container.querySelectorAll(".meridian-accounts__row")).toHaveLength(0);
  });

  it("lists every account the node registry holds", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.querySelectorAll(".meridian-accounts__row").length).toBeGreaterThanOrEqual(3);
  });

  it("says an account has never been observed rather than dating it", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.textContent).toContain("Never observed");
  });

  it("offers the sign-in the readiness remedy names", async () => {
    await renderSettledShell(fixtureBridge());
    expect(screen.getAllByRole("button", { name: /start sign-in/iu }).length).toBeGreaterThan(0);
  });

  // The negative control for the case above: the authenticated entry carries no
  // remedy at all, so its readiness row offers nothing. One button per remedy-bearing
  // entry, never one per provider.
  it("offers no sign-in on the entry that needs nothing done", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const readinessRows = container.querySelectorAll(".meridian-accounts__readiness");
    const rowsOfferingSignIn = [...readinessRows].filter((row) =>
      /start sign-in/iu.test(row.textContent ?? ""),
    );
    expect(rowsOfferingSignIn.length).toBeLessThan(readinessRows.length);
  });

  it("renders one quota row per limit, keeping three that share a window length", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const limitRows = container.querySelectorAll(".meridian-accounts__quota tbody tr");
    expect(limitRows.length).toBeGreaterThanOrEqual(3);
  });

  it("marks a reading taken under an older credential generation", async () => {
    const container = await renderSettledShell(fixtureBridge());
    // The account is CHOSEN rather than assumed. A stale reading is one taken before
    // this account's credential was rotated, so it exists on the entry whose
    // generation has moved past its last probe — and the detail under the list is one
    // account's. Reading the whole page for the marker without opening that entry
    // would report the shell had lost a mark it never had the chance to draw.
    selectAccount(container, "Claude — batch runs");
    expect(container.textContent).toContain("Behind this account");
  });

  it("offers a token field that is write-only and starts empty", async () => {
    const container = await renderSettledShell(fixtureBridge());
    const tokenInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(tokenInput).not.toBeNull();
    expect(tokenInput?.value).toBe("");
  });

  // The token is never a value the shell holds, so nothing on the page reads it back
  // and no other field on the form is masked. The negative control is the label
  // field, which is ordinary text input and must stay that way.
  it("masks the token field and nothing else", async () => {
    const container = await renderSettledShell(fixtureBridge());
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0);
  });

  // The daemon runs at most one brokered flow per account and answers a second start
  // with `provideraccount.signin_in_flight`. A page that went on offering the control
  // sends that second start, and its refusal replaces the live attempt's verification
  // details and its cancel control — so the operator loses the code they were typing
  // and the only way to stop the flow, over a press the page should not have accepted.
  it("stops offering a start while a sign-in is running, and says what is holding it", async () => {
    const bridge = fixtureBridge();
    const container = await renderSettledShell(bridge);
    pressFirstStartControl();
    await settleScriptedRead(bridge);

    // The flow the press started is on screen, with its code and its way out...
    expect(container.textContent).toContain("auth.example.test/device");
    expect(screen.getAllByRole("button", { name: /cancel sign-in/iu })).toHaveLength(1);
    // ...and no row offers a second start, with the reason where the control was
    // rather than the control being taken away.
    for (const control of startControls()) {
      expect(control.disabled).toBe(true);
    }
    expect(container.textContent).toContain("already running");
  });

  // The negative control for the case above: before anything is started the same
  // controls are pressable, so the assertion is about the flow rather than about a
  // page that never offered a sign-in at all.
  it("offers a pressable start before anything is running", async () => {
    await renderSettledShell(fixtureBridge());
    expect(startControls().length).toBeGreaterThan(0);
    for (const control of startControls()) {
      expect(control.disabled).toBe(false);
    }
  });

  // A start the daemon refused never became a flow, so it belongs on the row that
  // asked and not in the card that watches one. The card is shared across every
  // readiness row, so a refusal shown there is a refusal about no particular account.
  it("puts a refused start on the row that asked, and leaves the shared card empty", async () => {
    const refusal = growthUnavailable("providerAccountLogin");
    const bridge = fixtureBridge();
    const refusing: ConsoleBridge = {
      ...bridge,
      growth: {
        ...bridge.growth,
        providerAccountLogin: async () => await Promise.resolve(refusal),
      },
    };
    const container = await renderSettledShell(refusing);
    pressFirstStartControl();
    await settleScriptedRead(refusing);

    const readinessRows = [...container.querySelectorAll(".meridian-accounts__readiness")];
    const rowsCarryingTheRefusal = readinessRows.filter((row) =>
      (row.textContent ?? "").includes(refusal.code),
    );
    expect(rowsCarryingTheRefusal).toHaveLength(1);
    expect(container.querySelector('[aria-label="Sign-in in progress"]')).toBeNull();
    // And the control is offered again: nothing is running, so nothing is holding it.
    expect(startControls().every((control) => control.disabled)).toBe(false);
  });

  it("draws the daemon's own refusal where the read could not be put", async () => {
    const bridge = fixtureBridge();
    // The daemon namespace is REBUILT rather than spread. Spreading it takes the
    // namespace whole, which is one of the five reaches
    // `test/console/architecture/daemon-reply-chokepoint.test.ts` forbids outside the
    // bridge family — and it forbids it here for the reason it exists: a namespace
    // taken as a value is how a surface reaches the raw door without naming it. The
    // stream member is stepped through, which is the shape that is not a reach.
    const refusing: ConsoleBridge = {
      ...bridge,
      sidekicks: {
        ...bridge.sidekicks,
        daemon: {
          call: async (): Promise<never> => {
            throw new Error("the registry read could not be put");
          },
          subscribe: bridge.sidekicks.daemon.subscribe,
        },
      },
    };
    const container = await renderSettledShell(refusing);
    expect(container.textContent).toContain("Try again");
  });

  // THE DEFECT. This page used to run a `providerAccount.list` of its own behind a
  // subscribe that opened nothing, so the node's tail could report an account removed
  // — the registry's own live signal, which this console already holds open — and the
  // page went on listing it until something happened to focus the window. Two
  // snapshots of one registry, and nothing on screen saying they disagreed.
  it("drops an account the node's tail says the registry no longer holds", async () => {
    const plane = bridgeHoldingTheTail();
    const container = await renderSettledShell(plane.bridge);
    const leaving = registryAccountAt(1);
    expect(rowsLabelled(container, leaving.displayLabel)).toBe(1);

    act(() => {
      plane.deliver({ kind: "account_removed", accountId: leaving.accountId });
    });

    expect(rowsLabelled(container, leaving.displayLabel)).toBe(0);
  });

  // The negative control for the case above: a frame this build cannot read moves no
  // account. Without it the case would hold for a page that emptied its list on any
  // delivery at all, which is the opposite failure and just as wrong.
  it("negative control: an unreadable frame moves no row", async () => {
    const plane = bridgeHoldingTheTail();
    const container = await renderSettledShell(plane.bridge);
    const staying = registryAccountAt(1);

    act(() => {
      plane.deliver({ kind: "a frame from a daemon this build does not know" });
    });

    expect(rowsLabelled(container, staying.displayLabel)).toBe(1);
  });

  // ONE READER. The count is asserted exactly rather than as a ceiling, which makes it
  // two-sided: two reads is the second snapshot this page used to take, and zero is a
  // page rendering a registry it never asked for.
  it("costs the node one registry read, not one of its own", async () => {
    const counted = bridgeCountingItsCalls();
    await renderSettledShell(counted.bridge);

    const registryReads = counted.calls.filter((call) => call.method === "providerAccount.list");
    expect(registryReads).toHaveLength(1);
  });
});
