// The membership fold: what an admission puts in the participant partition, and the
// two things it deliberately refuses to put there.
//
// The properties worth the most are the ones that would be WRONG rather than missing.
// A fold that wrote a membership STATE would have a created membership silently
// reading as active on a row whose four controls are gated on what it says; a fold
// that wrote an empty body would erase a name a later beat established, because the
// store's merge treats a present key as an assignment; and a fold that threw on a
// malformed payload would cost the whole batch its projection rather than one event
// its entity. The fourth is the one that would be wrong about somebody ELSE: a fold
// that keyed a mutation off a payload naming another session would insert or alter
// that session's participant in this partition, and the membership controls and the
// direct-channel candidate list both read what lands there.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "../../store/session-event.test-support.js";
import type { ConsoleEntity, EntityMutation } from "../../store/index.js";
import {
  COLLABORATION_PROJECTORS,
  MEMBERSHIP_CREATED_EVENT_KIND,
  MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
  projectMembershipCreated,
  projectMembershipLifecycle,
  projectMembershipRoleChanged,
} from "./membership-projector.js";

const SESSION_ID = "session-collaboration";

/** A session this store is not, so a payload naming it is a claim about another one. */
const FOREIGN_SESSION_ID = "session-somebody-else";

/**
 * One `membership_change` transition payload, carrying the session member every one of
 * them carries.
 *
 * `Spec-006 §Invite and Membership (membership_change)` fixes the shape at
 * `{sessionId, participantId, inviteId?, previousRole?, newRole?, actor, reason?}`, so
 * a fixture that omitted `sessionId` would be driving the fold with a frame no daemon
 * emits — and every case below would then be asserting about a payload the contract
 * rejects rather than about the one it sends.
 */
function transitionPayload(
  members: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { sessionId: SESSION_ID, ...members };
}

describe("membership fold — what an admission states", () => {
  it("writes the handle, the identifier, and the role onto the participant it names", () => {
    const mutations = projectMembershipCreated(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 4, {
        membershipId: "019b7912-0001-7000-8000-000000000002",
        participantId: "participant-priya",
        role: "collaborator",
        identityHandle: "Priya",
      }),
    );
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0];
    expect(mutation?.operation).toBe("upsert");
    if (mutation?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutation.entity.kind).toBe("participant");
    expect(mutation.entity.id).toBe("participant-priya");
    expect(mutation.entity.body).toStrictEqual({
      name: "Priya",
      membershipId: "019b7912-0001-7000-8000-000000000002",
      role: "collaborator",
    });
  });

  it("states no membership state, because the admission does not carry one", () => {
    // The row's four controls read this. A created membership is not necessarily an
    // active one — `MembershipState` has four values and the payload names none — so
    // writing one here would be the console deciding a fact the daemon sends.
    const mutations = projectMembershipCreated(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 5, {
        membershipId: "019b7912-0001-7000-8000-000000000003",
        participantId: "participant-tomas",
        role: "viewer",
        identityHandle: "Tomas",
      }),
    );
    if (mutations[0]?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutations[0].entity.state).toBeUndefined();
  });

  it("writes only what the payload states, so a spread merge erases nothing", () => {
    // The store merges a body one level deep and treats a present key as an
    // assignment, so an absent member has to be ABSENT rather than `undefined`.
    const mutations = projectMembershipCreated(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 6, {
        participantId: "participant-noah",
        role: "viewer",
      }),
    );
    if (mutations[0]?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutations[0].entity.body).toStrictEqual({ role: "viewer" });
    expect(Object.hasOwn(mutations[0].entity.body ?? {}, "name")).toBe(false);
  });

  it("carries no body at all where the payload states nothing readable", () => {
    const mutations = projectMembershipCreated(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 7, {
        participantId: "participant-noah",
      }),
    );
    if (mutations[0]?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutations[0].entity.body).toBeUndefined();
    expect(mutations[0].entity.touchedAt).toBe(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 7).occurredAt,
    );
  });

  it("answers with no mutation for a payload it cannot key on", () => {
    // Pure and total: the event is still admitted and the timeline still records that
    // it arrived. A throw here would cost the whole batch its projection.
    expect(
      projectMembershipCreated(
        eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 8, { role: "owner" }),
      ),
    ).toStrictEqual([]);
    expect(
      projectMembershipCreated(eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 9)),
    ).toStrictEqual([]);
  });

  it("claims all five `membership.*` kinds, and the three transitions share one fold", () => {
    // The set is the claim: a kind this family does not register is a kind nothing
    // folds, and the four beyond the admission are exactly the ones that decide
    // whether a membership is still one a session can address.
    expect(Object.keys(COLLABORATION_PROJECTORS)).toStrictEqual([
      MEMBERSHIP_CREATED_EVENT_KIND,
      MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
      "membership.suspended",
      "membership.revoked",
      "membership.reactivated",
    ]);
    expect(COLLABORATION_PROJECTORS["membership.revoked"]).toBe(projectMembershipLifecycle);
    expect(COLLABORATION_PROJECTORS["membership.reactivated"]).toBe(projectMembershipLifecycle);
  });
});

describe("membership fold — what a lifecycle transition states", () => {
  /** The one upsert a fold answered with, refused loudly where it answered otherwise. */
  function upsertOf(mutations: readonly EntityMutation[]): ConsoleEntity {
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0];
    if (mutation?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    return mutation.entity;
  }

  it("writes the state the kind names, and writes no body with it", () => {
    // The state is read off the KIND rather than off the payload, because the kind is
    // the wire's own statement of the transition. The body stays absent so the merge
    // one level up keeps the handle, the identifier, and the role the admission wrote.
    const revoked = upsertOf(
      projectMembershipLifecycle(
        eventOfKind(
          SESSION_ID,
          "membership.revoked",
          10,
          transitionPayload({ participantId: "participant-priya", actor: "participant-you" }),
        ),
      ),
    );
    expect(revoked.id).toBe("participant-priya");
    expect(revoked.state).toBe("revoked");
    expect(revoked.body).toBeUndefined();

    expect(
      upsertOf(
        projectMembershipLifecycle(
          eventOfKind(
            SESSION_ID,
            "membership.suspended",
            11,
            transitionPayload({ participantId: "participant-priya" }),
          ),
        ),
      ).state,
    ).toBe("suspended");
    expect(
      upsertOf(
        projectMembershipLifecycle(
          eventOfKind(
            SESSION_ID,
            "membership.reactivated",
            12,
            transitionPayload({ participantId: "participant-priya" }),
          ),
        ),
      ).state,
    ).toBe("active");
  });

  it("negative control: a kind the table does not name yields nothing", () => {
    // One projector serves three keys, so it is handed its own `kind` to read. Without
    // this the cases above would pass over a fold that wrote a state for anything it
    // was given — including `membership.created`, whose whole rule is that it does not.
    expect(
      projectMembershipLifecycle(
        eventOfKind(
          SESSION_ID,
          MEMBERSHIP_CREATED_EVENT_KIND,
          13,
          transitionPayload({ participantId: "participant-priya" }),
        ),
      ),
    ).toStrictEqual([]);
  });

  it("answers with no mutation for a transition it cannot key on", () => {
    expect(
      projectMembershipLifecycle(
        eventOfKind(
          SESSION_ID,
          "membership.revoked",
          14,
          transitionPayload({ actor: "participant-you" }),
        ),
      ),
    ).toStrictEqual([]);
  });
});

describe("membership fold — what a role change states", () => {
  it("writes the new role and states no membership state with it", () => {
    // A role move says nothing about whether the membership is active, so a state
    // written here would reactivate a suspended row on the strength of an unrelated
    // fact — which is the same rule the admission fold obeys, read from the other end.
    const mutations = projectMembershipRoleChanged(
      eventOfKind(
        SESSION_ID,
        MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
        20,
        transitionPayload({
          participantId: "participant-priya",
          previousRole: "collaborator",
          newRole: "owner",
        }),
      ),
    );
    if (mutations[0]?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutations[0].entity.body).toStrictEqual({ role: "owner" });
    expect(mutations[0].entity.state).toBeUndefined();
  });

  it("carries no body where the change states no readable role", () => {
    const mutations = projectMembershipRoleChanged(
      eventOfKind(
        SESSION_ID,
        MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
        21,
        transitionPayload({ participantId: "participant-priya" }),
      ),
    );
    if (mutations[0]?.operation !== "upsert") {
      throw new Error("the fold answered with something other than an upsert");
    }
    expect(mutations[0].entity.body).toBeUndefined();
  });

  it("answers with no mutation for a change it cannot key on", () => {
    expect(
      projectMembershipRoleChanged(
        eventOfKind(
          SESSION_ID,
          MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
          22,
          transitionPayload({ newRole: "owner" }),
        ),
      ),
    ).toStrictEqual([]);
  });
});

describe("membership fold — which session a payload may speak for", () => {
  /** Every kind this family claims, with the payload each one carries. */
  const foldsUnderTest = [
    {
      label: "role change",
      fold: projectMembershipRoleChanged,
      kind: MEMBERSHIP_ROLE_CHANGED_EVENT_KIND,
      members: { participantId: "participant-priya", newRole: "owner" },
    },
    {
      label: "suspension",
      fold: projectMembershipLifecycle,
      kind: "membership.suspended",
      members: { participantId: "participant-priya" },
    },
    {
      label: "revocation",
      fold: projectMembershipLifecycle,
      kind: "membership.revoked",
      members: { participantId: "participant-priya" },
    },
    {
      label: "reactivation",
      fold: projectMembershipLifecycle,
      kind: "membership.reactivated",
      members: { participantId: "participant-priya" },
    },
  ] as const;

  it.each(foldsUnderTest)(
    "refuses a $label whose payload names another session",
    ({ fold, kind, members }) => {
      // The defect: `SessionStore` checks the ENVELOPE and these folds checked nothing,
      // so a frame delivered on this session while claiming another one keyed a
      // mutation here — and a revocation or a suspension is exactly the fact the
      // membership controls and the direct-channel candidates act on.
      expect(
        fold(eventOfKind(SESSION_ID, kind, 30, { ...members, sessionId: FOREIGN_SESSION_ID })),
      ).toStrictEqual([]);
    },
  );

  it.each(foldsUnderTest)(
    "refuses a $label that names no session at all",
    ({ fold, kind, members }) => {
      // `Spec-006 §Invite and Membership (membership_change)` makes `sessionId` a member
      // every one of these payloads carries, so an omission is a frame no daemon emits
      // rather than a terser one — the same reading the run and approval folds take of
      // their own registered shapes.
      expect(fold(eventOfKind(SESSION_ID, kind, 31, members))).toStrictEqual([]);
    },
  );

  it.each(foldsUnderTest)("applies a $label that names this session", ({ fold, kind, members }) => {
    // The positive control the two refusals above need: without it a fold that refused
    // EVERYTHING would pass both, and a membership plane that folds nothing looks
    // exactly like one that has had no transitions.
    const mutations = fold(eventOfKind(SESSION_ID, kind, 32, transitionPayload(members)));
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.operation === "upsert" ? mutations[0].entity.id : undefined).toBe(
      "participant-priya",
    );
  });

  it("refuses an admission whose payload names another session", () => {
    expect(
      projectMembershipCreated(
        eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 33, {
          sessionId: FOREIGN_SESSION_ID,
          membershipId: "019b7912-0001-7000-8000-000000000004",
          participantId: "participant-priya",
          role: "owner",
          identityHandle: "Priya",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("applies an admission that names no session, because its contract carries none", () => {
    // The asymmetry, and the reason the admission takes the other arm of the rule.
    // `membershipCreatedPayloadSchema` is `.strict()` over `{membershipId,
    // participantId, role, identityHandle}` — no `sessionId` in it — so the required
    // arm would refuse every real admission and empty the roster. Every scenario beat
    // in the tree emits exactly this shape.
    const mutations = projectMembershipCreated(
      eventOfKind(SESSION_ID, MEMBERSHIP_CREATED_EVENT_KIND, 34, {
        membershipId: "019b7912-0001-7000-8000-000000000005",
        participantId: "participant-priya",
        role: "owner",
        identityHandle: "Priya",
      }),
    );
    expect(mutations).toHaveLength(1);
  });
});
