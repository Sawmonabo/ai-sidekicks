// What the cost receipt is, what its absence renders, and what a served one draws.
//
// The three splits of the one figure, the session-less window that says the receipt
// belongs to a session rather than showing a zero, and the rows a served receipt
// produces. What a split that does not add up does, and what the page says out loud,
// is `CostReceiptPage.integrity.test.tsx`, over the one cast in
// `cost-receipt-page.test-support.tsx`.
import { describe, expect, it } from "vitest";
import { createFixtureBridge, growthUnavailable } from "../../../bridge/index.js";
import {
  EMPTY_SCENARIO,
  SESSION_ID,
  balancedReceipt,
  bridgeAnswering,
  bridgeServing,
  budgetState,
  renderPage,
  renderSettledPage,
  sectionText,
  tableRowsUnder,
} from "./cost-receipt-page.test-support.js";

describe("the cost page — what the receipt is", () => {
  it("names all three splits of the one figure", async () => {
    const text = (await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID))
      .textContent;
    for (const partition of ["Per run", "Per party", "Per paying account"]) {
      expect(text).toContain(partition);
    }
  });

  it("negative control: it names no fourth split", async () => {
    // Model-level pricing is not a partition of this fold, and a table of it would
    // be a second accountant rather than a fourth column.
    const text = (await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID))
      .textContent;
    expect(text).not.toMatch(/\bPer model\b/u);
  });

  it("forbids the arithmetic in the frame the body landed into", async () => {
    const text =
      (await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID)).textContent ?? "";
    expect(text).toContain("Nothing on screen is added up");
    expect(text).toContain("lower bound");
    expect(text).toContain("No total spans sessions");
    expect(text).toContain("the sum that check takes is never shown");
  });
});

describe("the cost page — the absence it renders", () => {
  it("says the receipt belongs to a session when this window has opened none", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), undefined);
    expect(container.textContent ?? "").toContain("belongs to a session");
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
  });

  it("negative control: with a session it renders the figure instead", async () => {
    // Without this, the case above would pass over a page that never asked at all.
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    expect(container.textContent ?? "").not.toContain("belongs to a session");
    expect(container.textContent ?? "").toContain("$123.00");
  });

  it("shows the read in flight rather than a zero", async () => {
    // A zero here would claim the session has spent nothing, which is a different
    // sentence from the answer not having arrived.
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    const container = renderPage(
      {
        ...fixture,
        growth: {
          ...fixture.growth,
          orchestrationCostReceiptRead: async () => await new Promise<never>(() => undefined),
        },
      },
      SESSION_ID,
    );
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(/\$\s?0\.00/u);
  });

  it("renders a refusal with the daemon's own code and sentence", async () => {
    const refusal = growthUnavailable("orchestrationCostReceiptRead");
    const container = await renderSettledPage(bridgeAnswering(refusal).bridge, SESSION_ID);
    const text = container.textContent ?? "";
    expect(text).toContain(refusal.code);
    expect(text).toContain(refusal.detail);
    // Nothing was invented in its place.
    expect(container.querySelector(".meridian-cost-receipt__table")).toBeNull();
  });
});

describe("the cost page — a served receipt", () => {
  it("renders the accountant's figure with the wire's own integer behind it", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    const figure = container.querySelector<HTMLElement>(".meridian-cost-receipt__figure span");
    expect(figure?.textContent).toBe("$123.00");
    // The eight rules: no formatted figure hides the number the daemon sent.
    expect(figure?.getAttribute("title")).toBe("12300");
  });

  it("puts the pricing status beside the figure as provenance", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    expect(sectionText(container, "What this session is charged")).toContain("priced");
    expect(container.textContent ?? "").toContain("It decides nothing");
  });

  it("renders one row per run, each carrying its own scope", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    const rows = tableRowsUnder(container, "Per run");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("run-alpha");
    expect(rows[0]?.textContent).toContain("run-only");
    expect(rows[0]?.textContent).toContain("$80.00");
  });

  it("names the machine itself rather than an empty party", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    const partyText = sectionText(container, "Per party");
    expect(partyText).toContain("participant-ana");
    expect(partyText).toContain("the machine itself");
  });

  it("never presents plan usage as currency owed", async () => {
    const container = await renderSettledPage(bridgeServing(balancedReceipt()), SESSION_ID);
    const accountText = sectionText(container, "Per paying account");
    expect(accountText).toContain("work-anthropic");
    expect(accountText).toContain("subscription");
    expect(accountText).toContain("not currency owed");
  });

  it("renders the figure and three empty splits for a session that has spent nothing", async () => {
    // The figure is the accountant's, not the page's claim — so it renders even when
    // no run has been priced, and the splits say they found none rather than nothing
    // being shown at all.
    const container = await renderSettledPage(
      bridgeServing({
        sessionTotal: budgetState(0),
        runs: [],
        causedBy: [],
        byAccount: [],
      }),
      SESSION_ID,
    );
    expect(
      container.querySelector<HTMLElement>(".meridian-cost-receipt__figure span")?.textContent,
    ).toBe("$0.00");
    expect(container.querySelectorAll(".meridian-nothing--empty")).toHaveLength(3);
    expect(container.querySelector(".meridian-cost-receipt__table")).toBeNull();
  });
});
