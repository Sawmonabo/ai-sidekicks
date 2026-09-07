// Mounting the accounts shell against the deck it ships in, and reading it back.
//
// HOISTED ON THE SECOND USE, which is the package rule. Three suites drive this page —
// what the registry read renders, what the node's tail does to it once that read has
// settled, and what the sign-in plane does while a flow is running — and all three need
// the same deck, the same providers, the same settled mount, and the same handful of
// readers over the rendered list. A second copy of the mount would be a second set of
// defaults, and a case reading a default it did not write is the hardest kind of test
// to correct.
//
// THE DECK IS THE REAL ONE. `SETTINGS_SCENARIO` is the story the scenario selector
// opens, so every state a case reaches here is a state a reviewer can reach in a
// running fixture build. Nothing in this module hand-builds a registry reply.

import { fireEvent, render, screen } from "@testing-library/react";

import type { ProviderAccount } from "@ai-sidekicks/contracts";

import {
  SidekicksBridgeProvider,
  createFixtureBridge,
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

/** The deck's own bridge, with nothing overridden. */
export function fixtureBridge(): ConsoleBridge {
  return createFixtureBridge({ scenario: SETTINGS_SCENARIO });
}

/** Mount the shell under the two providers every console surface renders inside. */
export function renderShell(bridge: ConsoleBridge): HTMLElement {
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
export async function renderSettledShell(bridge: ConsoleBridge): Promise<HTMLElement> {
  const container = renderShell(bridge);
  await settleScriptedRead(bridge);
  return container;
}

/** The deck, with the account plane's live tail in this case's hands. */
export function bridgeHoldingTheTail(): StreamUnderTest {
  return withCapturedStream(fixtureBridge(), PROVIDER_ACCOUNT_SUBSCRIBE_STREAM);
}

/** The deck, with every daemon call answered by the deck and counted on the way. */
export function bridgeCountingItsCalls(): BridgeUnderTest {
  return withDaemonCall(fixtureBridge(), async (_call, passThrough) => await passThrough());
}

/**
 * The deck with BOTH: the live tail in this case's hands, and every call counted.
 *
 * Composed rather than a third stand-alone deck, because the claim that needs both is
 * one claim — a frame arriving on the tail causing a call to go out — and a case that
 * could only hold one of the two would be asserting the frame or the call, never the
 * link between them.
 */
export function bridgeHoldingTheTailAndCountingCalls(): StreamUnderTest & BridgeUnderTest {
  const tail = bridgeHoldingTheTail();
  const counted = withDaemonCall(tail.bridge, async (_call, passThrough) => await passThrough());
  return { bridge: counted.bridge, calls: counted.calls, deliver: tail.deliver };
}

/** Every start-sign-in control the readiness list is currently offering. */
export function startControls(): HTMLButtonElement[] {
  return screen.getAllByRole<HTMLButtonElement>("button", { name: /start sign-in/iu });
}

/** Press the first of them, the way a person reaching the remedy does. */
export function pressFirstStartControl(): void {
  const [control] = startControls();
  if (control === undefined) {
    throw new Error("the readiness list offered no sign-in control to press");
  }
  fireEvent.click(control);
}

/** Open one account's detail the way a person does — by pressing its row. */
export function selectAccount(container: HTMLElement, displayLabel: string): void {
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".meridian-accounts__row")];
  const row = rows.find((button) => (button.textContent ?? "").includes(displayLabel));
  if (row === undefined) {
    throw new Error(`the registry rendered no account row labelled ${displayLabel}`);
  }
  fireEvent.click(row);
}

/** One account off the deck's own reply, so no case invents a registry row. */
export function registryAccountAt(ordinal: number): ProviderAccount {
  const account = SETTINGS_PROVIDER_ACCOUNT_LIST.accounts[ordinal];
  if (account === undefined) {
    throw new Error(`the settings deck holds no registry account at ordinal ${String(ordinal)}`);
  }
  return account;
}

/** How many rows the list is currently drawing for one account's label. */
export function rowsLabelled(container: HTMLElement, displayLabel: string): number {
  return [...container.querySelectorAll(".meridian-accounts__row")].filter((row) =>
    (row.textContent ?? "").includes(displayLabel),
  ).length;
}

/** The quota table's rendered cells for one limit, by the identifier it is keyed on. */
export function quotaRowText(container: HTMLElement, limitId: string): string {
  const rows = [...container.querySelectorAll(".meridian-accounts__quota tbody tr")];
  return rows.find((row) => (row.textContent ?? "").includes(limitId))?.textContent ?? "";
}
