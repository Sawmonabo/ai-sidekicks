// What this scenario has to keep being, for the surfaces built on it.
//
// The wire-truth predicate already holds every beat to the census and the strict
// layer — so nothing here re-checks that. What is checked is the DESIGN content that
// makes this
// scenario worth having: four presence states, an archived channel, and one
// invitation that is still pending. Each of those is a claim a surface was built
// against, and each would go silently false under an edit that still parsed.

import { describe, expect, it } from "vitest";

import type {
  DaemonEvent,
  DaemonMethod,
  EventEnvelope,
  PresenceState,
} from "@ai-sidekicks/contracts";

import { parseInstant } from "../../../core/index.js";
import { createFixtureBridge } from "../../fixture/call-plane/bridge.js";
import { readConsoleSessionEvent } from "../../daemon/session-event-payload.js";
import { SESSION_EVENT_STREAM } from "../../daemon/session-event-streams.js";
import { COLLABORATION_SENT_INVITES } from "./replies.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import { CHANNEL_HANDOFF, PARTICIPANT_YOU } from "./identifiers.js";
import type { ConsoleBridge } from "../../console-bridge.js";

/**
 * The presence states the wire declares, exhaustive by construction.
 *
 * A `Record` keyed by the contract's own union rather than a list written out here:
 * a fifth state added to the wire fails this file to compile instead of leaving a
 * case that reads as though it covered every state while covering four of five.
 */
const WIRE_PRESENCE_STATES: Readonly<Record<PresenceState, true>> = {
  online: true,
  idle: true,
  reconnecting: true,
  offline: true,
};

/** Past every beat this room plays, so an advance leaves nothing due. */
const PAST_EVERY_BEAT_MS = 10_000;

/** Inside the room's opening, before the archival beat at 340ms. */
const BEFORE_THE_ARCHIVAL_MS = 100;

/** The real fixture over this room, driven exactly as a console window drives one. */
function room(): { readonly bridge: ConsoleBridge; readonly advance: (ms: number) => void } {
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

/** The presence state each person reads as, right now, through the real call door. */
async function presenceStatesFrom(bridge: ConsoleBridge): Promise<readonly string[]> {
  const reply = await bridge.sidekicks.daemon.call("presence.read" as DaemonMethod, {
    sessionId: COLLABORATION_SCENARIO.sessionId,
  });
  const { participants } = reply as { readonly participants: readonly { state: string }[] };
  return participants.map((participant) => participant.state);
}

/** What `channel.list` reports for one channel through the real call door. */
async function channelStateOf(bridge: ConsoleBridge, channelId: string): Promise<unknown> {
  const reply = await bridge.sidekicks.daemon.call("channel.list" as DaemonMethod, {
    sessionId: COLLABORATION_SCENARIO.sessionId,
  });
  const { channels } = reply as { readonly channels: readonly { id: string; state: unknown }[] };
  return channels.find((channel) => channel.id === channelId)?.state;
}

describe("the collaboration scenario", () => {
  it("covers every presence state the wire declares, once its moves have played", async () => {
    // Read PAST every beat, because the read is now a function of the clock: the four
    // states are what this room ENDS in, and a case that read at tick zero would be
    // asserting the room's opening — where everybody is `online` and three of the four
    // states are correctly unreachable. The transition itself is driven in
    // `collaboration/presence-timeline.test.ts`, which is where that schedule lives.
    //
    // Against the CONTRACT's closed four rather than a console module's copy of them:
    // the claim is about what this room plays, and the wire is what decides which
    // states there are to play.
    const { bridge, advance } = room();

    advance(PAST_EVERY_BEAT_MS);

    const covered = new Set(await presenceStatesFrom(bridge));
    expect([...covered].sort()).toStrictEqual(Object.keys(WIRE_PRESENCE_STATES).sort());
  });

  it("names a viewer the session actually joins", () => {
    const { viewingParticipantId, participantIdsInJoinOrder } = COLLABORATION_SCENARIO;
    expect(viewingParticipantId).toBeDefined();
    expect(participantIdsInJoinOrder).toContain(viewingParticipantId);
  });

  it("reaches an archived channel by PLAYING the archival, not by declaring it", async () => {
    // The directory's archived region and its live-to-archived transition are two
    // different renderings, and a table that simply declared the row archived reached
    // only the first — while every read before the beat exposed state the script had
    // not got to. Both readings come off one script now, which is what this asserts.
    const { bridge, advance } = room();

    advance(BEFORE_THE_ARCHIVAL_MS);
    const whileLive = await channelStateOf(bridge, CHANNEL_HANDOFF);
    advance(PAST_EVERY_BEAT_MS);

    expect(whileLive).toBe("active");
    expect(await channelStateOf(bridge, CHANNEL_HANDOFF)).toBe("archived");
  });

  it("admits its own opener with a membership beat carrying their handle", () => {
    // `session.create` emits the creator's `membership.created` immediately after
    // `session.created`, and this room used to skip it — so the fold that reads
    // `identityHandle` off that beat never saw the owner's, and every surface resolving
    // a participant label through the projection drew this room's owner as a raw UUID.
    // Driven through the real subscription door and the real projector: a case reading
    // the beat table would pass over a fixture that never delivered the frame.
    const { bridge, advance } = room();
    const delivered: EventEnvelope[] = [];
    bridge.sidekicks.daemon.subscribe(SESSION_EVENT_STREAM as DaemonEvent, (frame: unknown) => {
      delivered.push(frame as EventEnvelope);
    });

    advance(PAST_EVERY_BEAT_MS);
    const admissions = delivered.filter((frame) => frame.type === "membership.created");
    const owner = admissions.find((frame) => frame.payload["participantId"] === PARTICIPANT_YOU);
    // Through the console's own decode boundary, which is what turns the wire's
    // envelope into the record a reader takes the handle off. A case that hand-built
    // that record would pass over the seam where a fixture teaching the wrong shape
    // shows up.
    const decoded = owner === undefined ? undefined : readConsoleSessionEvent(owner);

    expect(admissions).toHaveLength(COLLABORATION_SCENARIO.participantIdsInJoinOrder.length);
    expect(decoded?.payload?.["identityHandle"]).toBe("sawyer");
  });

  it("negative control: nobody outside the roster is admitted by a beat this room plays", () => {
    // Without this, a projector that upserted a name for every frame — or a room that
    // admitted a stranger — would pass the case above. Every admission names somebody
    // the join order already carries.
    const { bridge, advance } = room();
    const delivered: EventEnvelope[] = [];
    bridge.sidekicks.daemon.subscribe(SESSION_EVENT_STREAM as DaemonEvent, (frame: unknown) => {
      delivered.push(frame as EventEnvelope);
    });

    advance(PAST_EVERY_BEAT_MS);

    for (const frame of delivered.filter((candidate) => candidate.type === "membership.created")) {
      expect(COLLABORATION_SCENARIO.participantIdsInJoinOrder).toContain(
        frame.payload["participantId"],
      );
    }
  });

  it("serves one pending invitation with an expiry", () => {
    // On the OPENING table, which is what this room states about its own ledger: the
    // rows are data and the lifecycle rule that moves them is the fixture ledger's, so
    // this case is about what the room declares and `collaboration/replies.test.ts`,
    // which drives the real seam, is about what a read answers with.
    const pending = COLLABORATION_SENT_INVITES.filter((invite) => invite.state === "pending");
    expect(pending).toHaveLength(1);
    const [onlyPendingInvite] = pending;
    expect(onlyPendingInvite).toBeDefined();
    // Through the console's own reader rather than a `NaN` check: that check passes
    // for a day that does not exist, which normalizes into the next one instead of
    // refusing, so it never asserted what this line claims.
    expect(parseInstant(onlyPendingInvite?.expiresAt ?? "").kind).toBe("instant");
  });

  it("negative control: the room OPENS with nobody moved, so the four states are earned", async () => {
    // Without this the presence case above passes over the defect it was written
    // against: a reply that answered each joiner's eventual state at every instant
    // covers all four the moment the window opens, and the advance that case performs
    // would be decorative. A room where nothing has happened yet has one state in it.
    const { bridge } = room();

    await expect(presenceStatesFrom(bridge)).resolves.toStrictEqual(
      COLLABORATION_SCENARIO.participantIdsInJoinOrder.map(() => "online"),
    );
  });
});
