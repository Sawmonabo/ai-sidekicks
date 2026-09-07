// What a served lifecycle move puts on the session feed, and where it lands in the log.
//
// THE DEFECT THESE CASES EXIST FOR. A mute, an unmute or an archive answered with a
// receipt and published nothing, so the four `channel.*` events the directory re-reads
// on could arrive only from an authored beat. Every surface built on the re-read path
// was therefore exercised by a frame somebody wrote in a script rather than by the act
// that provokes it, and a console that never published one would look identical here.
//
// THE SEQUENCE IS THE OTHER HALF, and it is the half a fixture gets wrong quietly.
// `store/sequence-reconciler.ts` refuses a position at or below its cursor as a
// duplicate and records every skipped position as a gap, so a frame numbered above the
// whole script turns every later beat into a duplicate the store drops, and one that
// reused a scripted number collides outright. Both are invisible in a green suite that
// only counts frames, so these cases read the POSITIONS.

import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@ai-sidekicks/contracts";

import {
  CHANNEL_HANDOFF,
  CHANNEL_MAIN,
  CHANNEL_REVIEW,
} from "../scenarios/collaboration/identifiers.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { SESSION_EVENT_STREAM } from "../daemon/session-event-streams.js";
import {
  callBridge,
  createFixture,
  subscribeThroughBridge,
  unscriptedScenario,
  type FixtureUnderTest,
} from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** Past every beat the collaboration room plays, so an advance leaves nothing due. */
const PAST_EVERY_BEAT_MS = 10_000;

/** Far enough in to have delivered the room's opening beats and no further. */
const INTO_THE_OPENING_MS = 100;

/** The room, its lifecycle replies scripted, and a feed already attached to it. */
function room(scenario: ConsoleScenario = COLLABORATION_SCENARIO): {
  readonly fixture: FixtureUnderTest;
  readonly frames: readonly EventEnvelope[];
} {
  const fixture = createFixture(scenario);
  return { fixture, frames: subscribeThroughBridge(fixture, SESSION_EVENT_STREAM) };
}

/**
 * What one delivered frame says about the channel it is about.
 *
 * Read off the frame at the index rather than asserted through a non-null, so a case
 * whose frame never arrived reports the absence rather than a property read on it.
 */
function channelIdAt(frames: readonly EventEnvelope[], index: number): unknown {
  return frames[index]?.payload["channelId"];
}

describe("the fixture's channel lifecycle — what a served move publishes", () => {
  it("puts one transition on the session feed, naming the channel and the move", async () => {
    const { fixture, frames } = room();

    const outcome = await fixture.bridge.growth.channelMute({ channelId: CHANNEL_REVIEW });

    expect(outcome.status).toBe("served");
    expect(frames.map((frame) => frame.type)).toStrictEqual(["channel.muted"]);
    expect(channelIdAt(frames, 0)).toBe(CHANNEL_REVIEW);
  });

  it("names the channel the RECEIPT carries, never the one the caller asked about", async () => {
    // The claim that makes this a stand-in for a daemon rather than an echo of the
    // press: what was asked for and what happened are different facts, and a scenario
    // answering a mute of one channel with a receipt naming another is scripting a
    // daemon that moved that other channel. Deriving from the request would have the
    // fixture agree with the caller about something the caller does not decide.
    const { fixture, frames } = room({
      ...unscriptedScenario("channel-lifecycle-mismatched-receipt"),
      replies: [{ call: "channel.mute", result: { channelId: CHANNEL_HANDOFF, state: "muted" } }],
    });

    await fixture.bridge.growth.channelMute({ channelId: CHANNEL_REVIEW });

    expect(channelIdAt(frames, 0)).toBe(CHANNEL_HANDOFF);
  });

  it("publishes a second frame for a second move, after the first", async () => {
    const { fixture, frames } = room();

    await fixture.bridge.growth.channelMute({ channelId: CHANNEL_REVIEW });
    await fixture.bridge.growth.channelUnmute({ channelId: CHANNEL_REVIEW });

    expect(frames.map((frame) => frame.type)).toStrictEqual(["channel.muted", "channel.unmuted"]);
    // The later kind is the one a reader folds last, which is only true if the later
    // frame also sits later in the log.
    expect(frames[1]?.sequence).toBe((frames[0]?.sequence ?? 0) + 1);
  });

  it("negative control: a move no scenario answers publishes nothing", async () => {
    // Without this every case above would pass over a fixture that published on the
    // way IN — a console learning that an archive it was refused had happened.
    const { fixture, frames } = room(unscriptedScenario("channel-lifecycle-unscripted"));

    const outcome = await fixture.bridge.growth.channelArchive({ channelId: CHANNEL_REVIEW });

    expect(outcome.status).toBe("unavailable");
    expect(frames).toHaveLength(0);
  });

  it("negative control: a served CREATE publishes nothing", async () => {
    // The deliberate exclusion, asserted rather than assumed: `channel.created` carries
    // the NAME, which lives on the request rather than on the receipt, and a row that
    // did not exist before is not a transition on one that did.
    const { fixture, frames } = room();

    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: COLLABORATION_SCENARIO.sessionId,
      name: "handover",
    });

    expect(outcome.status).toBe("served");
    expect(frames).toHaveLength(0);
  });
});

describe("the fixture's channel lifecycle — where the frame lands in the log", () => {
  /** Every position one playback delivered, in the order it delivered them. */
  function positions(frames: readonly EventEnvelope[]): readonly number[] {
    return frames.map((frame) => frame.sequence);
  }

  /** The same run of positions, if it were monotonic and dense from where it starts. */
  function denseFrom(delivered: readonly number[]): readonly number[] {
    return delivered.map((_, index) => (delivered[0] ?? 0) + index);
  }

  it("takes the next free position, and every beat after it stays dense above it", async () => {
    const { fixture, frames } = room();
    fixture.engine.advance(INTO_THE_OPENING_MS);
    const beforeTheAct = frames.length;

    await fixture.bridge.growth.channelArchive({ channelId: CHANNEL_HANDOFF });
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // One line, monotonic and dense: no position repeated, which the store refuses as
    // a duplicate, and none skipped, which it records as a gap and repairs against.
    expect(positions(frames)).toStrictEqual(denseFrom(positions(frames)));
    expect(frames).toHaveLength(COLLABORATION_SCENARIO.beats.length + 1);
    expect(frames[beforeTheAct]?.type).toBe("channel.archived");
  });

  it("negative control: a playback with no act delivers each beat where its author put it", async () => {
    // The other half of the same rule, and the one that keeps the shift honest: with
    // nothing appended the shift is zero, so every scenario in the tree is delivered at
    // the sequences it was written with rather than at renumbered ones.
    const { fixture, frames } = room();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(positions(frames)).toStrictEqual(
      COLLABORATION_SCENARIO.beats.map((beat) => beat.event.sequence),
    );
  });

  it("replays an appended frame to a feed that subscribes after it", async () => {
    // The whole-session stream is registered replay-then-tail, and a frame this fixture
    // appended is part of that log like any other: a store opened after the act reads
    // the transition rather than reading the next beat as a gap.
    const fixture = createFixture(COLLABORATION_SCENARIO);

    await fixture.bridge.growth.channelMute({ channelId: CHANNEL_REVIEW });
    const late = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    expect(late.map((frame) => frame.type)).toStrictEqual(["channel.muted"]);
  });
});

describe("the fixture's channel directory — what the read answers once frames have landed", () => {
  /** The state `channel.list` reports for one channel, right now. */
  async function directoryStateOf(fixture: FixtureUnderTest, channelId: string): Promise<unknown> {
    const reply = await callBridge(fixture.bridge, "channel.list", {
      sessionId: COLLABORATION_SCENARIO.sessionId,
    });
    const channels = (reply as { readonly channels: readonly { id: string; state: unknown }[] })
      .channels;
    return channels.find((channel) => channel.id === channelId)?.state;
  }

  it("reports a channel live until its archival beat is due, and archived after", async () => {
    // The reading a fixed reply cannot give and the one the scenario is built to show.
    // Before the beat the room has not archived anything, so a read that answered
    // `archived` would be exposing state the script has not reached; after it, the
    // re-read the beat triggers is the transition every directory surface renders.
    const { fixture } = room();

    fixture.engine.advance(INTO_THE_OPENING_MS);
    const beforeTheBeat = await directoryStateOf(fixture, CHANNEL_HANDOFF);
    fixture.engine.advance(PAST_EVERY_BEAT_MS);
    const afterTheBeat = await directoryStateOf(fixture, CHANNEL_HANDOFF);

    expect(beforeTheBeat).toBe("active");
    expect(afterTheBeat).toBe("archived");
  });

  it("moves a channel a served act archived, which no beat in the script mentions", async () => {
    // The same fold from the other side: an act publishes a frame, and the directory
    // read is what every other reader of that session would then see. A fixture that
    // served the scripted reply back would answer the presser with the row's old state.
    const { fixture } = room();

    await fixture.bridge.growth.channelArchive({ channelId: CHANNEL_REVIEW });

    expect(await directoryStateOf(fixture, CHANNEL_REVIEW)).toBe("archived");
  });

  it("negative control: a channel no frame has moved keeps the state the script opens it in", async () => {
    // Without this, a fold that answered `archived` for every row — or one that
    // replaced the whole reply — would pass both cases above. The bootstrap channel is
    // in no lifecycle frame this room plays and reads live from first tick to last.
    const { fixture } = room();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(await directoryStateOf(fixture, CHANNEL_MAIN)).toBe("active");
  });
});
