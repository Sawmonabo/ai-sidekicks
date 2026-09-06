// A split that does not account for the figure, and what the page says out loud.
//
// The rows withheld from the split whose arithmetic does not close while the figure
// the daemon settled still renders, the one polite announcement per settlement, and
// the budget wire this page never reads. What the page DRAWS is
// `CostReceiptPage.reading.test.tsx`, over the one cast in
// `cost-receipt-page.test-support.tsx`.
import { crossMacrotaskBoundary } from "../../../core/macrotask-boundary.test-support.js";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFixtureBridge, growthUnavailable } from "../../../bridge/index.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { politeText } from "../../../primitives/live-region.test-support.js";
import { settingsPageContextWith } from "../../settings-page-mount.test-support.js";
import { CostReceiptPage, registerCostReceiptPage } from "./CostReceiptPage.js";
import type { CostReceipt, CostReceiptOutcome } from "./cost-receipt-model.js";
import { SettingsPageRegistry } from "../../settings-page-registry.js";
import {
  EMPTY_SCENARIO,
  SESSION_ID,
  balancedReceipt,
  bridgeAnswering,
  bridgeServing,
  renderSettledPage,
  sectionText,
  settle,
  tableRowsUnder,
} from "./cost-receipt-page.test-support.js";

describe("the cost page — a split that does not account for the figure", () => {
  /** The balanced receipt with one run row dropped, so only that axis is short. */
  function receiptMissingARun(): CostReceipt {
    const receipt = balancedReceipt();
    return { ...receipt, runs: receipt.runs.slice(0, 1) };
  }

  it("withholds the rows of the split that does not add up", async () => {
    const container = await renderSettledPage(bridgeServing(receiptMissingARun()), SESSION_ID);
    const runsText = sectionText(container, "Per run");
    expect(runsText).toContain("does not account for the figure");
    expect(tableRowsUnder(container, "Per run")).toHaveLength(0);
    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
  });

  it("negative control: the two healthy splits still render their rows", async () => {
    // Without this, the case above would pass over a page that blanked the whole
    // receipt on one bad axis — which would hide two splits that are perfectly sound.
    const container = await renderSettledPage(bridgeServing(receiptMissingARun()), SESSION_ID);
    expect(tableRowsUnder(container, "Per party")).toHaveLength(2);
    expect(tableRowsUnder(container, "Per paying account")).toHaveLength(1);
    expect(sectionText(container, "Per party")).not.toContain("does not account for the figure");
  });

  it("still renders the figure the daemon settled", async () => {
    // The figure is not in doubt — only the split is. Withholding it would be the
    // page deciding the accountant was wrong.
    const container = await renderSettledPage(bridgeServing(receiptMissingARun()), SESSION_ID);
    expect(
      container.querySelector<HTMLElement>(".meridian-cost-receipt__figure span")?.textContent,
    ).toBe("$123.00");
  });
});

describe("the cost page — what it says out loud", () => {
  it("announces the settlement once, politely, with what it read", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    expect(politeText(container)).toBe(
      "Cost receipt read. Rows: 2 by run, 2 by party, 1 by account.",
    );
  });

  it("announces the refusal's own sentence rather than a paraphrase", async () => {
    const refusal = growthUnavailable("orchestrationCostReceiptRead");
    const container = await renderSettledPage(bridgeAnswering(refusal).bridge, SESSION_ID);
    expect(politeText(container)).toBe(refusal.detail);
  });

  it("negative control: a re-render neither re-reads nor speaks again", async () => {
    // One read is one announcement, so the assertion that nothing is said twice is
    // the assertion that nothing is asked twice.
    const answered = bridgeAnswering({ status: "served", value: balancedReceipt() });
    const context = settingsPageContextWith(answered.bridge, SESSION_ID);
    const view = render(
      <LiveAnnouncerProvider>
        <CostReceiptPage context={context} />
      </LiveAnnouncerProvider>,
    );
    await settle();
    expect(answered.readReceipt).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <LiveAnnouncerProvider>
          <CostReceiptPage context={context} />
        </LiveAnnouncerProvider>,
      );
      await crossMacrotaskBoundary();
    });
    expect(answered.readReceipt).toHaveBeenCalledTimes(1);
    expect(politeText(view.container)).toBe(
      "Cost receipt read. Rows: 2 by run, 2 by party, 1 by account.",
    );
  });

  it("reads the budget wire for no reason, ever", async () => {
    // The receipt carries the session total, so a second read of the same fold would
    // be two answers with nothing able to say which was newer.
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    const readBudget = vi.fn(
      async () => await Promise.resolve(growthUnavailable("orchestrationBudgetRead")),
    );
    await renderSettledPage(
      {
        ...fixture,
        growth: {
          ...fixture.growth,
          orchestrationCostReceiptRead: async () =>
            await Promise.resolve<CostReceiptOutcome>({
              status: "served",
              value: balancedReceipt(),
            }),
          orchestrationBudgetRead: readBudget,
        },
      },
      SESSION_ID,
    );
    expect(readBudget).not.toHaveBeenCalled();
  });
});

describe("the cost page — its rail entry", () => {
  it("claims the cost section with a search vocabulary", () => {
    const registry = new SettingsPageRegistry();
    registerCostReceiptPage(registry);
    const descriptor = registry.descriptorFor("cost");
    expect(descriptor?.label).toBe("Session cost");
    expect(descriptor?.keywords).toContain("receipt");
  });

  it("names no governance work anywhere a person reads", async () => {
    const text =
      (await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID)).textContent ?? "";
    expect(text).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I)-\d/u);
  });
});
