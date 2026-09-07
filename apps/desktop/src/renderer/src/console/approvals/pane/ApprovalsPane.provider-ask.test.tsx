// The join: a projection row, the entity the fold built from the same request, and
// the framing that exists only where the two agree there was a provider ask.
//
// Its own file rather than more cases in `ApprovalsPane.test.tsx`, because the
// subject is different: that file drives the pane over the read alone, and this one
// is about what the pane does when the STORE holds something the read does not
// carry. Both drive the shipped fixture bridge and the shipped scenario; the one
// thing this file builds is the store, because the point is which fold it was opened
// with.

import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApprovalsPane } from "./ApprovalsPane.js";
import { APPROVAL_FLOW_PROJECTORS } from "../../bridge/approvals/approval-flow-projection.js";
import { storeOver } from "../../bridge/approvals/approval-flow-projection.test-support.js";
import { createFixtureBridge } from "../../bridge/index.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import type { SessionStore } from "../../store/index.js";
import { approvalsPaneContext, settle } from "./approvals-pane.test-support.js";

/** The request the scenario raises as a provider permission ask. */
const ASK_APPROVAL_ID = "019b7a33-3300-7f01-8140-d1a4c1150524";
/** The request the scenario raises directly. Both are pending, so both render. */
const DIRECT_APPROVAL_ID = "019b7a33-3300-7f01-8130-d1a4c1150523";
/**
 * A settled record the reply returns and no beat names.
 *
 * The malformed-pairing case needs a request whose entity this test alone builds:
 * every request the scenario's own beats raise already carries the deadline the wire
 * requires, and the store's merge keeps what an earlier event named — so injecting a
 * deadline-less beat for one of those would produce an entity that still had one.
 */
const UNBEATEN_APPROVAL_ID = "019b7a33-3300-7f01-8150-d1a4c1150525";
const ASK_EXPIRY = "2026-01-01T17:30:01.100Z";

/**
 * The sequence the injected beat below takes, derived from the scenario it lands
 * beside rather than written as a number.
 *
 * A literal one directory away from a growing fixture is a collision waiting to
 * happen, and the collision is SILENT: the store applies one event per sequence, so
 * a beat sharing a number with a scenario beat is simply not folded, and the case
 * fails much later with a card that renders without the body the injection was for.
 * Read off the scenario, the injection is past its end however many beats it grows.
 */
const PAST_EVERY_SCENARIO_BEAT =
  Math.max(...APPROVALS_SCENARIO.beats.map((beat) => beat.event.sequence)) + 1;

/** Mount the pane over the fixture bridge and let both reads settle. */
async function mountOver(sessionStore: SessionStore): Promise<HTMLElement> {
  const bridge = createFixtureBridge({ scenario: APPROVALS_SCENARIO });
  let container: HTMLElement | undefined;
  await act(async () => {
    container = render(<ApprovalsPane {...approvalsPaneContext(bridge, sessionStore)} />).container;
  });
  await settle(bridge);
  if (container === undefined) {
    throw new Error("the pane rendered no container");
  }
  return container;
}

/** One card, found by the record it belongs to — never the first in DOM order. */
function cardFor(container: HTMLElement, approvalRequestId: string): HTMLElement {
  const card = container.querySelector(`[data-approval-id="${approvalRequestId}"]`);
  if (!(card instanceof HTMLElement)) {
    throw new Error(`no card is rendered for approval ${approvalRequestId}`);
  }
  return card;
}

function textOf(card: HTMLElement, selector: string): string | undefined {
  const element = card.querySelector(selector);
  return element instanceof HTMLElement ? (element.textContent ?? "") : undefined;
}

describe("a projection row whose entity carries an ask", () => {
  it("frames it as a provider ask and reads its deadline against the shared clock", async () => {
    const container = await mountOver(storeOver(APPROVAL_FLOW_PROJECTORS));
    const card = cardFor(container, ASK_APPROVAL_ID);

    // The origin, from the event payload — the projection reply registers no member
    // that could have said this.
    expect(textOf(card, ".meridian-approval-ask__origin")).toContain("ask-permission-force-push");
    // The deadline, as the instant the daemon sent plus a reading of it.
    expect(textOf(card, ".meridian-approval-ask__deadline")).toContain(ASK_EXPIRY);
    expect(textOf(card, ".meridian-approval-ask__deadline")).toContain("Answer needed");
    expect(card.querySelector(".meridian-approval-ask__missing")).toBeNull();
    // The two answers stay the card's two: the framing adds no third decision and no
    // free-text field, because a permission ask is settled as an approval.
    expect(card.querySelectorAll(".meridian-approval-card__action")).toHaveLength(2);
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("negative control: the request raised directly renders the ordinary card", async () => {
    // Same list, same read, same render pass. Without this the case above would pass
    // over a pane that framed every card as a provider ask.
    const container = await mountOver(storeOver(APPROVAL_FLOW_PROJECTORS));
    expect(
      cardFor(container, DIRECT_APPROVAL_ID).querySelector(".meridian-approval-ask"),
    ).toBeNull();
  });
});

describe("a projection row the store holds no entity for", () => {
  it("renders the ordinary card rather than a framing it cannot justify", async () => {
    // The state every approvals surface was built against, and the state a live
    // session is in until the fold catches up: the read answered and the partition
    // is empty. Every card renders; none is framed.
    const container = await mountOver(storeOver(undefined));
    expect(container.querySelectorAll(".meridian-approval-ask")).toHaveLength(0);
    expect(cardFor(container, ASK_APPROVAL_ID)).not.toBeNull();
  });
});

describe("an ask whose body broke the wire's ask-implies-deadline pairing", () => {
  it("frames it, shows no deadline, and counts it once", async () => {
    // Not a shape a conformant daemon sends — and inventing a deadline for it would
    // put a time on screen no daemon sent, while dropping the framing would hide a
    // provider ask because one of its two members was missing.
    const container = await mountOver(
      storeOver(APPROVAL_FLOW_PROJECTORS, [
        {
          id: "019b7a33-3300-7e00-8110-e5e0c3350099",
          sessionId: APPROVALS_SCENARIO.sessionId,
          sequence: PAST_EVERY_SCENARIO_BEAT,
          kind: "approval.requested",
          occurredAt: "2026-01-01T13:30:02.000Z",
          payload: {
            sessionId: APPROVALS_SCENARIO.sessionId,
            approvalRequestId: UNBEATEN_APPROVAL_ID,
            askId: "ask-with-no-deadline",
            category: "file_write",
            scope: "session",
          },
        },
      ]),
    );
    const card = cardFor(container, UNBEATEN_APPROVAL_ID);

    expect(textOf(card, ".meridian-approval-ask__origin")).toContain("ask-with-no-deadline");
    expect(card.querySelector(".meridian-approval-ask__deadline")).toBeNull();
    expect(textOf(card, ".meridian-approval-ask__missing")).toContain("without the deadline");
    // Counted once, in the list's own summary line, so the list does not go on
    // claiming everything in it was whole.
    expect(
      screen.getAllByText(/1 of these were raised by a provider without the deadline/u),
    ).toHaveLength(1);
  });

  it("negative control: the conformant ask adds no such count", async () => {
    const container = await mountOver(storeOver(APPROVAL_FLOW_PROJECTORS));
    expect(
      cardFor(container, ASK_APPROVAL_ID).querySelector(".meridian-approval-ask"),
    ).not.toBeNull();
    expect(screen.queryByText(/raised by a provider without the deadline/u)).toBeNull();
  });
});
