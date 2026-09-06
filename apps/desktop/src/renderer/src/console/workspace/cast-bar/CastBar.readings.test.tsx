// The three things the bar READS, once each session is scripted to answer them.
//
// `CastBar.absence.test.tsx` next door is this suite's negative half and stays that
// way: it renders against a scenario that answers none of the three, and every one of
// its cases is about what the bar draws when it has not been told. This one answers
// all three and asserts the bar renders the answer VERBATIM — the state word, the
// title, the count, and the accountant's own figure — because a surface that renders
// its absences correctly and its answers approximately is the worse of the two bugs:
// the absence is visibly an absence and a wrong figure is not visibly wrong.

import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import { CastBar } from "./CastBar.js";
import {
  CAST_BAR_SILENT_SCENARIO,
  SESSION_ID,
  renderBar,
  storeWith,
} from "./CastBar.test-support.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/index.js";

/** How the session names itself, where a scenario says so. */
const DISPLAY_TITLE = "Ship the ledger";

/** How many settle passes the bar's chained reads take. Three reads, one effect each. */
const READ_SETTLE_PASSES = 4;

/**
 * The silent scenario with answers added, so a case varies one reply and nothing else.
 *
 * Built from the silent one rather than from a scenario a screen was designed around:
 * what is under test is the bar's reading of a reply, so the roster, the beats, and
 * the clock all stay exactly what the other suite renders against.
 */
function scenarioAnswering(replies: ConsoleScenario["replies"]): ConsoleScenario {
  return { ...CAST_BAR_SILENT_SCENARIO, id: "cast-bar-answers", replies };
}

/** A `session.read` reply carrying a state, and a title where one is given. */
function sessionReadReply(state: string, title?: string): ConsoleScenario["replies"][number] {
  return {
    call: "session.read",
    result: {
      session: {
        id: SESSION_ID,
        state,
        config: {},
        metadata: title === undefined ? {} : { title },
        createdAt: "2026-01-01T14:20:00.000Z",
        updatedAt: "2026-01-01T14:20:00.000Z",
      },
      timelineCursors: { latest: "cast-bar-cursor-1" },
    },
  };
}

/** A health reply whose components carry the states this case is about. */
function healthReply(
  overall: string,
  componentStates: Readonly<Record<string, string>>,
): ConsoleScenario["replies"][number] {
  return {
    call: "health.statusRead",
    result: {
      overall,
      components: Object.entries(componentStates).map(([component, state]) => ({
        component,
        state,
        observedAt: "2026-01-01T14:20:00.000Z",
      })),
    },
  };
}

/** A budget reply whose committed figure and pricing status this case is about. */
function budgetReply(
  committedSpendCents: number,
  costStatus: string,
): ConsoleScenario["replies"][number] {
  return {
    call: "orchestration.budgetRead",
    result: {
      sessionId: SESSION_ID,
      costLimitCents: 500_00,
      turnLimitPerAgent: 40,
      maxExecutingChannels: 4,
      maxQueueDepthPerChannel: 8,
      maxPendingOrchestrationRuns: 4,
      activeChildLimit: 2,
      unpricedFamilyCaps: [],
      observedCostCents: committedSpendCents,
      reservedCostCents: 0,
      observedPricedCostCents: committedSpendCents,
      observedUnpricedDebitCents: 0,
      committedSpendCents,
      costStatus,
    },
  };
}

/** The bar over a session with one member, answered by `replies`. */
async function barAnswering(replies: ConsoleScenario["replies"]): Promise<HTMLElement> {
  const bar = renderBar(
    <CastBar
      sessionId={SESSION_ID}
      sessionStore={storeWith(["participant-you"])}
      onFollow={() => undefined}
    />,
    { scenario: scenarioAnswering(replies) },
  );
  await settle(READ_SETTLE_PASSES);
  return bar;
}

describe("the cast bar — the session it is naming", () => {
  it("renders the wire's own session state, underscore and all", async () => {
    // `purge_requested` rather than `active`: it is the one state whose wire spelling
    // a renderer would be tempted to tidy, and rule 4 forbids exactly that. A bar
    // showing "Purge requested" is a bar that edited a value the daemon sent.
    const bar = await barAnswering([sessionReadReply("purge_requested")]);

    expect(bar.querySelector(".meridian-cast-bar__identity")?.textContent).toContain(
      "purge_requested",
    );
  });

  it("renders a display title and says on the element that it is metadata", async () => {
    const bar = await barAnswering([sessionReadReply("active", DISPLAY_TITLE)]);
    const title = bar.querySelector(".meridian-cast-bar__session-title");

    expect(title?.textContent).toBe(DISPLAY_TITLE);
    // No registered session shape carries a name field, so a reader who wonders where
    // this came from gets the honest answer from the element itself.
    expect(title?.getAttribute("title")).toBe("Session metadata title");
    // And the id is still there: the title is an addition to the identity, never a
    // replacement for the one unambiguous name the session has.
    expect(bar.querySelector(".meridian-cast-bar__identity")?.textContent).toContain(SESSION_ID);
  });

  it("negative control: a session with no title renders none rather than a placeholder", async () => {
    // Without this the case above would pass over a bar that drew a "not named" badge
    // for every untitled session — which is most of them, and which would report a
    // missing answer where the answer is that this session has no name.
    const bar = await barAnswering([sessionReadReply("active")]);

    expect(bar.querySelector(".meridian-cast-bar__session-title")).toBeNull();
    expect(bar.textContent).not.toContain(DISPLAY_TITLE);
  });
});

describe("the cast bar — the node's health, in one mark", () => {
  it("counts the components that are not healthy and names them", async () => {
    const bar = await barAnswering([
      healthReply("degraded", { "session-store": "healthy", relay: "degraded", pty: "failing" }),
    ]);
    const status = bar.querySelector(".meridian-cast-bar__status");

    expect(status?.textContent).toContain("2 components not healthy");
    // Counted against `healthy` rather than against a list of bad states: the wire's
    // component vocabulary is not closed here, and a fold written against the two
    // states this scenario happens to use would count a third as healthy.
    expect(status?.textContent).toContain("relay");
    expect(status?.textContent).toContain("pty");
    expect(status?.textContent).not.toContain("session-store");
  });

  it("says one component in the singular", async () => {
    const bar = await barAnswering([healthReply("degraded", { relay: "degraded" })]);

    expect(bar.querySelector(".meridian-cast-bar__status")?.textContent).toContain(
      "1 component not healthy",
    );
  });

  it("negative control: a healthy node gets no mark at all", async () => {
    // Without this the cases above would pass over a bar that marked every node —
    // and a mark that is always on screen is a mark nobody sees when it matters.
    const bar = await barAnswering([
      healthReply("healthy", { "session-store": "healthy", relay: "healthy" }),
    ]);

    expect(bar.querySelector(".meridian-cast-bar__status")).toBeNull();
  });

  it("draws health as unread rather than as healthy when nothing answered", async () => {
    // The one wrong answer a health surface can give. An unanswered read renders the
    // "not checked" kind of nothing, never the absence of a mark, which is what a
    // healthy node looks like.
    const bar = await barAnswering([]);
    const status = bar.querySelector(".meridian-cast-bar__status");

    expect(status?.querySelector(".meridian-nothing__badge-label")?.textContent).toBe(
      "Node health",
    );
  });
});

describe("the cast bar — the accountant's figure", () => {
  it("renders the committed figure the accountant settled, and sums nothing", async () => {
    const bar = await barAnswering([budgetReply(12_47, "priced")]);
    const spend = bar.querySelector(".meridian-cast-bar__spend");

    expect(spend?.textContent).toContain("$12.47");
    // The exact cents ride the tooltip, so the wire's own integer is recoverable from
    // a figure the console formatted for reading.
    expect(spend?.querySelector(".meridian-figure--wire")?.getAttribute("title")).toBe(
      "1247 cents committed",
    );
    // A priced figure is a total and says nothing more.
    expect(spend?.textContent).not.toContain("at least");
  });

  it("marks an unpriced figure as a floor rather than presenting it as a total", async () => {
    const bar = await barAnswering([budgetReply(9_00, "unpriced")]);
    const spend = bar.querySelector(".meridian-cast-bar__spend");

    expect(spend?.textContent).toContain("$9.00");
    expect(spend?.textContent).toContain("at least");
  });

  it("negative control: an unanswered read draws no figure at all", async () => {
    // Without this the cases above would pass over a bar that rendered a zero for a
    // session it had read nothing about — which is the one rendering that is actively
    // false, because "$0.00" is a claim and an absence is not.
    const bar = await barAnswering([]);

    expect(bar.querySelector(".meridian-cast-bar__spend")).toBeNull();
    expect(bar.querySelector(".meridian-cast-bar__all-clear")?.textContent).not.toMatch(
      /\$|\d+\.\d\d/,
    );
  });
});
