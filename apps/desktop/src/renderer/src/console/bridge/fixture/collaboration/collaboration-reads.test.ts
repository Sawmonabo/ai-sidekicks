// The eight collaboration answers: that each is reachable, and that each refuses.
//
// The sweep next door proves every one of them refuses under a scenario that scripts
// nothing. What it cannot prove is the other half — that a handler answers AT ALL —
// and without that half the whole set could be right for the wrong reason: eight arms
// that refuse under every scenario there is, taking the correct refusal from a
// handler that never answers. So each read and each write is driven here against the
// room that scripts it.

import { describe, expect, it } from "vitest";

import type { DaemonMethod } from "@ai-sidekicks/contracts";

import { createFixtureBridge } from "../call-plane/bridge.js";
import { COLLABORATION_SCENARIO } from "../../scenarios/collaboration.js";
import { FLAGSHIP_SCENARIO } from "../../scenarios/flagship.js";
import type { ConsoleBridge } from "../../console-bridge.js";

/** The room that scripts them, and the session every call is scoped to. */
function collaborationPort(): ReturnType<typeof createFixtureBridge>["growth"] {
  return createFixtureBridge({ scenario: COLLABORATION_SCENARIO }).growth;
}

const SESSION = { sessionId: COLLABORATION_SCENARIO.sessionId };

/** Past every beat this room plays, so an advance leaves no presence move undue. */
const PAST_EVERY_BEAT_MS = 10_000;

/**
 * The whole bridge over this room, for the two answers that move on the clock.
 *
 * `collaborationPort` above hands back the growth port alone, which is right for the
 * six answers that are facts about the session and wrong for the presence detail: that
 * card is the detail behind a roster row the scenario MOVES, so a case about it has to
 * drive the frozen clock and read the roster row beside it.
 */
function collaborationRoom(): {
  readonly bridge: ConsoleBridge;
  readonly advance: (ms: number) => void;
} {
  const bridge = createFixtureBridge({ scenario: COLLABORATION_SCENARIO });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture built no engine, so there is nothing to drive");
  }
  return {
    bridge,
    advance: (ms: number) => {
      engine.advance(ms);
    },
  };
}

/** What the ROSTER read says about one person right now, through the real call door. */
async function rosterStateOf(bridge: ConsoleBridge, participantId: string): Promise<unknown> {
  const reply = await bridge.sidekicks.daemon.call("presence.read" as DaemonMethod, SESSION);
  const { participants } = reply as {
    readonly participants: readonly { participantId: string; state: string }[];
  };
  return participants.find((row) => row.participantId === participantId)?.state;
}

/** The detail card for one person right now, or a failure naming the refusal. */
async function presenceCardFor(
  bridge: ConsoleBridge,
  participantId: string,
): Promise<{ readonly aggregateState: string; readonly devices: readonly unknown[] }> {
  const outcome = await bridge.growth.participantPresenceDetailRead({ ...SESSION, participantId });
  if (outcome.status !== "served") {
    throw new Error(`the room refused the presence detail for ${participantId}`);
  }
  return outcome.value;
}

describe("the fixture's collaboration answers", () => {
  it("reads every channel's kind, pair, and audience, and names the main channel in none of them", async () => {
    const outcome = await collaborationPort().channelRosterRead(SESSION);

    expect(outcome.status).toBe("served");
    if (outcome.status !== "served") {
      return;
    }
    // The direct row is the one the badge and the pair label both need, and it is the
    // row a list built only from `channel.list` could never draw: no name, a kind, and
    // exactly two humans.
    const direct = outcome.value.find((entry) => entry.kind === "direct");
    expect(direct?.name).toBeUndefined();
    expect(direct?.memberPair).toHaveLength(2);
    expect(direct?.config.audience).toBe("humans-only");
    // One channel this session's agents read, and one they never do — so a badge that
    // rendered one value for every row would be visibly wrong against this script.
    expect(outcome.value.map((entry) => entry.config.audience)).toContain("participants");
    // The bootstrap channel has no channel row at all, so the roster names none.
    expect(outcome.value.map((entry) => entry.name)).not.toContain("main");
  });

  it("names a membership for every person in the room, the opener included", async () => {
    const outcome = await collaborationPort().membershipRosterRead(SESSION);

    expect(outcome.status).toBe("served");
    if (outcome.status !== "served") {
      return;
    }
    expect(outcome.value.map((row) => row.participantId)).toStrictEqual(
      COLLABORATION_SCENARIO.participantIdsInJoinOrder,
    );
    // The claim that matters: the opener's row carries an identifier even though no
    // `membership.created` beat announces them, so the owner's controls are reachable.
    const opener = outcome.value.find(
      (row) => row.participantId === COLLABORATION_SCENARIO.viewingParticipantId,
    );
    expect(opener?.membershipId).toBeDefined();
    expect(new Set(outcome.value.map((row) => row.membershipId)).size).toBe(outcome.value.length);
  });

  it("answers presence detail per participant, and agrees with the aggregate on each", async () => {
    // Read PAST every beat, because the aggregate this card carries is the roster
    // row's and that row moves on the clock: the empty-device state is what this room
    // reaches by PLAYING its last presence beat, not what it opens with.
    const { bridge, advance } = collaborationRoom();
    const [firstParticipantId = ""] = COLLABORATION_SCENARIO.participantIdsInJoinOrder;
    const lastParticipantId = COLLABORATION_SCENARIO.participantIdsInJoinOrder.at(-1) ?? "";

    advance(PAST_EVERY_BEAT_MS);
    const first = await presenceCardFor(bridge, firstParticipantId);
    const last = await presenceCardFor(bridge, lastParticipantId);

    // Two different answers to two different questions — the defect a reply keyed on
    // the method alone produces is one answer to both.
    expect(firstParticipantId).not.toBe(lastParticipantId);
    // The offline member is on no device, which is the empty state a card that only
    // ever listed rows would never draw.
    expect(last.aggregateState).toBe("offline");
    expect(last.devices).toStrictEqual([]);
    expect(first.devices.length).toBeGreaterThan(0);
    // And the card is the detail BEHIND the roster row rather than a second answer to
    // it, which is checkable only against the row itself.
    expect(last.aggregateState).toBe(await rosterStateOf(bridge, lastParticipantId));
    expect(first.aggregateState).toBe(await rosterStateOf(bridge, firstParticipantId));
  });

  it("answers that same card differently before the beat that moves the row", async () => {
    // The foil for the case above, and the defect it was written for: the card was
    // built from the roster TABLE, so it reported this person offline on no device
    // from tick zero — while the roster row beside it, which answers the moves that
    // are DUE, drew them as here. A card and a row disagreeing about one person is the
    // one thing the detail read must never do, and it did it for the first 420ms of
    // every window. Both halves are asserted: the card reads the OPENING state, and it
    // still agrees with the row.
    const { bridge } = collaborationRoom();
    const lastParticipantId = COLLABORATION_SCENARIO.participantIdsInJoinOrder.at(-1) ?? "";

    const atStart = await presenceCardFor(bridge, lastParticipantId);

    expect(atStart.aggregateState).toBe("online");
    expect(atStart.devices).toStrictEqual([
      { deviceId: `${lastParticipantId}:desk`, state: "online", lastSeen: expect.any(String) },
    ]);
    expect(atStart.aggregateState).toBe(await rosterStateOf(bridge, lastParticipantId));
  });

  it("refuses a presence detail for somebody this room does not hold", async () => {
    // The `resultFor` arm's own refusal: a request naming a person no scenario states
    // settles unanswered rather than borrowing another person's devices.
    const outcome = await collaborationPort().participantPresenceDetailRead({
      ...SESSION,
      participantId: "019b7904-8ce0-79a4-8190-cca0117a0399",
    });

    expect(outcome.status).toBe("unavailable");
  });

  it("answers each lifecycle write about the channel it was asked about", async () => {
    const port = collaborationPort();
    const channelId = "019b7904-8ce0-7c11-8120-cca0117a0390";

    const muted = await port.channelMute({ channelId });
    const unmuted = await port.channelUnmute({ channelId });
    const archived = await port.channelArchive({ channelId });
    const created = await port.channelCreate({ ...SESSION, name: "design" });

    expect(muted.status === "served" ? muted.value : undefined).toStrictEqual({
      channelId,
      state: "muted",
    });
    expect(unmuted.status === "served" ? unmuted.value.state : undefined).toBe("active");
    expect(archived.status === "served" ? archived.value.state : undefined).toBe("archived");
    expect(created.status === "served" ? created.value.channelId : undefined).toBeDefined();
  });

  it("names the lease holder, who is somebody other than the person reading", async () => {
    // The reading a person cannot get any other way. A room whose viewer always held
    // the lease would never draw the row this mark exists for, so the script names
    // somebody else — and `controlHolder` is a wire field rather than a fold over
    // whichever transition the room happened to end on.
    const outcome = await collaborationPort().terminalControlHolderRead(SESSION);

    expect(outcome.status).toBe("served");
    if (outcome.status !== "served") {
      return;
    }
    expect(typeof outcome.value.controlHolder).toBe("string");
    expect(outcome.value.controlHolder).not.toBe(COLLABORATION_SCENARIO.viewingParticipantId);
  });

  it("refuses every session-scoped answer addressed to a session this room is not playing", async () => {
    // The five that carry a session, asked about ANOTHER one while this room's script
    // answers them all. Served, an experiment would read one session's channels,
    // people, devices and lease under a session that owns none of them — and a
    // subject-scoping regression on any surface above would look exactly like this
    // room working.
    const port = collaborationPort();
    const elsewhere = { sessionId: FLAGSHIP_SCENARIO.sessionId };
    const [participantId] = COLLABORATION_SCENARIO.participantIdsInJoinOrder;

    for (const outcome of [
      await port.channelRosterRead(elsewhere),
      await port.membershipRosterRead(elsewhere),
      // A person this room DOES hold, so the session is the only thing refusing.
      await port.participantPresenceDetailRead({
        ...elsewhere,
        participantId: participantId ?? "",
      }),
      await port.terminalControlHolderRead(elsewhere),
      await port.channelCreate({ ...elsewhere, name: "design" }),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        // The SCENARIO's gap, exactly as an unscripted call takes: this build serves
        // all five, so `wire-unregistered` would name a document owing a wire that
        // already has a stand-in.
        expect(outcome.code).toBe("reply-unscripted");
      }
    }
  });

  it("negative control: every one of them refuses for a room that scripts none", async () => {
    // Without this the seven cases above would hold over a fixture that served these
    // answers to every scenario, which is the fabrication the script-only rule exists
    // to prevent: an audience badge on a session whose channels nobody asked about,
    // or a free lease on a session nobody asked about the terminal in.
    const port = createFixtureBridge({ scenario: FLAGSHIP_SCENARIO }).growth;
    const session = { sessionId: FLAGSHIP_SCENARIO.sessionId };

    for (const outcome of [
      await port.channelRosterRead(session),
      await port.membershipRosterRead(session),
      await port.participantPresenceDetailRead({ ...session, participantId: "nobody" }),
      await port.channelMute({ channelId: "no-channel" }),
      await port.channelUnmute({ channelId: "no-channel" }),
      await port.channelArchive({ channelId: "no-channel" }),
      await port.channelCreate({ ...session, name: "design" }),
      await port.terminalControlHolderRead(session),
    ]) {
      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        // The SCENARIO's gap and never an unbuilt wire: this build carries a stand-in
        // for all eight, so `wire-unregistered` would send a reader to a document that
        // owes a wire the fixture already answers.
        expect(outcome.code).toBe("reply-unscripted");
      }
    }
  });
});
