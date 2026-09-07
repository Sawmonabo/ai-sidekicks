// What a SERVED lifecycle receipt does to the row it names, and when it stops.
//
// The defect this file exists for: the answer to a mute, an unmute or an archive was
// discarded at the call site, so the row went on rendering the state the last read
// carried until the matching `channel.*` event drove a fresh one — offering the same
// control again in between, which is the surface inviting a press the daemon would
// answer with nothing.
//
// EVERY CASE HERE DRIVES A SCRIPTED ANSWER, which is what separates this file from
// `ChannelList.lifecycle.test.tsx` beside it: that one reads refusals and which verb a
// control reaches, and this one reads the row after the daemon said yes. The receipt
// travels the same growth port a refusal does, so a surface that stopped applying it
// fails here rather than passing quietly.
//
// AND THE SECOND HALF IS A SECOND READ. An overlay that outlived the directory would
// be the second source of truth this console does not have, so two cases serve a fresh
// directory into the list already on screen and read which answer wins.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { SESSION_EVENT_STREAM } from "../../bridge/index.js";
import {
  createFixture,
  subscribeThroughBridge,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { acts, confirmArchive, press, rowNames } from "./channel-rows.test-support.js";
import {
  CHANNEL_RELAY,
  CHANNEL_REVIEW,
  channel,
  channelsBridge,
  loaded,
  mainChannel,
  renderChannelListSettled,
  scenarioAnswering,
  serveChannelRead,
} from "./channels.test-support.js";

describe("channel list — the state a served receipt reported", () => {
  it("shows the row muted and offers unmute, before any event has arrived", async () => {
    // The defect this block exists for: the receipt was discarded, so the row went on
    // rendering `active` until the `channel.muted` event drove a fresh read, and
    // offered Mute again in the meantime — the surface inviting a second press the
    // daemon would answer with nothing.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          scenario: scenarioAnswering("channel.mute", {
            channelId: CHANNEL_REVIEW,
            state: "muted",
          }),
        }),
      },
    );

    await press(container, 0);

    expect(acts(container)[0]?.textContent).toBe("Unmute");
    expect(acts(container)[0]?.getAttribute("aria-label")).toBe("Unmute review");
  });

  it("sinks a row the daemon archived, leaving no act on it", async () => {
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          scenario: scenarioAnswering("channel.archive", {
            channelId: CHANNEL_REVIEW,
            state: "archived",
          }),
        }),
      },
    );

    await confirmArchive(container, 3);

    // Applied BEFORE ordering, which is what makes this a change of REGION rather than
    // of chip: a terminal row left among the live ones would still be wearing controls
    // for acts that can only fail.
    expect(rowNames(container)).toStrictEqual([MAIN_CHANNEL_NAME, "review"]);
    expect(
      container.querySelectorAll(".meridian-channels__list--archived .meridian-channel-row"),
    ).toHaveLength(1);
    expect(acts(container)).toHaveLength(2);
  });

  it("publishes the transition its own re-read is bound to, off the fixture's feed", async () => {
    // The other half of one move, and the half no case here could see: the receipt is
    // what moves the row on screen, and the EVENT is what tells this window's directory
    // to read again. A fixture that answered the call and published nothing left the
    // overlay above standing with nothing able to retire it — and every case in this
    // file went on passing, because the signal reaches the list as a fresh READ and the
    // read is a prop here.
    //
    // So the frame is read off the real fixture the press already goes through, rather
    // than pushed into a store by hand: what a hand-written frame proves is that the
    // console folds one, and what is in doubt is whether the act produces one at all.
    const fixture = createFixture(
      scenarioAnswering("channel.mute", { channelId: CHANNEL_REVIEW, state: "muted" }),
    );
    const frames = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: fixture.bridge },
    );

    await press(container, 0);

    expect(acts(container)[0]?.textContent).toBe("Unmute");
    // One of the four kinds `channel-model.ts` re-reads on, naming the row that moved.
    expect(frames.map((frame) => frame.type)).toStrictEqual(["channel.muted"]);
    expect(frames[0]?.payload["channelId"]).toBe(CHANNEL_REVIEW);
  });

  it("negative control: a receipt naming another channel moves neither row", async () => {
    // Without the id check the row that was PRESSED takes whatever came back, and the
    // console would be learning from the wire that a mute is session-wide.
    const { container } = await renderChannelListSettled(
      loaded([
        channel(CHANNEL_REVIEW, "active", "review"),
        channel(CHANNEL_RELAY, "active", "relay"),
      ]),
      {
        bridge: channelsBridge({
          scenario: scenarioAnswering("channel.mute", {
            channelId: CHANNEL_RELAY,
            state: "muted",
          }),
        }),
      },
    );

    await press(container, 0);

    expect(acts(container)[0]?.textContent).toBe("Mute");
    expect(acts(container)[2]?.textContent).toBe("Mute");
  });
});

describe("channel list — what a later read does to that state", () => {
  const mutedReceipt = scenarioAnswering("channel.mute", {
    channelId: CHANNEL_REVIEW,
    state: "muted",
  });

  it("hands the row back to the directory the moment its read reports something else", async () => {
    const bridge = channelsBridge({ scenario: mutedReceipt });
    const rendered = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge },
    );
    await press(rendered.container, 0);
    expect(acts(rendered.container)[0]?.textContent).toBe("Unmute");

    // Somebody else archived it. That is NEWER news than this console's receipt, and a
    // surface preferring its own older answer would leave a terminal row wearing
    // controls for as long as the window stayed open.
    await serveChannelRead(rendered, loaded([channel(CHANNEL_REVIEW, "archived", "review")]), {
      bridge,
    });

    expect(acts(rendered.container)).toHaveLength(0);
    expect(
      rendered.container.querySelectorAll(
        ".meridian-channels__list--archived .meridian-channel-row",
      ),
    ).toHaveLength(1);
  });

  it("negative control: a read that has not caught up leaves the daemon's answer standing", async () => {
    // The other half of the same rule, and the reason clearing is keyed on the read
    // MOVING rather than on a read arriving: this second read simply predates the mute,
    // and dropping the overlay on its arrival would flip the row back to the state the
    // daemon has already moved it out of.
    const bridge = channelsBridge({ scenario: mutedReceipt });
    const rendered = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge },
    );
    await press(rendered.container, 0);

    await serveChannelRead(rendered, loaded([channel(CHANNEL_REVIEW, "active", "review")]), {
      bridge,
    });

    expect(acts(rendered.container)[0]?.textContent).toBe("Unmute");
  });
});
