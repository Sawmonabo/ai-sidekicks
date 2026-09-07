// The three facts the roster adds to a row, and what a row wears without them.
//
// A separate suite from the directory's own because the two reads fail independently:
// these cases are about an ENRICHMENT arriving, not arriving, or refusing, over a list
// that is complete either way.

import { MAIN_CHANNEL_NAME, type ChannelListResponseChannel } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge, GrowthChannelRosterEntry } from "../../bridge/index.js";

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
  serveChannelRead,
  settleChannelReads,
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
    const rendered = renderChannelList(loaded([channel(CHANNEL_REVIEW, "active", "review")]), {
      bridge: channelsBridge({
        roster: [rosterEntry(CHANNEL_REVIEW, { audience: "participants" })],
      }),
    });
    const { container } = rendered;

    expect(audienceBadges(container)).toStrictEqual([]);
    expect(container.querySelector(".meridian-channels__roster-refusal")).toBeNull();

    await settleChannelReads(rendered.bridge);

    expect(audienceBadges(container)).toStrictEqual(["participants"]);
  });
});

describe("channel list — a channel created while the list stayed mounted", () => {
  /**
   * A list whose roster answers from whatever this room currently holds.
   *
   * The entries are read at the moment of the CALL rather than fixed when the bridge was
   * built, which is what makes a second read distinguishable from no second read at all.
   */
  function mountedRoom(): {
    readonly roster: GrowthChannelRosterEntry[];
    readonly render: (
      directory: readonly ChannelListResponseChannel[],
    ) => Promise<ReturnType<typeof renderChannelList>>;
    readonly overrides: { readonly bridge: ConsoleBridge };
  } {
    const roster: GrowthChannelRosterEntry[] = [
      rosterEntry(CHANNEL_REVIEW, { name: "review", audience: "participants" }),
    ];
    const overrides = { bridge: channelsBridge({ roster: () => roster }) };
    return {
      roster,
      overrides,
      render: async (directory) => await renderChannelListSettled(loaded(directory), overrides),
    };
  }

  /** The direct channel a person just created, as both reads come to carry it. */
  const directEntry = rosterEntry(CHANNEL_DIRECT, {
    name: "a name nobody should read",
    kind: "direct",
    memberPair: [PARTICIPANT_OTHER, PARTICIPANT_YOU],
    audience: "humans-only",
  });

  it("badges and labels the new row without the section being remounted", async () => {
    // The defect this case exists for. The directory re-reads on the `channel.created`
    // frame and the row arrives; the roster read behind the three facts a row wears was
    // asked once per SESSION, so it never asked again and the row sat there wearing the
    // name that was typed into the form rather than the pair it is between.
    const room = mountedRoom();
    const rendered = await room.render([channel(CHANNEL_REVIEW, "active", "review")]);

    room.roster.push(directEntry);
    await serveChannelRead(
      rendered,
      loaded([
        channel(CHANNEL_REVIEW, "active", "review"),
        channel(CHANNEL_DIRECT, "active", "a name nobody should read"),
      ]),
      room.overrides,
    );

    const names = [...rendered.container.querySelectorAll(".meridian-channel-row__name")].map(
      (name) => name.textContent ?? "",
    );
    expect(names).toStrictEqual(["review", "Dana"]);
    expect(audienceBadges(rendered.container)).toStrictEqual(["participants", "humans-only"]);
  });

  it("negative control: a row whose state moved re-reads no roster at all", async () => {
    // Without this the case above would pass over a read that asked again on every
    // directory answer, which is the poll the refresh chokepoint exists to prevent. A
    // mute moves a row's state and leaves the channel set exactly as it was, so the
    // roster this room grows in between is never fetched and the badge stays as it was.
    const room = mountedRoom();
    const rendered = await room.render([channel(CHANNEL_REVIEW, "active", "review")]);

    room.roster.splice(0, room.roster.length, rosterEntry(CHANNEL_REVIEW, { name: "review" }));
    await serveChannelRead(
      rendered,
      loaded([channel(CHANNEL_REVIEW, "muted", "review")]),
      room.overrides,
    );

    expect(audienceBadges(rendered.container)).toStrictEqual(["participants"]);
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
