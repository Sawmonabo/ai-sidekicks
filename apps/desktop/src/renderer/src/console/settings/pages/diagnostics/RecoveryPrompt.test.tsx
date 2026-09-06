// The recovery mutation: the press asks, the answer acts, and the reply is what shows.
//
// Three claims that a screenshot could not check. That no request leaves on the press
// that opens the confirmation — the one property that makes an irreversible control
// safe to put on a settings page. That what a person reads afterwards comes from the
// REPLY and not from the button they pressed, including the case where the node took
// the action and nothing moved. And that a refused request renders the refuser's own
// words on the control that raised it, with the other two still offered.

import { describe, expect, it } from "vitest";

import {
  bridgeAnswering,
  answerRecoveryConfirmation,
  openRecoveryConfirmation,
  recoveryReceipt,
  regionText,
  renderSettledPage,
  stuckInspection,
  FAILED_RUN_ID,
  SESSION_ID,
  STALLED_RUN_ID,
} from "./diagnostics-page.test-support.js";
import { runEntity, sessionStoreHolding } from "../../settings-page-mount.test-support.js";
import type { SessionStore } from "../../../store/index.js";

function storeWithStalledRun(): SessionStore {
  return sessionStoreHolding(SESSION_ID, [
    runEntity(STALLED_RUN_ID, "running"),
    runEntity(FAILED_RUN_ID, "failed"),
  ]);
}

async function renderPrompt(script: Parameters<typeof bridgeAnswering>[0]): Promise<{
  readonly container: HTMLElement;
  readonly calls: ReturnType<typeof bridgeAnswering>["calls"];
}> {
  const { bridge, calls } = bridgeAnswering({
    stall: stuckInspection("2026-01-01T07:53:30.000Z"),
    ...script,
  });
  const container = await renderSettledPage(bridge, storeWithStalledRun());
  return { container, calls };
}

describe("the recovery prompt", () => {
  it("sends nothing on the press that opens the confirmation", async () => {
    const { container, calls } = await renderPrompt({ recovery: recoveryReceipt("interrupted") });

    await openRecoveryConfirmation(container, "Interrupt");

    expect(calls.recovery).not.toHaveBeenCalled();
  });

  it("sends the action the confirmation was answered for", async () => {
    const { container, calls } = await renderPrompt({ recovery: recoveryReceipt("interrupted") });

    await answerRecoveryConfirmation(container, "Interrupt", "confirm");

    expect(calls.recovery).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at all when the confirmation is declined", async () => {
    const { container, calls } = await renderPrompt({ recovery: recoveryReceipt("interrupted") });

    await answerRecoveryConfirmation(container, "Abandon", "Not now");

    expect(calls.recovery).not.toHaveBeenCalled();
  });

  it("reports the transition the receipt names, not the button that was pressed", async () => {
    const { container } = await renderPrompt({ recovery: recoveryReceipt("interrupted") });

    await answerRecoveryConfirmation(container, "Interrupt", "confirm");

    expect(regionText(container, "Stuck runs")).toContain("went from");
    expect(regionText(container, "Stuck runs")).toContain("interrupted");
  });

  it("says plainly that nothing moved when the receipt names one state twice", async () => {
    // A request that was accepted is not evidence that anything happened, and this is
    // the arm that makes the receipt's two states worth carrying at all.
    const { container } = await renderPrompt({ recovery: recoveryReceipt("running") });

    await answerRecoveryConfirmation(container, "Interrupt", "confirm");

    expect(regionText(container, "Stuck runs")).toContain("Nothing moved");
  });

  it("renders the refusal on the prompt and leaves every control offered", async () => {
    const { container } = await renderPrompt({ refuse: ["recovery"] });

    await answerRecoveryConfirmation(container, "Abandon", "confirm");
    const region = regionText(container, "Stuck runs");
    const buttons = [
      ...(container.querySelector('section[aria-label="Stuck runs"]')?.querySelectorAll("button") ??
        []),
    ].map((button) => button.textContent);

    expect(region).toContain("not registered on this build");
    expect(buttons).toEqual(["Try again", "Interrupt", "Abandon"]);
  });

  it("offers no recovery where there is no moving run to address it to", async () => {
    const { bridge } = bridgeAnswering({ stall: stuckInspection("2026-01-01T07:53:30.000Z") });

    const container = await renderSettledPage(
      bridge,
      sessionStoreHolding(SESSION_ID, [runEntity(FAILED_RUN_ID, "failed")]),
    );

    expect(regionText(container, "Stuck runs")).not.toContain("Interrupt");
  });
});
