// The membership roster read's three pure readers: the entries a served answer
// carries, the refusal an unserved one carries, and the silence a read in flight is.
//
// Every arm matters because the ledger renders a different thing on each: rows with
// their identifiers, rows under a notice, and rows with nothing said about them.
// A reader that collapsed two of the three would make a refused read look like a
// session with no memberships, or a read still in flight look like one that failed.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import {
  MEMBERSHIP_ROSTER_ORIGIN,
  membershipEntriesByParticipantId,
  membershipRosterRefusal,
  type MembershipRosterReading,
} from "./membership-roster.js";

const SERVED: MembershipRosterReading = {
  kind: "answered",
  outcome: {
    status: "served",
    value: [
      { participantId: "participant-you", membershipId: "membership-1", role: "owner" },
      {
        participantId: "participant-priya",
        membershipId: "membership-2",
        role: "collaborator",
        state: "suspended",
      },
    ],
  },
};

// The port's OWN refusal, built by the port's own builder rather than spelled here:
// the ledger members a growth refusal carries are the port's to compose, and a
// hand-written literal would go stale the day one of them moves.
const REFUSED: MembershipRosterReading = {
  kind: "answered",
  outcome: growthUnavailable("membershipRosterRead"),
};

const UNREADABLE: MembershipRosterReading = {
  kind: "unreadable",
  refusal: {
    origin: MEMBERSHIP_ROSTER_ORIGIN,
    code: "bridge.unreachable",
    detail: "The bridge went away.",
  },
};

describe("membership roster — what a served answer carries", () => {
  it("keys the entries by participant", () => {
    const entries = membershipEntriesByParticipantId(SERVED);
    expect(entries.get("participant-you")?.membershipId).toBe("membership-1");
    expect(entries.get("participant-priya")?.state).toBe("suspended");
    expect(entries.size).toBe(2);
  });

  it("carries nothing on every arm that is not a served answer", () => {
    // The unbranched behaviour at every consuming site: an unanswered read costs the
    // ledger its identifiers and never its rows.
    expect(membershipEntriesByParticipantId(undefined).size).toBe(0);
    expect(membershipEntriesByParticipantId(REFUSED).size).toBe(0);
    expect(membershipEntriesByParticipantId(UNREADABLE).size).toBe(0);
  });
});

describe("membership roster — why it is not here", () => {
  it("answers the same way for a refusing outcome and for a call that produced none", () => {
    expect(membershipRosterRefusal(REFUSED)?.code).toBe("wire-unregistered");
    expect(membershipRosterRefusal(UNREADABLE)?.code).toBe("bridge.unreachable");
  });

  it("says nothing about a read in flight, or one that answered", () => {
    // Negative control on both ends: a notice for a read still in flight would put an
    // error where a person is waiting, and one for a served read would be a permanent
    // notice beside a complete answer.
    expect(membershipRosterRefusal(undefined)).toBeUndefined();
    expect(membershipRosterRefusal(SERVED)).toBeUndefined();
  });
});
