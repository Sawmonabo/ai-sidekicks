// The members model: the four roles, what revoking each costs, and what a row
// says when the ledger never told it.
//
// The properties worth the most are the two that would fail SILENTLY. A role
// table that fell behind the wire union would render a row with no explanation
// beside it and nothing would look broken; a derivation that defaulted an absent
// role to something plausible would put a term on screen that no event ever
// stated, which is indistinguishable from a fact.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity } from "../../store/index.js";
import {
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_NOTES,
  MEMBERSHIP_STATE_IS_LIVE,
  deriveMembershipRows,
  isLastRemainingOwner,
  isMembershipRole,
  isMembershipState,
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
