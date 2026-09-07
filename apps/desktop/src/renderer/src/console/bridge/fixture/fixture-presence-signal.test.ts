// What a subscriber to the session's Awareness room is handed, and when.
//
// THE DEFECT THESE CASES EXIST FOR. `presence.subscribe` is a registered
// `daemon.subscribe` name, and the fixture's subscription door knew three stream names
// and treated every other one as a bare EVENT KIND — so this subscription was matched
// against the kind `presence.subscribe`, which no census registers and no scenario
// plays, and received nothing for the life of the window. Both of its console
// subscribers are push-driven reads, so both answered once at mount and never again:
// the activity feed rendered whichever frame was due when it opened, and a scenario
// that scripts a person to stop typing half a second in showed them typing for ever.
//
// A GREEN SUITE COULD NOT SEE IT, which is why the cases read the FRAME the read then
// serves rather than counting signals. A signal that fires and a read that has moved
// are two different claims, and a fixture delivering a signal per tick would satisfy
// the first while making the second meaningless.

import { describe, expect, it } from "vitest";

import type { DaemonEvent } from "@ai-sidekicks/contracts";

import { PRESENCE_EVENT_STREAM } from "../daemon/session-event-streams.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { PARTICIPANT_TOMAS } from "../scenarios/collaboration.identifiers.js";
import { createFixture, type FixtureUnderTest } from "./fixture-bridge.test-support.js";

/** The tick the room's second activity frame falls due at. */
const SECOND_ACTIVITY_FRAME_MS = 500;

/**
 * Past every beat that moves this room's presence, and before that frame.
 *
 * The gap is what makes the first case discriminating. Presence transitions land at
 * 380, 400 and 420, so a door that answered this subscription with the presence BEATS
 * would have signalled three times by here and fall silent exactly where the frame
 * needs a signal — which is the state the console was in and is invisible to a case
 * that only counts signals over the whole playback.
 */
const PAST_EVERY_PRESENCE_BEAT_MS = 450;

/** Inside the opening frame and before any beat has moved anybody. */
const INSIDE_THE_FIRST_FRAME_MS = 100;

/** Count the signals one subscription receives, exactly as a surface would. */
function signalsFrom(fixture: FixtureUnderTest, subscriptionName: string): readonly unknown[] {
  const received: unknown[] = [];
  fixture.bridge.sidekicks.daemon.subscribe(subscriptionName as DaemonEvent, (payload: unknown) => {
    received.push(payload);
  });
  return received;
}

/** Who the activity read says is composing, right now. */
async function composingParticipantIds(fixture: FixtureUnderTest): Promise<readonly string[]> {
  const outcome = await fixture.bridge.growth.presenceActivityRead({
    sessionId: COLLABORATION_SCENARIO.sessionId,
  });
  if (outcome.status !== "served") {
    throw new Error(`the room refused its own activity read: ${outcome.status}`);
  }
  return outcome.value.composing.map((reading) => reading.participantId);
}

describe("the fixture's Awareness subscription", () => {
  it("signals when the frame the read serves has moved", async () => {
    // The whole defect in one case: the second frame is scripted, it falls due, and
    // without a signal nothing above ever asks for it. Both halves are asserted —
    // the push arrived, and the read behind it now answers differently.
    const fixture = createFixture(COLLABORATION_SCENARIO);
    const signals = signalsFrom(fixture, PRESENCE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_PRESENCE_BEAT_MS);
    const signalsBeforeTheFrame = signals.length;
    const composingBeforeTheFrame = await composingParticipantIds(fixture);
    fixture.engine.advance(SECOND_ACTIVITY_FRAME_MS - PAST_EVERY_PRESENCE_BEAT_MS);

    expect(composingBeforeTheFrame).toContain(PARTICIPANT_TOMAS);
    expect(signals.length).toBeGreaterThan(signalsBeforeTheFrame);
    expect(await composingParticipantIds(fixture)).not.toContain(PARTICIPANT_TOMAS);
  });

  it("carries nothing, because the read is the truth and the push is only a signal", () => {
    // Both console subscribers type the push `void` and answer it with a fresh read. A
    // fixture that composed an envelope here would hand them a value the live bridge
    // does not send, and the one thing they are forbidden to do is open it.
    const fixture = createFixture(COLLABORATION_SCENARIO);
    const signals = signalsFrom(fixture, PRESENCE_EVENT_STREAM);

    fixture.engine.advance(SECOND_ACTIVITY_FRAME_MS);

    expect(signals.every((signal) => signal === undefined)).toBe(true);
  });

  it("signals on a presence transition, which is the room moving on the log", () => {
    // The other half of what moves an Awareness room. Composing rides beside presence
    // and carries no event at all, so a signal watching only the log would be silent
    // for the frames; one watching only the clock would be silent for the roster.
    const fixture = createFixture(COLLABORATION_SCENARIO);
    const signals = signalsFrom(fixture, PRESENCE_EVENT_STREAM);

    fixture.engine.advance(INSIDE_THE_FIRST_FRAME_MS);
    const beforeAnyTransition = signals.length;
    fixture.engine.advance(SECOND_ACTIVITY_FRAME_MS - INSIDE_THE_FIRST_FRAME_MS);

    // The opening frame was already due when the subscription attached, so nothing is
    // owed for it: a signal there would be the same publication read twice, which the
    // feed's own fold treats as a refresh.
    expect(beforeAnyTransition).toBe(0);
    expect(signals.length).toBeGreaterThan(1);
  });

  it("negative control: a name the corpus registers no subscription for still receives nothing", () => {
    // Without this, a door that delivered a signal to every subscriber would pass every
    // case above — and the silence a misspelled subscription reads as is exactly what
    // the routing table exists to keep distinguishable from a quiet session.
    const fixture = createFixture(COLLABORATION_SCENARIO);
    const signals = signalsFrom(fixture, "presence.subscribeAll");

    fixture.engine.advance(SECOND_ACTIVITY_FRAME_MS);

    expect(signals).toStrictEqual([]);
  });
});
