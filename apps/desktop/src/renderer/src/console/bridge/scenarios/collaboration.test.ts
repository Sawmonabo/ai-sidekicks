// What this scenario has to keep being, for the surfaces built on it.
//
// The wire-truth predicate already holds every beat to the census and the strict
// layer, and the architecture tier runs it over every shipped scenario — so nothing
// here re-checks that. What is checked is the DESIGN content that makes this
// scenario worth having: four presence states, an archived channel, and one
// invitation that is still pending. Each of those is a claim a surface was built
// against, and each would go silently false under an edit that still parsed.

import { describe, expect, it } from "vitest";

import type { DaemonEvent, DaemonMethod, EventEnvelope } from "@ai-sidekicks/contracts";

import { parseInstant } from "../../core/index.js";
import { projectMembershipCreated } from "../../collaboration/members/membership-projector.js";
import { PRESENCE_STATE_RENDER_ORDER } from "../../collaboration/members/presence-model.js";
import { createFixtureBridge } from "../fixture/fixture-bridge.js";
import { readConsoleSessionEvent } from "../daemon/session-event-payload.js";
import { SESSION_EVENT_STREAM } from "../daemon/session-event-streams.js";
import { collaborationSentInvitesAt } from "./collaboration/replies.js";
import { COLLABORATION_SCENARIO } from "./collaboration.js";
import { CHANNEL_HANDOFF, PARTICIPANT_YOU } from "./collaboration/identifiers.js";
import type { ConsoleBridge } from "../console-bridge.js";
import type { ScenarioReply, ScenarioResolvingReply } from "../scenario-runtime/scenario.js";

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

/** What `channel.list` reports for one channel through the real call door. */
async function channelStateOf(bridge: ConsoleBridge, channelId: string): Promise<unknown> {
  const reply = await bridge.sidekicks.daemon.call("channel.list" as DaemonMethod, {
    sessionId: COLLABORATION_SCENARIO.sessionId,
  });
  const { channels } = reply as { readonly channels: readonly { id: string; state: unknown }[] };
  return channels.find((channel) => channel.id === channelId)?.state;
}

/** The resolving reply for one call, or a failure naming the call that is missing. */
function resolvingReplyFor(call: string): ScenarioResolvingReply {
  const reply: ScenarioReply | undefined = COLLABORATION_SCENARIO.replies.find(
    (candidate) => candidate.call === call,
  );
  expect(reply, `the scenario scripts no "${call}" reply`).toBeDefined();
  const resolving = reply as ScenarioResolvingReply;
  expect(resolving.result, `"${call}" refuses rather than resolving`).toBeDefined();
  return resolving;
}

describe("the collaboration scenario", () => {
  it("covers every presence state the roster renders", () => {
    const { participants } = resolvingReplyFor("presence.read").result as {
      participants: readonly { state: string }[];
    };
    const covered = new Set(participants.map((participant) => participant.state));
    expect([...covered].sort()).toStrictEqual([...PRESENCE_STATE_RENDER_ORDER].sort());
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
    // envelope into the record a projector reads. A case that hand-built that record
    // would pass over the seam where a fixture teaching the wrong shape shows up.
    const decoded = owner === undefined ? undefined : readConsoleSessionEvent(owner);
    const projected = decoded === undefined ? [] : projectMembershipCreated(decoded);

    const [upsert] = projected;
    expect(admissions).toHaveLength(COLLABORATION_SCENARIO.participantIdsInJoinOrder.length);
    expect(upsert?.operation).toBe("upsert");
    expect(upsert?.operation === "upsert" ? upsert.entity.body?.["name"] : undefined).toBe(
      "sawyer",
    );
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
    // Through the ledger's own ageing function at the scenario's start instant,
    // because the reply is COMPUTED: it answers what the ledger holds at the moment
    // it settles, and tick zero is the moment this design claim is about. The
    // ageing itself is `collaboration/replies.test.ts`.
    const startMilliseconds = parseInstant(COLLABORATION_SCENARIO.startedAtIso).epochMilliseconds;
    expect(startMilliseconds).toBeDefined();
    const invites = collaborationSentInvitesAt(startMilliseconds ?? 0);
    const pending = invites.filter((invite) => invite.state === "pending");
    expect(pending).toHaveLength(1);
    const [onlyPendingInvite] = pending;
    expect(onlyPendingInvite).toBeDefined();
    // Through the console's own reader rather than a `NaN` check: that check passes
    // for a day that does not exist, which normalizes into the next one instead of
    // refusing, so it never asserted what this line claims.
    expect(parseInstant(onlyPendingInvite?.expiresAt ?? "").kind).toBe("instant");
  });

  it("scripts no reply for a call it does not make", () => {
    // The negative control for every assertion above: `resolvingReplyFor` reports a
    // missing call rather than returning a reply that happens to be `undefined`, so
    // a scenario that quietly lost `presence.read` would fail those tests instead of
    // vacuously passing them.
    expect(() => resolvingReplyFor("presence.detail")).toThrow();
  });
});
