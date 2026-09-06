// What the page opens on, what it says the figure is made of, and what it keeps.
//
// Three claims that are one claim: the receipt is worth arriving at even when the
// current read has not answered. It opens on the figure with its splits closed, it
// shows the three provenance figures the accountant sent beside it, and a read that
// goes away — in flight or refused — leaves the last figure on screen under a notice
// saying when it was served rather than blanking the page.

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { formatDateTime } from "../../../primitives/index.js";
import {
  EMPTY_SCENARIO,
  SESSION_ID,
  balancedReceipt,
  bridgeServing,
  renderSettledPage,
  settle,
} from "./cost-receipt-page.test-support.js";
import type { CostReceipt, CostReceiptOutcome } from "./cost-receipt-model.js";

/** The disclosure each split is drawn inside, by the section that carries it. */
function splitFor(container: HTMLElement, label: string): HTMLDetailsElement | null {
  return (
    container
      .querySelector<HTMLElement>(`section[aria-label="${label}"]`)
      ?.querySelector<HTMLDetailsElement>("details") ?? null
  );
}

/** Every figure of the provenance list, in the order it is drawn. */
function provenanceFigures(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".meridian-cost-receipt__provenance dd")].map(
    (cell) => cell.textContent ?? "",
  );
}

describe("the cost page — what it opens on", () => {
  it("draws each split closed, so the page opens on the figure", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    for (const label of ["Per run", "Per party", "Per paying account"]) {
      expect(splitFor(container, label)?.open).toBe(false);
    }
  });

  it("says on each closed control how many rows are inside it", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    // A disclosure labelled only "Per run" is a control a person must open to find
    // out whether it is worth opening.
    expect(splitFor(container, "Per run")?.querySelector("summary")?.textContent).toContain(
      "2 rows",
    );
    expect(
      splitFor(container, "Per paying account")?.querySelector("summary")?.textContent,
    ).toContain("1 row");
  });

  it("negative control: a split that does not add up is named withheld, never counted", async () => {
    // A count would advertise rows the page has decided not to vouch for.
    const receipt = balancedReceipt();
    const misAccounted: CostReceipt = {
      ...receipt,
      runs: [{ ...receipt.runs[0]!, costCents: 1 }],
    };
    const container = await renderSettledPage(bridgeServing(misAccounted), SESSION_ID);
    const summary = splitFor(container, "Per run")?.querySelector("summary")?.textContent ?? "";
    expect(summary).toContain("withheld");
    expect(summary).not.toContain("row");
  });
});

describe("the cost page — where the figure came from", () => {
  it("renders the three figures the accountant sent, each as it arrived", async () => {
    const receipt = balancedReceipt();
    const container = await renderSettledPage(
      bridgeServing({
        ...receipt,
        sessionTotal: {
          ...receipt.sessionTotal,
          observedPricedCostCents: 10_000,
          observedUnpricedDebitCents: 2_000,
          reservedCostCents: 300,
        },
      }),
      SESSION_ID,
    );
    expect(provenanceFigures(container)).toStrictEqual(["$100.00", "$20.00", "$3.00"]);
    // And the figure the session is charged is still the one the daemon settled,
    // rather than anything re-derived from the three beside it.
    expect(
      container.querySelector<HTMLElement>(".meridian-cost-receipt__figure span")?.textContent,
    ).toBe("$123.00");
  });

  it("negative control: it draws no fourth figure, so nothing there is a sum", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    expect(provenanceFigures(container)).toHaveLength(3);
  });
});

/** A read that answers with the first outcome, then with the second from then on. */
function bridgeThenRefusing(
  first: CostReceiptOutcome,
  rest: CostReceiptOutcome,
): { readonly bridge: ConsoleBridge; readonly readReceipt: ReturnType<typeof vi.fn> } {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  let callCount = 0;
  const readReceipt = vi.fn(async () => {
    callCount += 1;
    return await Promise.resolve(callCount === 1 ? first : rest);
  });
  return {
    bridge: {
      ...fixture,
      growth: { ...fixture.growth, orchestrationCostReceiptRead: readReceipt },
    },
    readReceipt,
  };
}

async function refocusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await crossMacrotaskBoundary();
  });
  await settle();
}

describe("the cost page — what it keeps when the read goes away", () => {
  it("holds the last figure served when a later read refuses, and says when it was served", async () => {
    const refusal = growthUnavailable("orchestrationCostReceiptRead");
    const { bridge, readReceipt } = bridgeThenRefusing(
      { status: "served", value: balancedReceipt() },
      refusal,
    );
    const container = await renderSettledPage(bridge, SESSION_ID);
    await refocusWindow();

    expect(readReceipt.mock.calls.length).toBeGreaterThan(1);
    const text = container.textContent ?? "";
    // The daemon's own words about the read that just failed...
    expect(text).toContain(refusal.code);
    // ...above the figure it did not replace, stamped with when that one landed.
    expect(text).toContain("last receipt this session was served");
    expect(
      container.querySelector<HTMLElement>(".meridian-cost-receipt__figure span")?.textContent,
    ).toBe("$123.00");
    const stamp = container.querySelector<HTMLElement>(
      ".meridian-cost-receipt__retained-note [title]",
    );
    expect(stamp?.textContent).toBe(formatDateTime(stamp?.getAttribute("title") ?? ""));
  });

  it("negative control: a session never served keeps nothing, and shows the refusal alone", async () => {
    const refusal = growthUnavailable("orchestrationCostReceiptRead");
    const { bridge } = bridgeThenRefusing(refusal, refusal);
    const container = await renderSettledPage(bridge, SESSION_ID);
    await refocusWindow();

    expect(container.textContent ?? "").not.toContain("last receipt this session was served");
    expect(container.querySelector(".meridian-cost-receipt__figure")).toBeNull();
  });
});
