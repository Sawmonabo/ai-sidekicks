// Who the fixture says is in a session, once the playback has been told somebody left.
//
// THE DEFECT THESE CASES EXIST FOR. A channel's `participantCount` was counted off the
// session read's base state — the roster the scenario declares, at cursor zero — and a
// base state folds no lifecycle event and never will. So a room that had already
// delivered a `membership.revoked` frame went on reporting the revoked participant as a
// member of every channel created afterwards, and the reading was wrong in the one
// direction nothing catches: the number was plausible, it was the number the room opened
// with, and the frame that should have moved it had already reached every other reader
// of that session.
//
// DRIVEN THROUGH THE REAL SEAM, never through the fold alone. What a person sees is a
// `channel.list` row, and the path to it runs through the engine's frozen clock, the
// served create that records the membership, and the directory fold that composes the
// row — so a case that called the count directly would pass against a fixture that wired
// it to nothing. The count is asserted where it is read.

import { describe, expect, it } from "vitest";

import { COLLABORATION_PARTICIPANTS } from "../scenarios/collaboration/identifiers.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { createFixture } from "./fixture-bridge.test-support.js";
import {
  createdChannelIdIn,
  directoryMemberCountOf,
} from "./fixture-channel-directory.test-support.js";
import { scenarioAlsoPlaying } from "./scenario-append.test-support.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** Past every beat the room plays, appended frames included. */
const PAST_EVERY_BEAT_MS = 10_000;

/** Far enough in to have delivered the room's opening beats and no appended one. */
const INTO_THE_OPENING_MS = 100;

/** Whoever this room admits last, and so the one person a case can take back out. */
const REVOKED_PARTICIPANT_ID = COLLABORATION_PARTICIPANTS.at(-1)?.participantId ?? "";

/**
 * The collaboration room, told that one of its people was revoked.
 *
 * The payload is `Spec-006 §Invite and Membership (membership_change)`'s own
 * `{sessionId, participantId, …}`, which is the shape the four transitions carry and the
 * one the fold requires of them.
 */
const ROOM_WITH_A_REVOCATION: ConsoleScenario = scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
  {
    kind: "membership.revoked",
    payload: {
      sessionId: COLLABORATION_SCENARIO.sessionId,
      participantId: REVOKED_PARTICIPANT_ID,
    },
  },
]);

describe("the fixture's session membership — the roster a channel create counts", () => {
  it("leaves out a participant whose revocation this playback has already delivered", async () => {
    // The finding itself. The room declares four people and has been told one of them
    // was revoked, so a general channel created after that frame holds three — and a
    // count taken from the opening snapshot answers four, because those entities are
    // the roster at cursor zero and fold nothing.
    const fixture = createFixture(ROOM_WITH_A_REVOCATION);
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length - 1,
    );
  });

  it("negative control: the same room counts its whole roster before that frame is due", async () => {
    // Without this the case above would pass over a fold that subtracted somebody
    // unconditionally, or that counted the roster one short for every room. The SAME
    // scenario is played, so the only difference between the two readings is which
    // frames the frozen clock has released — which is what "at the create instant"
    // means.
    const fixture = createFixture(ROOM_WITH_A_REVOCATION);
    fixture.engine.advance(INTO_THE_OPENING_MS);

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length,
    );
  });

  it("keeps a revocation that names ANOTHER session out of this session's roster", async () => {
    // The four transitions carry a required `sessionId`, and a frame whose payload names
    // somewhere else is a claim about another session's participant — folding it here
    // would take a stranger's revocation out of this room's roster and report a channel
    // one member short for a reason no reader of this session was ever told.
    const fixture = createFixture(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        {
          kind: "membership.revoked",
          payload: {
            sessionId: "019b7904-8ce0-7c11-8199-cca0117a0999",
            participantId: REVOKED_PARTICIPANT_ID,
          },
        },
      ]),
    );
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length,
    );
  });

  it("puts back a participant whose revocation a later reactivation reversed", async () => {
    // The fold is the log's order and not a set of people who have ever been revoked:
    // `membership.reactivated` is what restoring a membership looks like on this wire,
    // and a room that had ended and restored one holds the same four people it opened
    // with. A fold that subtracted on the first frame and stopped reading answers three.
    const fixture = createFixture(
      scenarioAlsoPlaying(COLLABORATION_SCENARIO, [
        {
          kind: "membership.revoked",
          payload: {
            sessionId: COLLABORATION_SCENARIO.sessionId,
            participantId: REVOKED_PARTICIPANT_ID,
          },
        },
        {
          kind: "membership.reactivated",
          payload: {
            sessionId: COLLABORATION_SCENARIO.sessionId,
            participantId: REVOKED_PARTICIPANT_ID,
          },
        },
      ]),
    );
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const channelId = await createdChannelIdIn(fixture, { name: "handover" });

    expect(await directoryMemberCountOf(fixture, channelId)).toBe(
      COLLABORATION_PARTICIPANTS.length,
    );
  });
});
