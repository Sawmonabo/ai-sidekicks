// The two moves the channel ordering makes, and the ones it must not.

import type { ChannelListResponseChannel } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { orderChannelRows } from "./channel-model.js";

function channel(
  id: string,
  state: ChannelListResponseChannel["state"],
  name?: string,
): ChannelListResponseChannel {
  return name === undefined
    ? { id: id as ChannelListResponseChannel["id"], state, participantCount: 3 }
    : { id: id as ChannelListResponseChannel["id"], name, state, participantCount: 3 };
}

describe("channel ordering — the bootstrap channel", () => {
  it("hoists the main channel to the top wherever the daemon put it", () => {
    const ordered = orderChannelRows([
      channel("channel-review", "active", "review"),
      channel("channel-main", "active", "main"),
      channel("channel-relay", "muted", "relay"),
    ]);
    expect(ordered.live.map((row) => row.channel.id)).toStrictEqual([
      "channel-main",
      "channel-review",
      "channel-relay",
    ]);
    expect(ordered.live[0]?.isMain).toBe(true);
  });

  it("negative control: a list with no main channel reorders nothing", () => {
    const served = [
      channel("channel-review", "active", "review"),
      channel("channel-relay", "active", "relay"),
    ];
    const ordered = orderChannelRows(served);
    expect(ordered.live.map((row) => row.channel.id)).toStrictEqual([
      "channel-review",
      "channel-relay",
    ]);
    expect(ordered.live.every((row) => !row.isMain)).toBe(true);
  });
});

describe("channel ordering — states", () => {
  it("keeps a muted channel among the live ones", () => {
    // Mute suppresses attention, not execution: a muted channel still admits runs,
    // so demoting it would misreport what it is.
    const ordered = orderChannelRows([channel("channel-relay", "muted", "relay")]);
    expect(ordered.live).toHaveLength(1);
    expect(ordered.archived).toHaveLength(0);
  });

  it("sinks archived channels below the live ones and keeps their order", () => {
    const ordered = orderChannelRows([
      channel("channel-old", "archived", "old"),
      channel("channel-review", "active", "review"),
      channel("channel-older", "archived", "older"),
    ]);
    expect(ordered.live.map((row) => row.channel.id)).toStrictEqual(["channel-review"]);
    expect(ordered.archived.map((row) => row.channel.id)).toStrictEqual([
      "channel-old",
      "channel-older",
    ]);
  });

  it("negative control: an all-active list leaves the archived region empty", () => {
    const ordered = orderChannelRows([
      channel("channel-review", "active", "review"),
      channel("channel-relay", "muted", "relay"),
    ]);
    expect(ordered.archived).toStrictEqual([]);
  });
});

describe("channel ordering — what it never does", () => {
  it("preserves the daemon's order among non-main live rows", () => {
    // Sorting by name would put "alpha" first; the daemon's order is the one the
    // console renders, so the served sequence survives.
    const ordered = orderChannelRows([
      channel("channel-zulu", "active", "zulu"),
      channel("channel-alpha", "active", "alpha"),
    ]);
    expect(ordered.live.map((row) => row.channel.name)).toStrictEqual(["zulu", "alpha"]);
  });

  it("carries no notion of a row it was not served", () => {
    // The non-disclosure filter is the daemon's: a channel the caller may not see is
    // omitted, and this module has no field that could report one. Stated as a
    // property of the result's own shape rather than as a rendering choice.
    const ordered = orderChannelRows([channel("channel-main", "active", "main")]);
    const keys = new Set(Object.keys(ordered));
    expect(keys).toStrictEqual(new Set(["live", "archived"]));
    expect(ordered.live).toHaveLength(1);
  });

  it("keeps an unnamed channel rather than dropping it", () => {
    // `name` is optional on the wire and omission is the signal for a channel with
    // no friendly label. Dropping it would hide a channel the caller may see.
    const ordered = orderChannelRows([channel("channel-unnamed", "active")]);
    expect(ordered.live.map((row) => row.channel.id)).toStrictEqual(["channel-unnamed"]);
    expect(ordered.live[0]?.isMain).toBe(false);
  });
});
