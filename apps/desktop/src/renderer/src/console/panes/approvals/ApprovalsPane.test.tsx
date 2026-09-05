// The approvals pane: both reads, where they render, what arrival does to focus, and
// what an empty list may not hide.
//
// One unfiltered read rendered in two places, standing permissions riding the same
// pane, and an arrival that is announced without stealing focus. The last case is the
// one the rest exist for: an empty list is never allowed to stand in for a read that
// refused.

import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalsPane } from "./ApprovalsPane.js";
import {
  createFixtureBridge,
  type ApprovalRecord,
  type ConsoleBridge,
  type ParsedRows,
} from "../../bridge/index.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { COMPOSER_SCENARIO } from "../../bridge/scenarios/composer.js";
import {
  ScriptedApprovalReads,
  WAITING_APPROVAL_IDS,
  approvalsPaneContext,
  boundStore,
  composerHoldingFocus,
  mountPane,
  section,
  settle,
  stubApprovalsBridge,
  waitingRecord,
} from "./approvals-pane.test-support.js";

describe("an unbound pane", () => {
  it("says it is unbound rather than reporting an empty queue", async () => {
    const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
    await act(async () => {
      render(<ApprovalsPane {...approvalsPaneContext(bridge, undefined)} />);
    });
    expect(screen.getByText("This pane is not bound to a session.")).not.toBeNull();
    // Negative control on the whole surface: nothing was read, so no section that
    // could be mistaken for an answer is rendered.
    expect(screen.queryByRole("region", { name: "Waiting on a decision" })).toBeNull();
  });
});

describe("the four phases of one read", () => {
  it("shows the read in flight before the scheduler fires", async () => {
    await mountPane();
    // Not "nothing needs a decision": the read has not answered, and the two are
    // different next moves for whoever is looking at it.
    expect(screen.getAllByText("Reading the approval queue.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing needs a decision.")).toBeNull();
  });

  it("renders the daemon's refusal when the read is refused", async () => {
    // The composer scenario scripts neither approval read, so the fixture rejects
    // — which is what makes the refusal arm reachable rather than hypothetical.
    const bridge = await mountPane(COMPOSER_SCENARIO);
    await settle(bridge);
    expect(screen.getAllByText("reply-unscripted").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing needs a decision.")).toBeNull();
  });
});

describe("one unfiltered read, rendered in two places", () => {
  it("splits the answered read into what is waiting and what is decided", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = within(section("Waiting on a decision")).getAllByRole("article");
    const history = within(section("Decision history")).getAllByRole("article");
    // Six records in the scenario: the two pending ones wait, the other four are
    // history. Every record appears in exactly one list, which is what makes the
    // split a rendering rather than a filter.
    expect(waiting).toHaveLength(2);
    expect(history).toHaveLength(4);
  });

  it("labels every state the read returned and drops none of them", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const history = section("Decision history");
    for (const phrase of ["Approved", "Rejected", "Expired", "Canceled"]) {
      expect(within(history).getByText(phrase)).not.toBeNull();
    }
    // Negative control: the terminal states are in HISTORY and not in the queue, so
    // "drops nothing" is not passing because everything landed in one bucket.
    expect(within(section("Waiting on a decision")).queryByText("Approved")).toBeNull();
  });

  it("names the run each waiting request was raised by", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = section("Waiting on a decision");
    // `runId` is required on every registered row, so every card can say it — and
    // which run raised a request is the first thing anyone answering one asks.
    expect(within(waiting).getAllByText("Raised by run")).toHaveLength(2);
  });

  it("states the wait-for-all barrier over the group rather than grouping cards", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText(/approved only if all of them are approved/u)).not.toBeNull();
    // No card claims membership of a set: the read carries no grouping key, and a
    // fabricated one would assert a dependency the wire never reported.
    expect(within(waiting).queryByText(/barrier/iu)).toBeNull();
  });
});

describe("standing permissions ride the same pane", () => {
  it("lists the rules the read returned, revoked ones included", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const permissions = section("Standing permissions");
    expect(within(permissions).getAllByRole("listitem")).toHaveLength(3);
    expect(within(permissions).getByText(/grantor.s membership changed/u)).not.toBeNull();
  });
});

describe("arrival is announced, and focus is not stolen", () => {
  it("announces the waiting decision in an assertive region", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    const live = document.querySelector('[aria-live="assertive"]');
    expect(live?.textContent).toContain("decisions are waiting");
  });

  it("leaves focus where it was when the composer did not hold it", async () => {
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    const bridge = await mountPane();
    await settle(bridge);
    // A person reading a diff, or mid-sentence in a field this pane knows nothing
    // about, keeps their caret — the announcement is the whole notification.
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

describe("the sections whose wire this pane does not open", () => {
  it("renders the execution boundary as unknown rather than guessing one", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    expect(
      within(section("Execution boundary")).getByText("Execution boundary unknown"),
    ).not.toBeNull();
  });

  it("says the daemon-hosted tool registry has not been read", async () => {
    const bridge = await mountPane();
    await settle(bridge);
    expect(
      within(section("Daemon-hosted tools")).getByText(
        "The daemon-hosted tool registry has not been read.",
      ),
    ).not.toBeNull();
  });
});

describe("focus lands in the card that arrived", () => {
  it("focuses the arriving record's own action, not the first one on the page", async () => {
    const reads = new ScriptedApprovalReads();
    const bridge = stubApprovalsBridge(reads);
    await act(async () => {
      render(<ApprovalsPane {...approvalsPaneContext(bridge, boundStore())} />);
    });
    await settle(bridge);
    const waiting = within(section("Waiting on a decision")).getAllByRole("article");
    expect(waiting).toHaveLength(2);

    const composer = composerHoldingFocus();
    reads.admitThird();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(bridge);

    const arrived = WAITING_APPROVAL_IDS[2];
    const focusedCard = document.activeElement?.closest("[data-approval-id]");
    expect(focusedCard?.getAttribute("data-approval-id")).toBe(arrived);
    // The negative control on the selector this replaces: the first action in DOM
    // order belongs to a card that was already on screen, so a document-wide query
    // would have taken the caret to a request the announcement did not name.
    expect(document.querySelector(".meridian-approval-card__action")).not.toBe(
      document.activeElement,
    );
    composer.remove();
  });
});

// An answered read whose records this build cannot decode. Reachable only against a
// stub: every shipped scenario answers rows the parser reads, which is what those
// fixtures are for.
async function mountOverReply(reply: ParsedRows<ApprovalRecord>): Promise<ConsoleBridge> {
  const bridge = stubApprovalsBridge({ reply: () => reply });
  await act(async () => {
    render(<ApprovalsPane {...approvalsPaneContext(bridge, boundStore())} />);
  });
  await settle(bridge);
  return bridge;
}

describe("an empty list never hides what could not be read", () => {
  it("says the read was partial rather than that nothing needs a decision", async () => {
    await mountOverReply({ rows: [], unreadableCount: 3 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText("Part of this read could not be decoded.")).not.toBeNull();
    expect(within(waiting).getByText(/\b3\b/u)).not.toBeNull();
    // The negative control on the branch this replaces: the reassuring empty state
    // used to render here, and it must not, because requests may be waiting.
    expect(within(waiting).queryByText("Nothing needs a decision.")).toBeNull();
  });

  it("renders the served empty set unchanged when nothing was unreadable", async () => {
    await mountOverReply({ rows: [], unreadableCount: 0 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getByText("Nothing needs a decision.")).not.toBeNull();
    expect(within(waiting).queryByText("Part of this read could not be decoded.")).toBeNull();
  });

  it("keeps the list and the warning together when both are true", async () => {
    await mountOverReply({ rows: [waitingRecord(WAITING_APPROVAL_IDS[0])], unreadableCount: 1 });
    const waiting = section("Waiting on a decision");
    expect(within(waiting).getAllByRole("article")).toHaveLength(1);
    expect(within(waiting).getByText(/could not read/u)).not.toBeNull();
  });
});
