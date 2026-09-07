// Two reasons to re-read arriving together, and which receipt is left on screen.
//
// THE THREE TRIGGERS OVERLAP IN PRACTICE. A window that reconnects is a window that
// was just refocused, and both of those follow the mount. The page used to call the
// accountant from each of them, so two reads could be outstanding at once — and
// nothing decided which reply won except which one happened to answer last. An older
// receipt replacing a newer one is invisible on screen: both are receipts, both are
// figures, and the stamp beside the retained figure would have said the stale one was
// the fresh one, because it was read where the reply landed rather than where the
// read that published it completed.
//
// So the cases below assert the property rather than the mechanism: one call at a
// time, the newest answer on screen, and a stamp that belongs to the read that
// published. What makes them hold is that the page's reads go through the console's
// one refresh chokepoint, which serializes.

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { frozenClockOf } from "../../../bridge/readings/scheduled-read.test-support.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import type { CostReceipt, CostReceiptOutcome } from "./cost-receipt-model.js";
import {
  EMPTY_SCENARIO,
  SESSION_ID,
  balancedReceipt,
  renderPage,
  settle,
} from "./cost-receipt-page.test-support.js";

/** The run id the first read's receipt carries, so its presence names that read. */
const FIRST_READ_RUN_ID = "run-alpha";

/** The run id only the second read's receipt carries. */
const SECOND_READ_RUN_ID = "run-later";

/** The balanced receipt with its runs renamed, so two reads are told apart on screen. */
function receiptWithRunNamed(runId: string): CostReceipt {
  const receipt = balancedReceipt();
  const [first, second] = receipt.runs;
  if (first === undefined || second === undefined) {
    throw new Error("the balanced receipt is expected to carry two run rows");
  }
  return {
    ...receipt,
    runs: [{ ...first, runId }, second],
  };
}

/**
 * A bridge whose receipt read answers each call with the next outcome in turn.
 *
 * The LAST outcome answers every call past the end, so a case asserting how many
 * calls were made cannot be rescued by an undefined reply that renders as an absence.
 */
function bridgeAnsweringInTurn(outcomes: readonly CostReceiptOutcome[]): {
  readonly bridge: ConsoleBridge;
  readonly readReceipt: ReturnType<typeof vi.fn>;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  let callCount = 0;
  const readReceipt = vi.fn(async () => {
    const outcome = outcomes[Math.min(callCount, outcomes.length - 1)];
    callCount += 1;
    if (outcome === undefined) {
      throw new Error("this bridge was built with no outcome to answer with");
    }
    return await Promise.resolve(outcome);
  });
  return {
    bridge: {
      ...fixture,
      growth: { ...fixture.growth, orchestrationCostReceiptRead: readReceipt },
    },
    readReceipt,
  };
}

/** Raise the window-focus trigger without letting the scheduler's window elapse. */
async function refocusWithoutSettling(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await crossMacrotaskBoundary();
  });
}

/** The instant the retained figure carries, read off the stamp the page renders. */
function retainedStampOf(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>(".meridian-cost-receipt__retained-note [title]")
      ?.getAttribute("title") ?? null
  );
}

describe("the cost page — overlapping reasons to re-read", () => {
  it("asks the accountant once for a mount and a focus that arrive together", async () => {
    const { bridge, readReceipt } = bridgeAnsweringInTurn([
      { status: "served", value: receiptWithRunNamed(FIRST_READ_RUN_ID) },
      { status: "served", value: receiptWithRunNamed(SECOND_READ_RUN_ID) },
    ]);
    const container = renderPage(bridge, SESSION_ID);

    // Both reasons are raised before the coalescing window elapses, which is the
    // ordinary case rather than a contrived one: a window regains focus in the same
    // breath as the surface that mounted inside it.
    await refocusWithoutSettling();
    await settle(bridge);

    expect(readReceipt).toHaveBeenCalledTimes(1);
    // And the one read that was performed is the one on screen, so the count above is
    // not passing over a page that read nothing at all.
    expect(container.textContent ?? "").toContain(FIRST_READ_RUN_ID);
  });

  it("negative control: a reason raised in a later window is read, not swallowed", async () => {
    // Without this, the case above would hold for a page that coalesced every trigger
    // it would ever see into the first read and then stopped listening — which is the
    // staleness the scheduler exists to avoid rather than to cause.
    const { bridge, readReceipt } = bridgeAnsweringInTurn([
      { status: "served", value: receiptWithRunNamed(FIRST_READ_RUN_ID) },
      { status: "served", value: receiptWithRunNamed(SECOND_READ_RUN_ID) },
    ]);
    renderPage(bridge, SESSION_ID);
    await settle(bridge);
    expect(readReceipt).toHaveBeenCalledTimes(1);

    await refocusWithoutSettling();
    await settle(bridge);

    expect(readReceipt).toHaveBeenCalledTimes(2);
  });

  it("leaves the newest read's receipt on screen and not the one before it", async () => {
    const { bridge } = bridgeAnsweringInTurn([
      { status: "served", value: receiptWithRunNamed(FIRST_READ_RUN_ID) },
      { status: "served", value: receiptWithRunNamed(SECOND_READ_RUN_ID) },
    ]);
    const container = renderPage(bridge, SESSION_ID);
    await settle(bridge);
    await refocusWithoutSettling();
    await settle(bridge);

    const text = container.textContent ?? "";
    expect(text).toContain(SECOND_READ_RUN_ID);
    expect(text).not.toContain(FIRST_READ_RUN_ID);
  });

  it("stamps the retained figure at the read that published it", async () => {
    const { bridge } = bridgeAnsweringInTurn([
      { status: "served", value: receiptWithRunNamed(FIRST_READ_RUN_ID) },
      { status: "served", value: receiptWithRunNamed(SECOND_READ_RUN_ID) },
      // A refusal last, built by the shipped port rather than written here, so the
      // page is left rendering the RETAINED figure and its stamp is on screen to read.
      growthUnavailable("orchestrationCostReceiptRead"),
    ]);
    const container = renderPage(bridge, SESSION_ID);
    await settle(bridge);
    const firstReadInstant = new Date(frozenClockOf(bridge).now()).toISOString();

    await refocusWithoutSettling();
    await settle(bridge);
    const secondReadInstant = new Date(frozenClockOf(bridge).now()).toISOString();

    await refocusWithoutSettling();
    await settle(bridge);

    // The clock moved between the two served reads, so a stamp taken anywhere but at
    // the read that published names the wrong one of them — and both are receipts, so
    // nothing else on screen would report it.
    expect(secondReadInstant).not.toBe(firstReadInstant);
    expect(retainedStampOf(container)).toBe(secondReadInstant);
    expect(container.textContent ?? "").toContain(SECOND_READ_RUN_ID);
  });
});
