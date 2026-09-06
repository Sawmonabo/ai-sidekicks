// The eight collaboration answers: that each is reachable, and that each refuses.
//
// The sweep next door proves every one of them refuses under a scenario that scripts
// nothing. What it cannot prove is the other half — that a handler answers AT ALL —
// and without that half the whole set could be right for the wrong reason: eight arms
// that refuse under every scenario there is, taking the correct refusal from a
// handler that never answers. So each read and each write is driven here against the
// room that scripts it.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "./fixture-bridge.js";
import { COLLABORATION_SCENARIO } from "../scenarios/collaboration.js";
import { FLAGSHIP_SCENARIO } from "../scenarios/flagship.js";

/** The room that scripts them, and the session every call is scoped to. */
function collaborationPort(): ReturnType<typeof createFixtureBridge>["growth"] {
  return createFixtureBridge({ scenario: COLLABORATION_SCENARIO }).growth;
}

const SESSION = { sessionId: COLLABORATION_SCENARIO.sessionId };

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
    const port = collaborationPort();
    const [firstParticipantId] = COLLABORATION_SCENARIO.participantIdsInJoinOrder;
    const lastParticipantId = COLLABORATION_SCENARIO.participantIdsInJoinOrder.at(-1);

    const first = await port.participantPresenceDetailRead({
      ...SESSION,
      participantId: firstParticipantId ?? "",
    });
    const last = await port.participantPresenceDetailRead({
      ...SESSION,
      participantId: lastParticipantId ?? "",
    });

    expect(first.status).toBe("served");
    expect(last.status).toBe("served");
    if (first.status !== "served" || last.status !== "served") {
      return;
    }
    // Two different answers to two different questions — the defect a reply keyed on
    // the method alone produces is one answer to both.
    expect(first.value.participantId).not.toBe(last.value.participantId);
    // The offline member is on no device, which is the empty state a card that only
    // ever listed rows would never draw.
    expect(last.value.aggregateState).toBe("offline");
    expect(last.value.devices).toStrictEqual([]);
    expect(first.value.devices.length).toBeGreaterThan(0);
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

  it("negative control: every one of them refuses for a room that scripts none", async () => {
    // Without this the six cases above would hold over a fixture that served these
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
