// When the roster asks again, and — as load-bearing — when it does not.
//
// THE DEFECT THESE CASES EXIST FOR. The roster was asked once per session, and a
// session does not move when a channel is created in it. So a channel created while
// the list stayed mounted arrived from the directory's own re-read and then sat there
// with none of the three facts this read carries — a direct row wearing its typed name
// instead of its member pair, and no audience badge on any of them — until something
// unmounted the section.
//
// AND THE OTHER HALF IS WHY IT CANNOT SIMPLY ASK MORE. "The roster does not name every
// row the directory carries" is an ORDINARY state, so a refresh keyed on that gap would
// re-ask forever against a daemon answering the same way each time. The trigger is the
// directory's channel set CHANGING, which is why most cases below read `readCount`
// rather than the value: what is under test is how many times the wire was asked.
//
// AND ONE CASE READS THE ANSWER, BECAUSE THE BASELINE IS AN ORDERING CLAIM. The first
// directory answer is the baseline BECAUSE the first read is issued after it. A read put
// on the wire at the mount instead can settle before the directory's own first reply, and
// a channel created between those two replies is then in the directory answer and absent
// from the roster beside it — a baseline that is a whole row out of date, and one no count
// of reads can see. So that case reads the entries the roster carries.
//
// Driven against the real class rather than through a rendered list, because the
// coalescing is the scheduler's and a component test could only observe it indirectly.

import { describe, expect, it } from "vitest";

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";

import type { GrowthChannelRosterEntry } from "../../bridge/index.js";
import { ManualClock } from "../../core/index.js";
import { PAST_REFRESH_DEBOUNCE_MS } from "../../core/settle.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { ChannelRosterRead } from "./channel-roster-read.js";
import {
  CHANNEL_DIRECT,
  CHANNEL_MAIN,
  CHANNEL_REVIEW,
  SESSION_ID,
  channel,
  channelsBridge,
  rosterEntry,
  type ChannelsBridgeRoster,
} from "./channels.test-support.js";

/**
 * One roster read for this session, on a clock the case advances by hand.
 *
 * The roster answer is a parameter because the ordering case needs the ROOM to move
 * between the mount and the directory's first answer: a fixed list answers every read
 * the same way, so a read racing the directory could not be told from one issued behind
 * it.
 */
function rosterReadUnderTest(roster: ChannelsBridgeRoster = [rosterEntry(CHANNEL_REVIEW)]): {
  read: ChannelRosterRead;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const bridge = channelsBridge({ roster });
  return { read: new ChannelRosterRead({ bridge, sessionId: SESSION_ID, clock }), clock };
}

/** The channels this read's answer names, or `undefined` before one has landed. */
function rosterChannelIds(read: ChannelRosterRead): readonly string[] | undefined {
  const state = read.model.state;
  return state.kind === "loaded" ? state.value?.map((entry) => entry.id) : undefined;
}

/** Carry whatever this read has requested past its debounce window and let it land. */
async function performRequestedReads(clock: ManualClock): Promise<void> {
  clock.advance(PAST_REFRESH_DEBOUNCE_MS);
  await crossMacrotaskBoundary();
}

/** A directory carrying these channels, all live. */
function directory(...channelIds: readonly string[]): readonly ChannelListResponseChannel[] {
  return channelIds.map((channelId) => channel(channelId, "active"));
}

describe("the channel roster read — when it asks again", () => {
  it("asks again once the directory names a channel it was not asked about", async () => {
    const { read, clock } = rosterReadUnderTest();
    read.start();
    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    await performRequestedReads(clock);

    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW, CHANNEL_DIRECT));
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(2);
  });

  it("asks once for a burst of changes rather than once for each", async () => {
    // The coalescing the refresh chokepoint exists for, counted rather than inferred: a
    // session whose directory moves three times inside one window is one question.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    read.observeDirectory(directory(CHANNEL_MAIN));
    await performRequestedReads(clock);

    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW, CHANNEL_DIRECT));
    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_DIRECT));
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(2);
  });

  it("negative control: a directory whose channels have not moved asks nothing more", async () => {
    // The half that keeps the cases above from passing over a read that asks on every
    // observation. A mute, an unmute and an archive move a row's STATE and leave the set
    // exactly as it was, so they are the ordinary directory re-read and they cost no
    // roster call at all.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    await performRequestedReads(clock);

    read.observeDirectory([channel(CHANNEL_MAIN, "active"), channel(CHANNEL_REVIEW, "muted")]);
    read.observeDirectory([channel(CHANNEL_MAIN, "active"), channel(CHANNEL_REVIEW, "archived")]);
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(1);
  });

  it("asks nothing at all until the directory has answered", async () => {
    // The baseline is an ordering claim, so the mount opens nothing: a read issued here
    // would be racing the directory's own first reply rather than answering behind it.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(0);
    expect(read.model.state.kind).toBe("not-loaded");
  });

  it("negative control: the first directory answer asks exactly once", async () => {
    // The half that keeps the case above from passing over a read that never asks at
    // all: the directory's first answer is the baseline AND the trigger for the first
    // read, and the two together are one question and not two.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    await performRequestedReads(clock);

    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(1);
  });

  it("answers from the room as it stands at the directory's first answer", async () => {
    // THE DEFECT THIS CASE EXISTS FOR. This read was asked at the mount, so it could
    // settle BEFORE the directory's own first reply — and a channel created between the
    // two replies is in that directory answer and missing from the roster snapshot taken
    // ahead of it. Treated as a baseline anyway, the new row wore its typed name and no
    // audience badge until some later channel-set change happened to ask again.
    const room: GrowthChannelRosterEntry[] = [rosterEntry(CHANNEL_REVIEW)];
    // COPIED at the moment of the call, not handed over: a served reference would go on
    // growing inside the answer this read is already holding, and the case would pass
    // over a read that never asked again at all.
    const { read, clock } = rosterReadUnderTest(() => [...room]);
    read.start();
    // The mount's own refresh window elapses with the directory still unanswered: a read
    // put on the wire at the mount is answered from the room exactly here.
    await performRequestedReads(clock);

    // Somebody creates a direct channel, and the directory answers for the first time
    // carrying it.
    room.push(rosterEntry(CHANNEL_DIRECT, { kind: "direct" }));
    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW, CHANNEL_DIRECT));
    await performRequestedReads(clock);

    expect(rosterChannelIds(read)).toStrictEqual([CHANNEL_REVIEW, CHANNEL_DIRECT]);
  });

  it("negative control: a directory that has not answered is observed as nothing", async () => {
    // `undefined` is the directory still reading, and it is not an empty set: taken as
    // one, the first real answer would be a change against it and the mount would ask
    // twice after all.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    read.observeDirectory(undefined);
    read.observeDirectory(directory(CHANNEL_MAIN));
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(1);
  });

  it("stops asking once it is disposed", async () => {
    const { read, clock } = rosterReadUnderTest();
    read.start();
    read.observeDirectory(directory(CHANNEL_MAIN));
    await performRequestedReads(clock);
    read.dispose();

    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    await performRequestedReads(clock);

    expect(read.isDisposed).toBe(true);
    expect(read.model.readCount).toBe(1);
  });
});
