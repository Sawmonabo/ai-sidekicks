// What the fixture answers for the channel plane, and the one session-scoped fact the
// console renders beside it.
//
// A module of its own rather than a block inside `growth/growth-port.ts`, on
// `workflows/workflow-reads.ts`'s rule: these six operations share one disposition
// and one reason for it, and the port would carry both twice over if they lived inline.
//
// EVERY ONE OF THEM REFUSES WHERE THE SCENARIO SCRIPTS NOTHING, and that is the
// finding rather than an omission. The served set's own rule admits an empty answer
// only where "there is none" is a state a session can really be in, and none of these
// six is:
//
//   • The PRESENCE DETAIL is addressed by a SUBJECT. "This user is on no
//     device" is a claim about a named person, and inventing it for a person nobody
//     asked after is the invention the script-only rule exists to stop — the more so
//     because the aggregate beside it says they are online.
//   • The FOUR LIFECYCLE VERBS are writes. There is no such thing as the archival
//     that happened and produced nothing.
//   • The TERMINAL-CONTROL HOLDER is the closest call of the six, because `null` is
//     a value the registered member really takes — nobody holds the lease, or the
//     holding node reads offline. It is still not the unscripted answer: `null` is a
//     CLAIM that the lease is free, the surface is required to draw that state
//     distinctly from every other, and a fixture that made it the default would put
//     the claim on screen in every scenario that never mentioned the terminal.
//
// So all six are declared script-only in `call-plane/script-only-operations.ts`,
// and the sweep in
// `growth/growth-port.test.ts` holds each to the `reply-unscripted` refusal rather
// than to the `wire-unregistered` one a build with no stand-in would take.
//
// AND EVERY ONE OF THEM THAT CARRIES A SESSION IS SCOPED TO THE ONE BEING PLAYED
// before its script is consulted at all. That is three of the six; `namesPlayedSession`
// below states the guard and why it is one guard rather than three.
//
// AND ALL FOUR WRITES DO A SECOND THING, which is why they are the one group here that
// is not a bare call to the scripted-write seam. A served create, mute, unmute or
// archive puts its own `channel.*` frame on the session stream, because against a
// daemon the receipt and the event are two halves of one act and a fixture carrying
// only the first leaves the directory's re-read path reachable from nothing but an
// authored beat. `channel-lifecycle.ts` owns that half and states it in full.

import { CHANNEL_CREATE_CALL, FixtureChannelLifecycle } from "./channel-lifecycle.js";
import { answerFromScriptedReply } from "../growth/scripted-answer.js";
import {
  growthUnscriptedReply,
  type GrowthOutcome,
  type GrowthPort,
} from "../../growth-port/index.js";
import type { GrowthOperationSignatures } from "../../growth-signatures/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

/**
 * The operations this module implements, declared once and consumed twice.
 *
 * `call-plane/served-operations.ts` spreads the tuple into the served set and the `Pick`
 * below is keyed on the same names, so an operation implemented here and left out of
 * the set — or named in the set and never implemented — is a compile error.
 */
export const FIXTURE_SERVED_CHANNEL_OPERATION_IDS: readonly [
  "channelCreate",
  "channelMute",
  "channelUnmute",
  "channelArchive",
  "userPresenceDetailRead",
  "terminalControlHolderRead",
] = [
  "channelCreate",
  "channelMute",
  "channelUnmute",
  "channelArchive",
  "userPresenceDetailRead",
  "terminalControlHolderRead",
];

/** One operation this module answers. Derived, so the set has exactly one home. */
export type FixtureServedChannelOperationId = (typeof FIXTURE_SERVED_CHANNEL_OPERATION_IDS)[number];

/**
 * How the terminal-control holder read is keyed in a script.
 *
 * The one operation here whose slate row declares NO expected wire method: the holder
 * is a MEMBER of the runtime-node roster reply rather than a read of its own, so there
 * is no method string to key on even though the member itself is registered, and
 * `bridge/scenario/wire-truth/reply-walk.ts` requires its reply to be keyed on the
 * operation id under the `growth:` prefix instead. Named here, where both the handler
 * and the scenario that answers it can take it from one place instead of spelling the
 * prefix twice.
 */
export const TERMINAL_CONTROL_HOLDER_READ_CALL = "growth:terminalControlHolderRead";

/**
 * The channel and presence answers for one running scenario.
 *
 * The lifecycle is HANDED IN rather than built here, because the same instance answers
 * two doors: these four acts, and the `channel.list` fold that reads the channels each
 * create recorded. A second instance would be a second fixture answering for one
 * session's channels, and the fold's rows would name counts no act had produced.
 */
export function fixtureChannelReads(
  engine: ScenarioEngine,
  channelLifecycle: FixtureChannelLifecycle,
): Pick<GrowthPort, FixtureServedChannelOperationId> {
  return {
    // The CREATE is scoped here and answered there. The scoping is this module's
    // because it is the same guard the two reads take; the act — the receipt, and the
    // `channel.created` frame that tells the session about it — belongs beside the
    // three moves, which is also what keeps the guard out of a module this one
    // imports.
    channelCreate: async (request) =>
      namesPlayedSession(engine, request)
        ? await channelLifecycle.createChannel(request)
        : growthUnscriptedReply("channelCreate", CHANNEL_CREATE_CALL),
    // The three lifecycle MOVES answer the same way the create above does and then put
    // the transition on the session's own stream, which is the half that makes the
    // directory's re-read reachable at all under the fixture. Their reasoning is
    // `channel-lifecycle.ts`'s, and it holds one identifier line across the
    // three, so they arrive here as an object rather than as three closures.
    ...channelLifecycle.operations(),
    userPresenceDetailRead: async (request) =>
      await answerSessionScopedRead(
        engine,
        "user.presenceDetail",
        "userPresenceDetailRead",
        request,
      ),
    terminalControlHolderRead: async (request) =>
      await answerSessionScopedRead(
        engine,
        TERMINAL_CONTROL_HOLDER_READ_CALL,
        "terminalControlHolderRead",
        request,
      ),
  };
}

/**
 * Whether a request names the session this scenario is playing.
 *
 * ONE GUARD FOR THE THREE ANSWERS THAT CARRY A SESSION, and the reason it is one rather
 * than three is that the mistake it prevents is one mistake. `answerFromScriptedReply`
 * validates nothing about the request — a scripted reply that is flat is served to
 * whoever asks — so every handler here answered for ANY session id, and an experiment
 * addressed to one session could read another's devices and lease, or create a channel
 * in it. Worse than the fabrication itself: a subject-scoping
 * regression on any surface above would look identical to the fixture working, because
 * the wrong session still got a full answer.
 *
 * The three lifecycle MOVES take no guard and that is the registered shape rather than
 * an omission: `GrowthChannelLifecycleRequest` is `{channelId}` and names no session,
 * so there is nothing here to check them against.
 *
 * `callerUserRead` next door already reads its request this way, and the
 * REFUSAL is the one difference between the two. That read's wire is unregistered on
 * this build, so it takes the unregistered refusal the live bridge takes; these six
 * are SERVED, so a wrong-session request takes the scenario's own `reply-unscripted` —
 * this room scripts no answer about that session, and naming an unregistered wire
 * would send a reader to a document owing something the fixture already stands in for.
 */
function namesPlayedSession(
  engine: ScenarioEngine,
  request: { readonly sessionId: string },
): boolean {
  return request.sessionId === engine.scenario.sessionId;
}

/**
 * One session-scoped READ: scoped, then answered from the script, then refused by name.
 *
 * The two reads differ only in which call they consult and which operation they
 * answer for, so they compose here rather than twice over — and the guard, the
 * scripted seam and the unscripted refusal stay in one order that no handler can get
 * half right.
 */
async function answerSessionScopedRead<TOperationId extends FixtureServedChannelOperationId>(
  engine: ScenarioEngine,
  call: string,
  operationId: TOperationId,
  request: { readonly sessionId: string },
): Promise<GrowthOutcome<GrowthOperationSignatures[TOperationId]["value"]>> {
  if (!namesPlayedSession(engine, request)) {
    return growthUnscriptedReply(operationId, call);
  }
  return await answerFromScriptedReply(engine, call, operationId, request, () =>
    growthUnscriptedReply(operationId, call),
  );
}
