// What this room's ledger read answers, and the two things that move it.
//
// THE CLOCK. The room's stated purpose includes "one invitation about to expire", and
// until the ledger read folded through the lifecycle rule nothing in the fixture could
// reach the second half of that sentence: `invites.list` answered a fixed `pending` row
// forever, so a console driven past the declared expiry — by remounting the section, by
// minting a second invitation, by opening the room an hour in — kept showing an
// invitation on the brink and kept offering Revoke on it.
//
// AND THE ACTS. The other half, and it was missing outright: `invite.create` answered
// with a mint receipt and `invite.revoke` with a state, and the read a moment later
// still returned the two rows the room opens with. So the fixture reported a success
// and then showed a ledger the invitation was not in, and the create-to-ledger
// transition the sent-invite surface exists for could be exercised by nothing at all.
//
// DRIVEN THROUGH THE REAL SEAM, never through a fold function alone. What broke in both
// halves was the path from a call to an answer: the engine's frozen clock, the
// scripted-reply settlement, the call door that settles a mutation, and the growth port
// that serves the read. A case that called the fold directly would pass against a
// bridge that wired it to nothing.

import { describe, expect, it } from "vitest";

import { InviteCreateResponseSchema, type DaemonMethod } from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "../../fixture/call-plane/bridge.js";
import type { ConsoleBridge } from "../../console-bridge.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import {
  INVITE_ACCEPTED,
  INVITE_EXPIRING,
  INVITE_MINTED,
  PARTICIPANT_YOU,
  collaborationMintedInviteId,
} from "./identifiers.js";

/** How far past tick zero the pending invitation's declared expiry sits. */
const INVITE_EXPIRY_MS = 40_000;

/** The latency this room scripts on the mint, spent on the frozen clock. */
const INVITE_CREATE_LATENCY_MS = 250;

/** The expiry the create form asks for in these cases. Well past every tick driven. */
const ASKED_EXPIRY = "2026-02-01T10:05:00.000Z";

const SESSION = { sessionId: COLLABORATION_SCENARIO.sessionId };

/** The whole ledger this read answers with, in the order it answers it. */
async function ledgerRowsFrom(bridge: ConsoleBridge): Promise<readonly unknown[]> {
  const outcome = await bridge.growth.invitesList(SESSION);
  expect(outcome.status).toBe("served");
  return outcome.status === "served" ? outcome.value : [];
}

/**
 * Mint one invitation through the real call door, spending its scripted latency.
 *
 * The call is ISSUED before the clock moves and awaited after, which is what a scripted
 * latency means: the reply is parked on the engine, and a case that advanced first
 * would be driving a seam with nothing waiting on it.
 */
async function mintThrough(bridge: ConsoleBridge, joinMode: string): Promise<unknown> {
  const minted = bridge.sidekicks.daemon.call(
    "invite.create" as DaemonMethod,
    {
      sessionId: COLLABORATION_SCENARIO.sessionId,
      inviter: PARTICIPANT_YOU,
      joinMode,
      expiresAt: ASKED_EXPIRY,
    } as never,
  );
  bridge.scenarioEngine?.advance(INVITE_CREATE_LATENCY_MS);
  return await minted;
}

/** Revoke one invitation through the real call door. No scripted latency on this one. */
async function revokeThrough(bridge: ConsoleBridge, inviteId: string): Promise<unknown> {
  return await bridge.sidekicks.daemon.call(
    "invite.revoke" as DaemonMethod,
    {
      sessionId: COLLABORATION_SCENARIO.sessionId,
      inviteId,
    } as never,
  );
}

/**
 * The identity one mint receipt carries, read through the registered response shape.
 *
 * Parsed rather than cast, because the identity is DERIVED per mint and the derivation
 * has a contract to meet: `InviteCreateResponse.inviteId` is a branded UUID, so a
 * sequence spelled any other way would be a receipt the call door rejects — and that
 * rejection is the failure this reader turns into a legible one.
 */
function mintedReceiptOf(receipt: unknown): { readonly inviteId: string; readonly token: string } {
  const parsed = InviteCreateResponseSchema.safeParse(receipt);
  expect(parsed.error?.issues.map((issue) => issue.message) ?? []).toStrictEqual([]);
  return parsed.success ? parsed.data : { inviteId: "", token: "" };
}

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

describe("the collaboration room's ledger and the acts performed on it", () => {
  it("shows a minted invitation on the next read, carrying what the mint served", async () => {
    // The finding: the mint answered `INVITE_MINTED` and the read that follows it —
    // which is the read the sent-invite surface performs after every mint — returned
    // the two opening rows and nothing else. The row is asserted WHOLE, because the
    // interesting part is which half of the act each field came from: the id and the
    // expiry are the receipt's, and `joinMode` is the request's, since the registered
    // `InviteCreateResponse` carries none and a ledger row requires one.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await mintThrough(bridge, "viewer");

    await expect(ledgerRowsFrom(bridge)).resolves.toStrictEqual([
      {
        inviteId: INVITE_EXPIRING,
        state: "pending",
        expiresAt: expect.any(String),
        joinMode: "collaborator",
      },
      {
        inviteId: INVITE_ACCEPTED,
        state: "accepted",
        expiresAt: expect.any(String),
        joinMode: "viewer",
      },
      { inviteId: INVITE_MINTED, state: "pending", expiresAt: ASKED_EXPIRY, joinMode: "viewer" },
    ]);
  });

  it("moves the row a served revoke names, and leaves every other row alone", async () => {
    // The revoke half. Put on the row the room OPENS with rather than on the minted one,
    // because that is the harder case and the one a person actually reaches: the ledger
    // holds no copy of a scripted row, so a fixture that recorded the state onto its own
    // minted list could not have moved this one at all.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await revokeThrough(bridge, INVITE_EXPIRING);

    const states = await ledgerStatesFrom(bridge);
    expect(states[INVITE_EXPIRING]).toBe("revoked");
    expect(states[INVITE_ACCEPTED]).toBe("accepted");
  });

  it("keeps a revoked row revoked past the expiry that would have aged it", async () => {
    // The two movers meet here, and the order between them is the claim: an act decided
    // this row's state and the clock did not, so ageing it to `expired` afterwards would
    // report a transition the daemon never makes off a terminal state.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await revokeThrough(bridge, INVITE_EXPIRING);
    bridge.scenarioEngine?.advance(INVITE_EXPIRY_MS * 4);

    await expect(ledgerStatesFrom(bridge)).resolves.toMatchObject({
      [INVITE_EXPIRING]: "revoked",
    });
  });

  it("negative control: a read taken before any act shows only the opening rows", async () => {
    // Without it every case above would pass over a fixture that appended a minted row
    // to every ledger read it ever answered.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await expect(ledgerRowsFrom(bridge)).resolves.toHaveLength(2);
  });
});

describe("the collaboration room's mint receipts", () => {
  // The two mints are driven with IDENTICAL requests, which is what makes these cases
  // about the receipt rather than about the form: the expiry and the join mode are the
  // caller's and the same both times, so the only thing that can tell the two
  // invitations apart is the identity the room mints for each.
  const MINT_JOIN_MODE = "viewer";

  it("mints a distinct identity per call, receipt and credential alike", async () => {
    // The finding: `invite.create` answered with one fixed id for the life of the
    // window. A person who dismissed the first link reveal and sent another invitation
    // got the first one's identity back.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    const first = mintedReceiptOf(await mintThrough(bridge, MINT_JOIN_MODE));
    const second = mintedReceiptOf(await mintThrough(bridge, MINT_JOIN_MODE));

    expect(first.inviteId).toBe(INVITE_MINTED);
    expect(second.inviteId).toBe(collaborationMintedInviteId(2));
    // The token moves with the identity: it is handed out exactly once per invitation,
    // so two live reveals showing one credential would be teaching a control plane that
    // reissues them.
    expect(second.token).not.toBe(first.token);
  });

  it("leaves the ledger one row per mint, each under its own key", async () => {
    // The consequence on the read, which is where a person meets it: the ledger appends
    // a row per served mint, so a shared identity put two rows under one key — which a
    // list keyed by invite id draws as duplicate React keys.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await mintThrough(bridge, MINT_JOIN_MODE);
    await mintThrough(bridge, MINT_JOIN_MODE);

    const rows = await ledgerRowsFrom(bridge);
    const inviteIds = rows.map((row) => (row as { readonly inviteId: string }).inviteId);
    expect(rows).toHaveLength(4);
    expect(new Set(inviteIds).size).toBe(inviteIds.length);
  });

  it("revokes the minted row the caller named, and leaves the other mint alone", async () => {
    // The consequence a shared identity had that a row count alone does not show: the
    // ledger records a state move in a map keyed by invite id, so one revoke on a
    // duplicated key moved BOTH rows at once.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    const first = mintedReceiptOf(await mintThrough(bridge, MINT_JOIN_MODE));
    const second = mintedReceiptOf(await mintThrough(bridge, MINT_JOIN_MODE));
    await revokeThrough(bridge, first.inviteId);

    const states = await ledgerStatesFrom(bridge);
    expect(states[first.inviteId]).toBe("revoked");
    expect(states[second.inviteId]).toBe("pending");
  });

  it("negative control: one mint still appends exactly one row", async () => {
    // Without it a reply that minted a fresh identity per ASK rather than per served
    // mint would pass the cases above while quietly filling the ledger — and the same
    // control catches the opposite fix, a ledger that appended a row per read.
    const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });

    await mintThrough(bridge, MINT_JOIN_MODE);

    await expect(ledgerRowsFrom(bridge)).resolves.toHaveLength(3);
    await expect(ledgerRowsFrom(bridge)).resolves.toHaveLength(3);
  });
});
