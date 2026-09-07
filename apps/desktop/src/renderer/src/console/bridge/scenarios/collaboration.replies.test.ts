// The one reply in this room that answers differently depending on when it is asked.
//
// The room's stated purpose includes "one invitation about to expire", and until the
// ledger read was computed nothing in the fixture could reach the second half of that
// sentence: `invites.list` answered a fixed `pending` row forever, so a console driven
// past the declared expiry — by remounting the section, by minting a second
// invitation, by opening the room an hour in — kept showing an invitation on the brink
// and kept offering Revoke on it.
//
// DRIVEN THROUGH THE REAL SEAM, not through the ageing function alone. What broke was
// the path from a call to an answer: the engine's frozen clock, the scripted-reply
// settlement, and the growth port that serves this operation. A case that only called
// the exported function would have passed against a reply table still holding a
// constant.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "../fixture/fixture-bridge.js";
import type { ConsoleBridge } from "../console-bridge.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import { INVITE_ACCEPTED, INVITE_EXPIRING } from "./collaboration.identifiers.js";

/** How far past tick zero the pending invitation's declared expiry sits. */
const INVITE_EXPIRY_MS = 40_000;

const SESSION = { sessionId: COLLABORATION_SCENARIO.sessionId };

/** The state each invite id reads as, right now, over the fixture's own growth port. */
async function ledgerStatesFrom(bridge: ConsoleBridge): Promise<Record<string, string>> {
  const outcome = await bridge.growth.invitesList(SESSION);
  expect(outcome.status).toBe("served");
  if (outcome.status !== "served") {
    return {};
  }
  return Object.fromEntries(outcome.value.map((invite) => [invite.inviteId, invite.state]));
}

describe("the collaboration room's sent-invite ledger", () => {
  it("reads the invitation as pending while its expiry is still ahead", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    const atStart = await ledgerStatesFrom(bridge);
    bridge.scenarioEngine?.advance(INVITE_EXPIRY_MS - 1);
    const justBefore = await ledgerStatesFrom(bridge);

    // The negative control for the case below: a ledger that aged its rows
    // unconditionally would answer `expired` here and this case would fail.
    expect(atStart[INVITE_EXPIRING]).toBe("pending");
    expect(justBefore[INVITE_EXPIRING]).toBe("pending");
  });

  it("reads it as expired once the frozen clock reaches the expiry, and ages nothing else", async () => {
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    bridge.scenarioEngine?.advance(INVITE_EXPIRY_MS);
    const atExpiry = await ledgerStatesFrom(bridge);

    expect(atExpiry[INVITE_EXPIRING]).toBe("expired");
    // The accepted row's own expiry is BEHIND tick zero, so a rule that aged on the
    // stamp alone rather than on the state would have reported it expired from the
    // first read — and an accepted invitation does not un-accept itself.
    expect(atExpiry[INVITE_ACCEPTED]).toBe("accepted");
  });

  it("keeps answering expired for every later read rather than once", async () => {
    // The defect was a read that did not move; a fix that moved it exactly once would
    // be the same defect one tick later.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    bridge.scenarioEngine?.advance(INVITE_EXPIRY_MS * 4);
    const first = await ledgerStatesFrom(bridge);
    const second = await ledgerStatesFrom(bridge);

    expect(first[INVITE_EXPIRING]).toBe("expired");
    expect(second[INVITE_EXPIRING]).toBe("expired");
  });
});
