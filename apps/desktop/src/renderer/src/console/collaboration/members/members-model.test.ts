// The members model: the four roles, what revoking each costs, and what a row
// says when the ledger never told it.
//
// The properties worth the most are the two that would fail SILENTLY. A role
// table that fell behind the wire union would render a row with no explanation
// beside it and nothing would look broken; a derivation that defaulted an absent
// role to something plausible would put a term on screen that no event ever
// stated, which is indistinguishable from a fact.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity, ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { SessionStore } from "../../store/index.js";
import { COLLABORATION_PROJECTORS } from "./membership-projector.js";
import {
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_NOTES,
  MEMBERSHIP_STATE_IS_LIVE,
  deriveMembershipRows,
  isLastRemainingOwner,
  isLiveMembership,
  isMembershipRole,
  isMembershipState,
  liveMembershipParticipantIds,
  membershipRefusalRemedy,
  type MembershipRow,
} from "./members-model.js";

function participant(id: string, body?: Record<string, unknown>, state?: string): ConsoleEntity {
  return {
    kind: "participant",
    id,
    ...(state === undefined ? {} : { state }),
    ...(body === undefined ? {} : { body }),
  };
}

function row(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    participantId: "participant-you",
    membershipId: "membership-1",
    role: "owner",
    state: "active",
    ...overrides,
  };
}

describe("members model — the role vocabulary", () => {
  it("is exactly the wire's four, including the one that carries a space", () => {
    expect([...MEMBERSHIP_ROLES].sort((left, right) => left.localeCompare(right))).toStrictEqual([
      "collaborator",
      "owner",
      "runtime contributor",
      "viewer",
    ]);
  });

  it("offers the roles in the order the notes table declares them", () => {
    // The selector's order is a decision, and reading it off the table is what
    // keeps the closed set declared once.
    expect(MEMBERSHIP_ROLES).toStrictEqual(Object.keys(MEMBERSHIP_ROLE_NOTES));
  });

  it("states the revocation cost for exactly the two roles whose contract names one", () => {
    expect(MEMBERSHIP_ROLE_NOTES["runtime contributor"].revocationCost).toContain("interrupted");
    expect(MEMBERSHIP_ROLE_NOTES["runtime contributor"].revocationCost).toContain("detached");
    expect(MEMBERSHIP_ROLE_NOTES.collaborator.revocationCost).toContain("thirty-second");
    expect(MEMBERSHIP_ROLE_NOTES.owner.revocationCost).toBeUndefined();
    expect(MEMBERSHIP_ROLE_NOTES.viewer.revocationCost).toBeUndefined();
  });

  it("negative control: the cost is absent rather than an empty sentence", () => {
    // An empty string renders as a blank line exactly where a person is looking
    // for the consequence, which reads as a paint that did not finish.
    expect(MEMBERSHIP_ROLE_NOTES.owner.revocationCost).not.toBe("");
  });

  it("recognizes the wire's roles and nothing else", () => {
    expect(isMembershipRole("runtime contributor")).toBe(true);
    expect(isMembershipRole("runtime-contributor")).toBe(false);
    expect(isMembershipRole("moderator")).toBe(false);
    expect(isMembershipRole(undefined)).toBe(false);
  });

  it("recognizes the wire's membership states and nothing else", () => {
    expect(isMembershipState("suspended")).toBe(true);
    expect(MEMBERSHIP_STATE_IS_LIVE.suspended).toBe(false);
    expect(MEMBERSHIP_STATE_IS_LIVE.active).toBe(true);
    expect(isMembershipState("archived")).toBe(false);
  });

  it("names all four acts and marks exactly the one that is not undone", () => {
    const destructive = Object.entries(MEMBERSHIP_ACTION_NOTES)
      .filter(([, notes]) => notes.isDestructive)
      .map(([action]) => action);
    expect(destructive).toStrictEqual(["revoke"]);
  });
});

describe("members model — the rows it derives", () => {
  it("carries a role and a membership id through when the ledger stated them", () => {
    const rows = deriveMembershipRows({
      "participant-you": participant(
        "participant-you",
        { role: "owner", membershipId: "membership-1" },
        "active",
      ),
    });
    expect(rows).toStrictEqual([
      {
        participantId: "participant-you",
        membershipId: "membership-1",
        role: "owner",
        state: "active",
      },
    ]);
  });

  it("leaves a fact absent rather than filling it in", () => {
    // A projected participant with no membership event behind it. Defaulting the
    // role to `viewer` here would put a term on screen no event ever stated.
    const rows = deriveMembershipRows({
      "participant-priya": participant("participant-priya"),
    });
    expect(rows[0]).toStrictEqual({
      participantId: "participant-priya",
      membershipId: undefined,
      role: undefined,
      state: undefined,
    });
  });

  it("drops a role or state the wire union does not contain", () => {
    // The store's body is `Record<string, unknown>` — anything can be in it. A
    // value outside the union is not a fifth role, it is an absent one.
    const rows = deriveMembershipRows({
      "participant-tomas": participant(
        "participant-tomas",
        { role: "observer", membershipId: 7 },
        "archived",
      ),
    });
    expect(rows[0]?.role).toBeUndefined();
    expect(rows[0]?.state).toBeUndefined();
    expect(rows[0]?.membershipId).toBeUndefined();
  });

  it("negative control: an empty partition derives no rows at all", () => {
    expect(deriveMembershipRows({})).toStrictEqual([]);
  });
});

describe("members model — the two sources, and which one wins", () => {
  const ENTRY = {
    participantId: "participant-you",
    membershipId: "membership-read",
    role: "collaborator",
    state: "active",
  } as const;

  it("takes the role and the state from the log, over the read's own", () => {
    // The read is answered once, on mount; the log keeps arriving. So a revocation the
    // fold has seen is the newer statement, and a read that outranked it would report a
    // membership that has ended as one that has not for the rest of the visit — which
    // is what this case is: the read still says `active` and the log says otherwise.
    const rows = deriveMembershipRows(
      {
        "participant-you": participant(
          "participant-you",
          { role: "owner", membershipId: "membership-log" },
          "revoked",
        ),
      },
      new Map([["participant-you", ENTRY]]),
    );
    expect(rows).toStrictEqual([
      {
        participantId: "participant-you",
        membershipId: "membership-read",
        role: "owner",
        state: "revoked",
      },
    ]);
  });

  it("takes the entry's facts where the log states none", () => {
    // The other half of the rule, and the ordinary case: the session's own opener is
    // admitted by `session.created` and the log states no role and no state for them.
    const rows = deriveMembershipRows(
      { "participant-you": participant("participant-you", {}) },
      new Map([["participant-you", ENTRY]]),
    );
    expect(rows[0]?.role).toBe("collaborator");
    expect(rows[0]?.state).toBe("active");
    expect(rows[0]?.membershipId).toBe("membership-read");
  });

  it("keeps the log's facts where the entry states none", () => {
    const rows = deriveMembershipRows(
      {
        "participant-you": participant(
          "participant-you",
          { role: "owner", membershipId: "membership-log" },
          "active",
        ),
      },
      new Map([["participant-you", { participantId: "participant-you", membershipId: "m" }]]),
    );
    expect(rows[0]?.role).toBe("owner");
    expect(rows[0]?.state).toBe("active");
    expect(rows[0]?.membershipId).toBe("m");
  });

  it("drops a role or state the wire union does not contain, from either source", () => {
    const rows = deriveMembershipRows(
      { "participant-you": participant("participant-you", { role: "owner" }, "active") },
      new Map([
        [
          "participant-you",
          { participantId: "participant-you", membershipId: "m", role: "observer", state: "gone" },
        ],
      ]),
    );
    expect(rows[0]?.role).toBe("owner");
    expect(rows[0]?.state).toBe("active");
    expect(
      deriveMembershipRows(
        { "participant-you": participant("participant-you", { role: "observer" }, "gone") },
        new Map([
          [
            "participant-you",
            {
              participantId: "participant-you",
              membershipId: "m",
              role: "viewer",
              state: "active",
            },
          ],
        ]),
      )[0],
    ).toMatchObject({ role: "viewer", state: "active" });
  });

  it("keeps a row the read named and the log never saw", () => {
    // The read is the membership list; the partition is what this window happened to
    // project. The session's own opener is exactly this case — admitted by
    // `session.created`, with no membership beat anywhere in the log.
    const rows = deriveMembershipRows(
      { "participant-you": participant("participant-you", { role: "owner" }, "active") },
      new Map([
        ["participant-you", { participantId: "participant-you", membershipId: "m1" }],
        [
          "participant-opener",
          { participantId: "participant-opener", membershipId: "m2", role: "owner" },
        ],
      ]),
    );
    expect(rows.map((each) => each.participantId)).toStrictEqual([
      "participant-you",
      "participant-opener",
    ]);
    expect(rows[1]?.membershipId).toBe("m2");
    expect(rows[1]?.state).toBeUndefined();
  });

  it("negative control: with no entries the rows are exactly the log's", () => {
    const projected = {
      "participant-you": participant("participant-you", { role: "owner" }, "active"),
    };
    expect(deriveMembershipRows(projected, new Map())).toStrictEqual(
      deriveMembershipRows(projected),
    );
  });
});

describe("members model — the last remaining owner", () => {
  it("names the sole owner and nobody else", () => {
    const rows = [row(), row({ participantId: "participant-priya", role: "collaborator" })];
    expect(isLastRemainingOwner(rows[0] as MembershipRow, rows)).toBe(true);
    expect(isLastRemainingOwner(rows[1] as MembershipRow, rows)).toBe(false);
  });

  it("names nobody once a second owner exists", () => {
    const rows = [row(), row({ participantId: "participant-priya" })];
    expect(rows.every((candidate) => !isLastRemainingOwner(candidate, rows))).toBe(true);
  });

  it("negative control: a row whose role never arrived is never the last owner", () => {
    // The note is advisory precisely because this console does not hold every
    // role — a row with no role must not be counted as one either way.
    const rows = [row({ role: undefined })];
    expect(isLastRemainingOwner(rows[0] as MembershipRow, rows)).toBe(false);
  });
});

describe("members model — refusal remedies", () => {
  it("adds the transfer-first remedy to the last-owner refusal", () => {
    expect(membershipRefusalRemedy("membership.last_owner")).toContain("owner first");
  });

  it("says nothing extra about a code it does not recognize", () => {
    expect(membershipRefusalRemedy("membership.unheard_of")).toBeUndefined();
    // `Object.prototype` keys must not resolve as remedies.
    expect(membershipRefusalRemedy("toString")).toBeUndefined();
  });

  it("negative control: a code it does recognize returns a real sentence", () => {
    expect(membershipRefusalRemedy("membership.permission_denied")).toContain("owner");
  });
});

describe("members model — who is still in the session", () => {
  const SESSION_ID = "session-collaboration";

  /**
   * The participant partition a real store holds after applying these events.
   *
   * The REAL store and the REAL projector table, because the claim spans both: the
   * fold has to write the transition and the derivation has to read it, and a
   * hand-built partition would assert the second half against an assumption about the
   * first. This is the whole path the section body takes, minus the React around it.
   */
  function partitionAfter(
    events: readonly ConsoleSessionEvent[],
  ): Readonly<Record<string, ConsoleEntity>> {
    const store = new SessionStore({ sessionId: SESSION_ID, projectors: COLLABORATION_PROJECTORS });
    store.initialise({ cursor: 0, participantJoinLog: [], entities: [] });
    store.applyBatch(events);
    return store.snapshot().partitions.participant;
  }

  /** One admission, as the wire states it. */
  function admission(participantId: string, sequence: number): ConsoleSessionEvent {
    return eventOfKind(SESSION_ID, "membership.created", sequence, {
      membershipId: `membership-for-${participantId}`,
      participantId,
      role: "collaborator",
      identityHandle: participantId,
    });
  }

  it("drops a participant whose membership the log says has ended", () => {
    // The defect: the picker's candidates were every participant the log had ever
    // named, so a revoked member stayed on offer and every direct channel opened
    // against them could only be refused.
    const partition = partitionAfter([
      admission("participant-you", 1),
      admission("participant-priya", 2),
      eventOfKind(SESSION_ID, "membership.revoked", 3, {
        sessionId: SESSION_ID,
        participantId: "participant-priya",
        actor: "participant-you",
      }),
    ]);

    expect(liveMembershipParticipantIds(partition)).toStrictEqual(["participant-you"]);
    // The row itself is still derived, and still says what happened: the ledger reports
    // ended memberships and only the surfaces that OFFER an act filter them out.
    expect(deriveMembershipRows(partition).map((each) => each.state)).toStrictEqual([
      undefined,
      "revoked",
    ]);
  });

  it("drops a suspended one and takes it back on the reactivation", () => {
    const suspended = partitionAfter([
      admission("participant-priya", 1),
      eventOfKind(SESSION_ID, "membership.suspended", 2, {
        sessionId: SESSION_ID,
        participantId: "participant-priya",
      }),
    ]);
    expect(liveMembershipParticipantIds(suspended)).toStrictEqual([]);

    const reactivated = partitionAfter([
      admission("participant-priya", 1),
      eventOfKind(SESSION_ID, "membership.suspended", 2, {
        sessionId: SESSION_ID,
        participantId: "participant-priya",
      }),
      eventOfKind(SESSION_ID, "membership.reactivated", 3, {
        sessionId: SESSION_ID,
        participantId: "participant-priya",
      }),
    ]);
    expect(liveMembershipParticipantIds(reactivated)).toStrictEqual(["participant-priya"]);
  });

  it("negative control: a created membership is still a candidate", () => {
    // The asymmetry the predicate rests on. `membership.created` states no state at
    // all, so a filter that required a live one would empty the picker in a console
    // that is working — which is the failure the other direction of this fix would be.
    const partition = partitionAfter([admission("participant-priya", 1)]);
    expect(deriveMembershipRows(partition)[0]?.state).toBeUndefined();
    expect(liveMembershipParticipantIds(partition)).toStrictEqual(["participant-priya"]);
    expect(isLiveMembership(row({ state: undefined }))).toBe(true);
  });

  it("reads the two ended states off the one table that declares them", () => {
    expect(isLiveMembership(row({ state: "revoked" }))).toBe(false);
    expect(isLiveMembership(row({ state: "suspended" }))).toBe(false);
    expect(isLiveMembership(row({ state: "pending" }))).toBe(true);
  });
});
