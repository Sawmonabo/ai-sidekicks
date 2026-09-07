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
// directory's channel set CHANGING, which is why every case below reads `readCount`
// rather than the value: what is under test is how many times the wire was asked.
//
// Driven against the real class rather than through a rendered list, because the
// coalescing is the scheduler's and a component test could only observe it indirectly.

import { describe, expect, it } from "vitest";

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";

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
} from "./channels.test-support.js";

/** One roster read for this session, on a clock the case advances by hand. */
function rosterReadUnderTest(): { read: ChannelRosterRead; clock: ManualClock } {
  const clock = new ManualClock();
  const bridge = channelsBridge({ roster: [rosterEntry(CHANNEL_REVIEW)] });
  return { read: new ChannelRosterRead({ bridge, sessionId: SESSION_ID, clock }), clock };
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

  it("negative control: the first directory it sees is a baseline and not a change", async () => {
    // Without this the trigger would spend a second read at every mount: the directory
    // has not answered when this read is started, so its first answer would look like a
    // change — over a roster asked at the same moment the directory was.
    const { read, clock } = rosterReadUnderTest();
    read.start();
    await performRequestedReads(clock);

    read.observeDirectory(directory(CHANNEL_MAIN, CHANNEL_REVIEW));
    await performRequestedReads(clock);

    expect(read.model.readCount).toBe(1);
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
