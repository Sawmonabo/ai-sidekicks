// What a served lifecycle act puts on the session feed, and where it lands in the log.
//
// THE DEFECT THESE CASES EXIST FOR. A create, a mute, an unmute or an archive answered
// with a receipt and published nothing, so the four `channel.*` events the directory
// re-reads on could arrive only from an authored beat. Every surface built on the
// re-read path was therefore exercised by a frame somebody wrote in a script rather than
// by the act that provokes it, and a console that never published one would look
// identical here. The create was the last of the four to be fixed and the one whose cost
// was visible without any of that reasoning: a channel a person created appeared in no
// directory at all, because the scripted `channel.list` reply carries no row for it.
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

describe("the fixture's channel lifecycle — what a served act publishes", () => {
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

  it("announces a served CREATE, naming the channel the receipt minted and the name asked for", async () => {
    // The half a create was missing. Its receipt settled the press and nothing told the
    // session, so the row existed for the caller and for nobody else — the directory's
    // own re-read included, which is the reader every other participant would be.
    //
    // The IDENTITY comes from the receipt, on the three moves' rule: the daemon mints
    // it and the caller does not. The NAME comes from the request, because that is the
    // only place it exists — `channel.created` is `{channelId, name?}` and no receipt
    // on this wire carries a name.
    const { fixture, frames } = room();

    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: COLLABORATION_SCENARIO.sessionId,
      name: "handover",
    });

    expect(outcome.status).toBe("served");
    expect(frames.map((frame) => frame.type)).toStrictEqual(["channel.created"]);
    expect(channelIdAt(frames, 0)).toBe(
      outcome.status === "served" ? outcome.value.channelId : undefined,
    );
    expect(frames[0]?.payload["name"]).toBe("handover");
  });

  it("omits the name for a create that carried none, rather than announcing an empty one", async () => {
    // `name?` is an ABSENT member on this wire and never a present empty one — the
    // shape a `direct` channel is created with, whose label is the other human in its
    // pair rather than a name anybody typed.
    const { fixture, frames } = room();

    await fixture.bridge.growth.channelCreate({ sessionId: COLLABORATION_SCENARIO.sessionId });

    expect(frames[0]?.type).toBe("channel.created");
    expect(Object.hasOwn(frames[0]?.payload ?? {}, "name")).toBe(false);
  });

  it("negative control: a create no scenario answers publishes nothing", async () => {
    // Without this the two cases above would pass over a fixture that published on the
    // way IN — a console learning that a channel it was refused had been created. The
    // room's OWN session is asked about, so the refusal is the missing script rather
    // than the scoping guard beside it.
    const scenario = unscriptedScenario("channel-create-unscripted");
    const { fixture, frames } = room(scenario);

    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: scenario.sessionId,
      name: "handover",
    });

    expect(outcome.status).toBe("unavailable");
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
  /** One row of the directory `channel.list` answers with, right now. */
  async function directoryRowOf(
    fixture: FixtureUnderTest,
    channelId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const reply = await callBridge(fixture.bridge, "channel.list", {
      sessionId: COLLABORATION_SCENARIO.sessionId,
    });
    const channels = (reply as { readonly channels: readonly Record<string, unknown>[] }).channels;
    return channels.find((channel) => channel["id"] === channelId);
  }

  /** The state `channel.list` reports for one channel, right now. */
  async function directoryStateOf(fixture: FixtureUnderTest, channelId: string): Promise<unknown> {
    return (await directoryRowOf(fixture, channelId))?.["state"];
  }

  /** Create one channel in this room and answer with the id the receipt minted. */
  async function createdChannelId(fixture: FixtureUnderTest, name?: string): Promise<string> {
    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: COLLABORATION_SCENARIO.sessionId,
      ...(name === undefined ? {} : { name }),
    });
    if (outcome.status !== "served") {
      throw new Error("this room scripts a create receipt, so the create should have been served");
    }
    return outcome.value.channelId;
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

  it("adds the row a served create minted, which the scripted directory holds none of", async () => {
    // The other half of the create defect. The receipt settled and the form reset, and
    // the channel appeared nowhere: the scripted `channel.list` reply has no row for a
    // channel nobody had created when the script was written, so the only way it can
    // arrive is the fold. A live channel is what a create leaves behind.
    const { fixture } = room();

    const channelId = await createdChannelId(fixture, "handover");

    expect(await directoryRowOf(fixture, channelId)).toStrictEqual({
      id: channelId,
      name: "handover",
      state: "active",
      participantCount: 1,
    });
  });

  it("omits the name on a created row whose creation carried none", async () => {
    // `name?` is absent on this wire rather than empty, so a row folded from a
    // creation that named nothing carries no member at all — the shape the directory
    // labels by the other human in the pair.
    const { fixture } = room();

    const channelId = await createdChannelId(fixture);

    expect(Object.hasOwn((await directoryRowOf(fixture, channelId)) ?? {}, "name")).toBe(false);
  });

  it("moves a created row on, exactly as it moves a row the script opened", async () => {
    // The fold walks the log in order and the last transition wins, so a channel
    // created and then archived in one window reads archived — the created row is an
    // opening state like any other rather than a fixed answer appended past the fold.
    const { fixture } = room();

    const channelId = await createdChannelId(fixture, "handover");
    await fixture.bridge.growth.channelArchive({ channelId });

    expect(await directoryStateOf(fixture, channelId)).toBe("archived");
  });

  it("negative control: a create no scenario answers adds no row", async () => {
    // Without this the cases above would pass over a fold that appended a row for the
    // ASKING rather than for what the session was told — a directory listing a channel
    // the daemon refused to create. The room scripts an empty directory and no create,
    // so the only thing that could put a row there is the act.
    const scenario: ConsoleScenario = {
      ...unscriptedScenario("channel-create-directory-unscripted"),
      replies: [{ call: "channel.list", result: { channels: [] } }],
    };
    const { fixture } = room(scenario);

    const outcome = await fixture.bridge.growth.channelCreate({
      sessionId: scenario.sessionId,
      name: "handover",
    });
    const reply = await callBridge(fixture.bridge, "channel.list", {
      sessionId: scenario.sessionId,
    });

    expect(outcome.status).toBe("unavailable");
    expect((reply as { readonly channels: readonly unknown[] }).channels).toStrictEqual([]);
  });

  it("lists one row for a channel two presses created, because the receipt names one", async () => {
    // A scenario answers one call one way, so a second Create is answered with the same
    // identity — and two rows for one channel is a shape no `channel.list` can send.
    const { fixture } = room();

    const first = await createdChannelId(fixture, "handover");
    const second = await createdChannelId(fixture, "handover again");
    const reply = await callBridge(fixture.bridge, "channel.list", {
      sessionId: COLLABORATION_SCENARIO.sessionId,
    });
    const rows = (reply as { readonly channels: readonly { readonly id: string }[] }).channels;

    expect(second).toBe(first);
    expect(rows.filter((channel) => channel.id === first)).toHaveLength(1);
  });

  it("negative control: a room that announces its own channels lists each of them once", async () => {
    // The filter that keeps the appended rows from doubling the directory. This room
    // plays a `channel.created` beat for every channel its scripted reply already
    // carries — every shipped scenario does — so a fold that appended for the creation
    // rather than for the absence would list all four twice.
    const { fixture } = room();
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const reply = await callBridge(fixture.bridge, "channel.list", {
      sessionId: COLLABORATION_SCENARIO.sessionId,
    });
    const identifiers = (
      reply as { readonly channels: readonly { readonly id: string }[] }
    ).channels.map((channel) => channel.id);

    expect(new Set(identifiers).size).toBe(identifiers.length);
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
