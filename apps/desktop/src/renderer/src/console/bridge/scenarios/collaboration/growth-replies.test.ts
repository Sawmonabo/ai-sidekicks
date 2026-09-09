// What this room answers a lifecycle move with, and which channels it will answer for.
//
// THE DEFECT THESE CASES EXIST FOR. The three receipts read `channelId` off the request
// and echoed it back, so ANY string was answered with a served receipt — including one
// this room's directory has never contained. `fixture/collaboration/channel-lifecycle.ts` then
// appended the matching `channel.*` frame, because a served act publishes; the fold in
// `fixture/collaboration/channel-directory.ts` grew a row for it; and the surface that had
// muted a channel by a stale identifier, or by one composed from the wrong row, was
// answered exactly as a correct press is. The regression a fixture exists to make
// reachable was the one it made invisible.
//
// DRIVEN THROUGH THE REAL SEAM. A computed reply refuses by throwing, and what that
// means to a caller is decided by the scripted-reply settlement and the growth port
// behind it — so these cases press the bridge's own `growth.channel*` operations and read
// what a surface would receive, rather than calling the reply table's function.

import { describe, expect, it } from "vitest";

import { SESSION_EVENT_STREAM } from "../../daemon/session-event-streams.js";
import { CHANNEL_DIRECT, CHANNEL_HANDOFF, CHANNEL_MAIN, CHANNEL_REVIEW } from "./identifiers.js";
import { COLLABORATION_SCENARIO } from "../collaboration.js";
import {
  createFixture,
  subscribeThroughBridge,
  type FixtureUnderTest,
} from "../../fixture/call-plane/bridge.test-support.js";
import type { EventEnvelope } from "@ai-sidekicks/contracts";

/** A channel identifier no reply and no beat of this room's ever names. */
const CHANNEL_THIS_ROOM_HAS_NEVER_HELD = "019b7904-8ce0-7c11-8188-cca0117a0777";

/** The refusal the corpus registers for a channel that is not in the session. */
const CHANNEL_NOT_FOUND = "channel.not_found";

/** The room, with a feed already attached so a published transition is observable. */
function room(): { readonly fixture: FixtureUnderTest; readonly frames: readonly EventEnvelope[] } {
  const fixture = createFixture(COLLABORATION_SCENARIO);
  return { fixture, frames: subscribeThroughBridge(fixture, SESSION_EVENT_STREAM) };
}

/** The code one rejected lifecycle move refused under. */
async function refusalCodeOf(move: Promise<unknown>): Promise<unknown> {
  try {
    await move;
  } catch (rejection) {
    return (rejection as { readonly code?: unknown }).code;
  }
  return undefined;
}

describe("the collaboration room's lifecycle receipts", () => {
  it("refuses a move against a channel this room's directory has never held", async () => {
    const { fixture, frames } = room();

    const code = await refusalCodeOf(
      fixture.bridge.growth.channelMute({ channelId: CHANNEL_THIS_ROOM_HAS_NEVER_HELD }),
    );

    expect(code).toBe(CHANNEL_NOT_FOUND);
    // The second half, and the reason the receipt could not simply answer `undefined`:
    // a served act publishes, so an echoed receipt put a transition for that channel on
    // the session's own stream and every reader of the room saw a row move.
    expect(frames).toHaveLength(0);
  });

  it("refuses an unknown channel on each of the three moves, not only the first", async () => {
    // One resolution serves all three, and a fixture that guarded one of them would
    // leave the other two answering for a channel nobody has.
    const { fixture } = room();

    for (const move of [
      fixture.bridge.growth.channelMute({ channelId: CHANNEL_THIS_ROOM_HAS_NEVER_HELD }),
      fixture.bridge.growth.channelUnmute({ channelId: CHANNEL_THIS_ROOM_HAS_NEVER_HELD }),
      fixture.bridge.growth.channelArchive({ channelId: CHANNEL_THIS_ROOM_HAS_NEVER_HELD }),
    ]) {
      expect(await refusalCodeOf(move)).toBe(CHANNEL_NOT_FOUND);
    }
  });

  it("serves every channel the directory opens with, the bootstrap row included", async () => {
    // The control that keeps the guard from being a refusal of everything. The bootstrap
    // channel is deliberately absent from the roster read this same script answers — it
    // has no channel row and no configuration — and it is still a channel this session
    // holds, so a resolution built from the roster's three ids would refuse a press on it.
    const { fixture } = room();

    for (const channelId of [CHANNEL_MAIN, CHANNEL_REVIEW, CHANNEL_HANDOFF, CHANNEL_DIRECT]) {
      const outcome = await fixture.bridge.growth.channelMute({ channelId });
      expect(outcome.status === "served" ? outcome.value : undefined).toStrictEqual({
        channelId,
        state: "muted",
      });
    }
  });

  it("serves a move against the channel this room's own create minted", async () => {
    // A channel that reaches the directory only through a delivered frame: the scripted
    // reply carries no row for it, the create mints it, and the fold appends it. A
    // resolution built from the opening table alone would refuse the press a person makes
    // on the row they have just created.
    const { fixture, frames } = room();
    const created = await fixture.bridge.growth.channelCreate({
      sessionId: COLLABORATION_SCENARIO.sessionId,
      name: "handover",
    });
    const createdChannelId = created.status === "served" ? created.value.channelId : "";

    const outcome = await fixture.bridge.growth.channelArchive({ channelId: createdChannelId });

    expect(outcome.status).toBe("served");
    expect(frames.map((frame) => frame.type)).toStrictEqual([
      "channel.created",
      "channel.archived",
    ]);
  });

  it("negative control: a request carrying no channel identifier is unscripted, not refused", async () => {
    // The two are different facts and the fixture keeps them apart. A malformed request
    // is an authoring gap — this scenario scripts no answer for it — and settles as an
    // unscripted call does; a well-formed one naming a channel the room does not hold is
    // a DAEMON refusal a surface has to render. Without this case the resolution could
    // have collapsed both into `channel.not_found` and looked correct.
    const { fixture } = room();

    const outcome = await fixture.bridge.growth.channelMute({
      channelId: undefined as unknown as string,
    });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" ? outcome.code : undefined).toBe("reply-unscripted");
  });

  it("negative control: a room that scripts no lifecycle reply refuses before resolving", async () => {
    // Without this the cases above would hold over a fixture that had started answering
    // for every scenario. The flagship room scripts none of the three, so the press meets
    // the scenario's own gap rather than this room's directory.
    const elsewhere = createFixture();

    const outcome = await elsewhere.bridge.growth.channelMute({ channelId: CHANNEL_REVIEW });

    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" ? outcome.code : undefined).toBe("reply-unscripted");
  });
});
