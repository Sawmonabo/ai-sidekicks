// Which members the session may still offer an act to: the candidate filter, over
// the whole path from the projector's write to the derivation's read.
//
// Split from `members-model.test.ts` — which covers the model's pure functions over
// hand-built partitions — because this is the only members-model suite that stands a
// real store up, and the two subjects had outgrown one file. The seam is a describe
// boundary, so no case is halved, and the row fixture both files need is imported
// from `members-model.test-support.ts` rather than copied into each.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity, ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { SessionStore } from "../../store/index.js";
import { COLLABORATION_PROJECTORS } from "./membership-projector.js";
import { membershipRow } from "./members-model.test-support.js";
import {
  deriveMembershipRows,
  isLiveMembership,
  liveMembershipParticipantIds,
} from "./members-model.js";

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
    expect(isLiveMembership(membershipRow({ state: undefined }))).toBe(true);
  });

  it("reads the two ended states off the one table that declares them", () => {
    expect(isLiveMembership(membershipRow({ state: "revoked" }))).toBe(false);
    expect(isLiveMembership(membershipRow({ state: "suspended" }))).toBe(false);
    expect(isLiveMembership(membershipRow({ state: "pending" }))).toBe(true);
  });
});
