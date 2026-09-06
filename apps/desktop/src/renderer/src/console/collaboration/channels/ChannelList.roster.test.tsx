// The three facts the roster adds to a row, and what a row wears without them.
//
// A separate suite from the directory's own because the two reads fail independently:
// these cases are about an ENRICHMENT arriving, not arriving, or refusing, over a list
// that is complete either way.

import { MAIN_CHANNEL_NAME } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/settle.test-support.js";

import {
  CHANNEL_DIRECT,
  CHANNEL_REVIEW,
  PARTICIPANT_OTHER,
  PARTICIPANT_YOU,
  channel,
  channelsBridge,
  loaded,
  mainChannel,
  renderChannelList,
  renderChannelListSettled,
  rosterEntry,
} from "./channels.test-support.js";

/** Every audience badge on screen, in row order. */
function audienceBadges(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-channel-row__audience")].map(
    (badge) => badge.textContent ?? "",
  );
}

describe("channel list — the audience badge", () => {
  it("badges each row with the audience the wire sent", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review"), channel(CHANNEL_DIRECT, "active")]),
      {
        bridge: channelsBridge({
          roster: [
            rosterEntry(CHANNEL_REVIEW, { name: "review", audience: "participants" }),
            rosterEntry(CHANNEL_DIRECT, { audience: "humans-only" }),
          ],
        }),
      },
    );
    expect(audienceBadges(container)).toStrictEqual(["participants", "humans-only"]);
  });

  it("says what each audience means rather than leaving the word to be guessed at", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          roster: [rosterEntry(CHANNEL_REVIEW, { audience: "humans-only" })],
        }),
      },
    );
    expect(container.querySelector(".meridian-channel-row__audience")?.getAttribute("title")).toBe(
      "No agent ever reads this channel.",
    );
  });

  it("badges no row the roster did not name", async () => {
    // The main channel has no channel row at all — the directory projection composes
    // it from the session's own membership count — so the roster carries no entry for
    // it. It wears no badge rather than one the console worked out from a count.
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
      {
        bridge: channelsBridge({
          roster: [rosterEntry(CHANNEL_REVIEW, { audience: "participants" })],
        }),
      },
    );
    expect(container.querySelectorAll(".meridian-channel-row")).toHaveLength(2);
    expect(audienceBadges(container)).toStrictEqual(["participants"]);
  });

  it("badges nothing at all while the roster read is still in flight", async () => {
    // Asserted before the read settles and again after: a badge that appeared
    // optimistically would be a claim about who reads a channel that nothing has
    // answered yet, and the second half is what keeps the first from passing over a
    // list that never badges anything.
    const { container } = renderChannelList(loaded([channel(CHANNEL_REVIEW, "active", "review")]), {
      bridge: channelsBridge({
        roster: [rosterEntry(CHANNEL_REVIEW, { audience: "participants" })],
      }),
    });

    expect(audienceBadges(container)).toStrictEqual([]);
    expect(container.querySelector(".meridian-channels__roster-refusal")).toBeNull();

    await settle();

    expect(audienceBadges(container)).toStrictEqual(["participants"]);
  });
});

describe("channel list — what a direct row is called", () => {
  const directRoster = [
    rosterEntry(CHANNEL_DIRECT, {
      name: "a name nobody should read",
      kind: "direct",
      memberPair: [PARTICIPANT_OTHER, PARTICIPANT_YOU],
    }),
  ];

  it("labels it with the other human and never with a channel name", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_DIRECT, "active", "a name nobody should read")]),
      { bridge: channelsBridge({ roster: directRoster }) },
    );
    const name = container.querySelector(".meridian-channel-row__name");
    expect(name?.textContent).toBe("Dana");
    expect(container.textContent ?? "").not.toContain("a name nobody should read");
  });

  it("renders that label as a figure the console composed rather than one the wire sent", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_DIRECT, "active")]),
      { bridge: channelsBridge({ roster: directRoster }) },
    );
    expect(
      container.querySelector(".meridian-channel-row__name .meridian-figure--derived"),
    ).not.toBeNull();
  });

  it("names both members where this window's own participant is unread", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_DIRECT, "active")]),
      { bridge: channelsBridge({ roster: directRoster }), viewerParticipantId: undefined },
    );
    expect(container.querySelector(".meridian-channel-row__name")?.textContent).toBe(
      `Dana and ${PARTICIPANT_YOU}`,
    );
  });

  it("negative control: an ordinary row keeps its own name", async () => {
    // Without this, the cases above would pass over a list that pair-labelled
    // everything, which would take a general channel's name off the screen.
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ roster: [rosterEntry(CHANNEL_REVIEW, { name: "review" })] }) },
    );
    expect(container.querySelector(".meridian-channel-row__name")?.textContent).toBe("review");
  });
});

describe("channel list — when the roster refuses", () => {
  it("says so in one quiet line and leaves every row where it was", async () => {
    // A missing badge is not a missing directory. The rows are still legible, still
    // openable, and still carry their own state and their own lifecycle controls.
    const { container } = await renderChannelListSettled(
      loaded([mainChannel(), channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ roster: "refused" }) },
    );

    const line = container.querySelector(".meridian-channels__roster-refusal");
    expect(line).not.toBeNull();
    expect(container.querySelectorAll(".meridian-channel-row")).toHaveLength(2);
    expect(container.querySelectorAll(".meridian-channel-row__open")).toHaveLength(2);
    expect(container.querySelectorAll(".meridian-channel-row__acts")).toHaveLength(2);
  });

  it("stands beside the rows rather than in place of them", async () => {
    // The shape is the claim: an inline refusal under the list, never the card the
    // directory's own failure renders, which is what stands where rows were.
    const { container } = await renderChannelListSettled(loaded([mainChannel()]), {
      bridge: channelsBridge({ roster: "refused" }),
    });
    expect(container.querySelector(".meridian-refusal--inline")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal--card")).toBeNull();
    expect(container.querySelector(".meridian-channel-row__name")?.textContent).toBe(
      MAIN_CHANNEL_NAME,
    );
  });

  it("negative control: a served roster puts no line under the rows", async () => {
    const { container } = await renderChannelListSettled(
      loaded([channel(CHANNEL_REVIEW, "active", "review")]),
      { bridge: channelsBridge({ roster: [rosterEntry(CHANNEL_REVIEW)] }) },
    );
    expect(container.querySelector(".meridian-channels__roster-refusal")).toBeNull();
  });
});
