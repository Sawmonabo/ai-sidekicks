// What the roster read projects, and — as load-bearing — what it refuses to invent.
//
// The four projections are pure, so they are driven directly rather than through a
// rendered directory: what they get wrong is a badge asserted for a row the wire never
// named and a pair labelled with a caller identity nobody established, and both are
// decided here rather than in a component.

import { describe, expect, it } from "vitest";

import type { GrowthChannelRosterEntry } from "../../bridge/index.js";
import { refuse } from "../../core/index.js";
import {
  CHANNEL_ROSTER_ORIGIN,
  channelAudienceOf,
  channelKindOf,
  directChannelLabel,
  rosterEntriesById,
  rosterRefusal,
  type ChannelRosterOutcome,
} from "./channel-roster.js";
import {
  CHANNEL_DIRECT,
  CHANNEL_REVIEW,
  LABELS,
  PARTICIPANT_OTHER,
  PARTICIPANT_THIRD,
  PARTICIPANT_YOU,
  SESSION_ID,
  channelsBridge,
  rosterEntry,
} from "./channels.test-support.js";

/** The port's own answer for a roster it serves. Read through the real bridge. */
async function servedRoster(
  entries: readonly GrowthChannelRosterEntry[],
): Promise<ChannelRosterOutcome> {
  return await channelsBridge({ roster: entries }).growth.channelRosterRead({
    sessionId: SESSION_ID,
  });
}

/** The port's own refusal, built by the shipped builder rather than written down. */
async function refusedRoster(): Promise<ChannelRosterOutcome> {
  return await channelsBridge({ roster: "refused" }).growth.channelRosterRead({
    sessionId: SESSION_ID,
  });
}

describe("channel roster — the entries", () => {
  it("keys every entry the read carried by the id the directory holds", async () => {
    const outcome = await servedRoster([
      rosterEntry(CHANNEL_REVIEW, { name: "review", audience: "participants" }),
      rosterEntry(CHANNEL_DIRECT, {
        kind: "direct",
        memberPair: [PARTICIPANT_YOU, PARTICIPANT_OTHER],
      }),
    ]);

    const byId = rosterEntriesById({ kind: "answered", outcome });

    expect([...byId.keys()]).toStrictEqual([CHANNEL_REVIEW, CHANNEL_DIRECT]);
    expect(byId.get(CHANNEL_REVIEW)?.name).toBe("review");
  });

  it("names nothing on a read that refused", async () => {
    const outcome = await refusedRoster();
    expect(rosterEntriesById({ kind: "answered", outcome }).size).toBe(0);
  });

  it("names nothing on a read that never answered", () => {
    // The two absences a surface really has: no call has settled yet, and the call
    // rejected. Neither may put a row in the map, because every consumer of it reads
    // an absent entry as "the wire did not say" and draws no badge at all.
    expect(rosterEntriesById(undefined).size).toBe(0);
    expect(
      rosterEntriesById({
        kind: "unreadable",
        refusal: refuse(CHANNEL_ROSTER_ORIGIN, "boom", "The call went nowhere."),
      }).size,
    ).toBe(0);
  });
});

describe("channel roster — why it is not here", () => {
  it("carries the port's own refusal verbatim", async () => {
    const outcome = await refusedRoster();
    if (outcome.status !== "unavailable") {
      throw new Error("the roster override answered, so this case has no refusal to relay");
    }

    // The refusal a surface renders IS the port's, by identity: nothing here rebuilds
    // it, so the code and the sentence a person reads are the ones the port composed
    // from that operation's own slate row.
    expect(rosterRefusal({ kind: "answered", outcome })).toBe(outcome);
  });

  it("carries a rejection's refusal verbatim", () => {
    const refusal = rosterRefusal({
      kind: "unreadable",
      refusal: refuse(CHANNEL_ROSTER_ORIGIN, "growth-read-call-failed", "The call rejected."),
    });
    expect(refusal?.code).toBe("growth-read-call-failed");
  });

  it("says nothing while the read is still in flight, and nothing when it answered", async () => {
    // The rows are already on screen in both cases, so a line under them would be
    // reporting a state rather than a problem.
    expect(rosterRefusal(undefined)).toBeUndefined();
    const outcome = await servedRoster([rosterEntry(CHANNEL_REVIEW)]);
    expect(rosterRefusal({ kind: "answered", outcome })).toBeUndefined();
  });
});

describe("channel roster — the two facts a badge is built from", () => {
  it("reports the audience and the kind the wire sent", () => {
    const entry = rosterEntry(CHANNEL_REVIEW, { audience: "humans-only" });
    expect(channelAudienceOf(entry)).toBe("humans-only");
    expect(channelKindOf(entry)).toBe("general");
  });

  it("reports neither for a row the roster did not name", () => {
    // The rule the whole read exists for: an audience is a daemon obligation, so a row
    // nobody asked about wears no badge rather than one derived from a member count.
    expect(channelAudienceOf(undefined)).toBeUndefined();
    expect(channelKindOf(undefined)).toBeUndefined();
  });

  it("reports no audience for an entry whose configuration carried none", () => {
    expect(channelAudienceOf(rosterEntry(CHANNEL_REVIEW))).toBeUndefined();
  });
});

describe("channel roster — what a direct row is called", () => {
  const pair = rosterEntry(CHANNEL_DIRECT, {
    kind: "direct",
    memberPair: [PARTICIPANT_OTHER, PARTICIPANT_YOU],
  });

  it("names the other human, whichever half of the pair the viewer is", () => {
    expect(directChannelLabel(pair, PARTICIPANT_YOU, LABELS)).toBe("Dana");
    expect(directChannelLabel(pair, PARTICIPANT_OTHER, LABELS)).toBe(PARTICIPANT_YOU);
  });

  it("names both members where this window's own participant is unknown", () => {
    // Fail-closed: "the other human" is a claim that needs to know who this window is,
    // and inventing a caller identity for a nicer label is the wrong trade.
    expect(directChannelLabel(pair, undefined, LABELS)).toBe(`Dana and ${PARTICIPANT_YOU}`);
  });

  it("names both members for a pair this window is not in", () => {
    expect(directChannelLabel(pair, PARTICIPANT_THIRD, LABELS)).toBe(`Dana and ${PARTICIPANT_YOU}`);
  });

  it("negative control: an ordinary channel takes no pair label at all", () => {
    // Without this, every case above would pass over a projection that labelled every
    // row with its members — which would replace a general channel's own name.
    expect(
      directChannelLabel(rosterEntry(CHANNEL_REVIEW), PARTICIPANT_YOU, LABELS),
    ).toBeUndefined();
    expect(
      directChannelLabel(rosterEntry(CHANNEL_DIRECT, { kind: "direct" }), PARTICIPANT_YOU, LABELS),
    ).toBeUndefined();
  });
});
