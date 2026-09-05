// The cost page: which absence it renders, what a served receipt puts on screen, and
// the one thing it refuses to show.
//
// The case worth the most is the withheld split. A receipt whose rows do not add to
// the figure is a row counted twice or dropped, and a table that drew them anyway
// would present a breakdown of a number it does not break down — while its two
// healthy neighbours still have to render, because a defect on one axis is not
// evidence against the others.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFixtureBridge,
  growthUnavailable,
  type ConsoleBridge,
} from "../../../bridge/index.js";
import { LiveAnnouncerProvider } from "../../../primitives/index.js";
import { CostReceiptPage, registerCostReceiptPage } from "./CostReceiptPage.js";
import type { CostReceipt, CostReceiptOutcome } from "./cost-receipt-model.js";
import { SettingsPageRegistry, type SettingsPageContext } from "../../settings-page-registry.js";
import { settle as settlePasses } from "../../../core/settle.test-support.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];

const SESSION_ID = "session-cost";

afterEach(() => {
  cleanup();
});

/** A scenario that scripts nothing: the growth override is what these cases drive. */
const EMPTY_SCENARIO: FixtureScenario = {
  id: "collaboration-cost-test",
  label: "Cost, with nothing scripted",
  purpose: "Drives the cost receipt page against an overridden receipt read.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

/** A budget state whose decomposition members agree with each other. */
function budgetState(committedSpendCents: number): CostReceipt["sessionTotal"] {
  return {
    sessionId: SESSION_ID,
    costLimitCents: 500_000,
    turnLimitPerAgent: 40,
    maxExecutingChannels: 4,
    maxQueueDepthPerChannel: 8,
    maxPendingOrchestrationRuns: 6,
    activeChildLimit: 2,
    unpricedFamilyCaps: [],
    observedCostCents: committedSpendCents,
    reservedCostCents: 0,
    observedPricedCostCents: committedSpendCents,
    observedUnpricedDebitCents: 0,
    committedSpendCents,
    costStatus: "priced",
  };
}

/** A receipt whose three axes each account for 12,300 cents. */
function balancedReceipt(): CostReceipt {
  return {
    sessionTotal: budgetState(12_300),
    runs: [
      { runId: "run-alpha", costCents: 8_000, costStatus: "priced", aggregationScope: "run-only" },
      { runId: "run-beta", costCents: 4_300, costStatus: "priced", aggregationScope: "run-only" },
    ],
    causedBy: [
      {
        party: { kind: "participant", participantId: "participant-ana" },
        costCents: 9_000,
        costStatus: "priced",
      },
      { party: { kind: "system" }, costCents: 3_300, costStatus: "priced" },
    ],
    byAccount: [
      {
        providerAccountId: "account-1",
        displayLabel: "work-anthropic",
        billingMode: "subscription",
        costCents: 12_300,
        costStatus: "priced",
      },
    ],
  };
}

function contextWith(bridge: ConsoleBridge, retainedSessionId: string | undefined) {
  return {
    bridge,
    openSection: () => undefined,
    retainedSessionId,
    retainedSessionStore: undefined,
  } satisfies SettingsPageContext;
}

/**
 * The real fixture bridge with the one operation this page reads overridden.
 *
 * The refusal arm builds the shipped port's own `growthUnavailable`, not a
 * hand-written envelope, so what these cases assert is what a release build produces.
 */
function bridgeAnswering(outcome: CostReceiptOutcome): {
  readonly bridge: ConsoleBridge;
  readonly readReceipt: ReturnType<typeof vi.fn>;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
  const readReceipt = vi.fn(async () => await Promise.resolve(outcome));
  return {
    bridge: {
      ...fixture,
      growth: { ...fixture.growth, orchestrationCostReceiptRead: readReceipt },
    },
    readReceipt,
  };
}

function bridgeServing(receipt: CostReceipt): ConsoleBridge {
  return bridgeAnswering({ status: "served", value: receipt }).bridge;
}

/** Let the one-shot read and the effects it schedules land. */
async function settle(): Promise<void> {
  await settlePasses(3);
}

function renderPage(bridge: ConsoleBridge, retainedSessionId: string | undefined): HTMLElement {
  const { container } = render(
    <LiveAnnouncerProvider>
      <CostReceiptPage context={contextWith(bridge, retainedSessionId)} />
    </LiveAnnouncerProvider>,
  );
  return container;
}

async function renderSettledPage(
  bridge: ConsoleBridge,
  retainedSessionId: string | undefined,
): Promise<HTMLElement> {
  const container = renderPage(bridge, retainedSessionId);
  await settle();
  return container;
}

function politeAnnouncement(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

/** The rows of one split's table, by the heading the section carries. */
function tableRowsUnder(container: HTMLElement, sectionLabel: string): HTMLElement[] {
  const section = container.querySelector<HTMLElement>(`section[aria-label="${sectionLabel}"]`);
  return [...(section?.querySelectorAll<HTMLElement>("tbody tr") ?? [])];
}

function sectionText(container: HTMLElement, sectionLabel: string): string {
  return (
    container.querySelector<HTMLElement>(`section[aria-label="${sectionLabel}"]`)?.textContent ?? ""
  );
}

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
    expect(politeAnnouncement(container)).toBe(
      "Cost receipt read. Rows: 2 by run, 2 by party, 1 by account.",
    );
  });

  it("announces the refusal's own sentence rather than a paraphrase", async () => {
    const refusal = growthUnavailable("orchestrationCostReceiptRead");
    const container = await renderSettledPage(bridgeAnswering(refusal).bridge, SESSION_ID);
    expect(politeAnnouncement(container)).toBe(refusal.detail);
  });

  it("negative control: a re-render neither re-reads nor speaks again", async () => {
    // One read is one announcement, so the assertion that nothing is said twice is
    // the assertion that nothing is asked twice.
    const answered = bridgeAnswering({ status: "served", value: balancedReceipt() });
    const context = contextWith(answered.bridge, SESSION_ID);
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
      await Promise.resolve();
    });
    expect(answered.readReceipt).toHaveBeenCalledTimes(1);
    expect(politeAnnouncement(view.container)).toBe(
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
