// The membership fold: what an admission puts in the participant partition, and the
// two things it deliberately refuses to put there.
//
// The properties worth the most are the ones that would be WRONG rather than missing.
// A fold that wrote a membership STATE would have a created membership silently
// reading as active on a row whose four controls are gated on what it says; a fold
// that wrote an empty body would erase a name a later beat established, because the
// store's merge treats a present key as an assignment; and a fold that threw on a
// malformed payload would cost the whole batch its projection rather than one event
// its entity.

import { describe, expect, it } from "vitest";

import { eventOfKind } from "../../store/session-event.test-support.js";
import {
  COLLABORATION_PROJECTORS,
  MEMBERSHIP_CREATED_EVENT_KIND,
  projectMembershipCreated,
} from "./membership-projector.js";

const SESSION_ID = "session-collaboration";

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

  it("claims exactly the one kind whose payload the contract declares", () => {
    // The other four `membership.*` kinds are registered in the taxonomy with no
    // payload variant at all, so a fold for them could only guess at what changed.
    expect(Object.keys(COLLABORATION_PROJECTORS)).toStrictEqual([MEMBERSHIP_CREATED_EVENT_KIND]);
  });
});
