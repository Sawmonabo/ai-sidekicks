// What the fixture answers for the channel plane, the membership plane, and the one
// session-scoped fact the roster renders beside them.
//
// One module beside `fixture-growth-port.ts` on `fixture-workflow-reads.ts`'s rule:
// these eight operations share one disposition and one reason for it, and the port
// next door would carry both twice over if they lived inline.
//
// EVERY ONE OF THEM REFUSES WHERE THE SCENARIO SCRIPTS NOTHING, and that is the
// finding rather than an omission. The served set's own rule admits an empty answer
// only where "there is none" is a state a session can really be in, and none of these
// eight is:
//
//   • The CHANNEL ROSTER is not the directory. Every session has at least the
//     bootstrap channel — `channel.list` serves it from the session's own membership
//     count — so an empty roster would assert that a caller may see no channel at
//     all, which contradicts the reply the surface reads beside it. A row this read
//     did not name is a channel whose audience nobody asked after, and the directory
//     draws exactly that: the row, without a badge.
//   • The MEMBERSHIP ROSTER is the same claim about people. A session always has the
//     membership that admitted its own opener, so a reply naming none is not an empty
//     session but an unasked question, and the ledger renders the controls that need
//     an identifier as unreachable rather than as forbidden.
//   • The PRESENCE DETAIL is addressed by a SUBJECT. "This participant is on no
//     device" is a claim about a named person, and inventing it for a person nobody
//     asked after is the invention the script-only rule exists to stop — the more so
//     because the aggregate beside it says they are online.
//   • The FOUR LIFECYCLE VERBS are writes. There is no such thing as the archival
//     that happened and produced nothing.
//   • The TERMINAL-CONTROL HOLDER is the closest call of the eight, because `null` is
//     a value the registered member really takes — nobody holds the lease, or the
//     holding node reads offline. It is still not the unscripted answer: `null` is a
//     CLAIM that the lease is free, the surface is required to draw that state
//     distinctly from every other, and a fixture that made it the default would put
//     the claim on screen in every scenario that never mentioned the terminal.
//
// So all seven are declared script-only next door, and the sweep in
// `fixture-growth-port.test.ts` holds each to the `reply-unscripted` refusal rather
// than to the `wire-unregistered` one a build with no stand-in would take.

import { answerFromScriptedReply } from "./fixture-scripted-answer.js";
import { answerScriptedWrite } from "./fixture-scripted-write.js";
import { growthUnscriptedReply, type GrowthPort } from "../growth-port/index.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

/**
 * The operations this module implements, declared once and consumed twice.
 *
 * `fixture-served-operations.ts` spreads the tuple into the served set and the `Pick`
 * below is keyed on the same names, so an operation implemented here and left out of
 * the set — or named in the set and never implemented — is a compile error.
 */
export const FIXTURE_SERVED_COLLABORATION_OPERATION_IDS: readonly [
  "channelRosterRead",
  "channelCreate",
  "channelMute",
  "channelUnmute",
  "channelArchive",
  "membershipRosterRead",
  "participantPresenceDetailRead",
  "terminalControlHolderRead",
] = [
  "channelRosterRead",
  "channelCreate",
  "channelMute",
  "channelUnmute",
  "channelArchive",
  "membershipRosterRead",
  "participantPresenceDetailRead",
  "terminalControlHolderRead",
];

/** One operation this module answers. Derived, so the set has exactly one home. */
export type FixtureServedCollaborationOperationId =
  (typeof FIXTURE_SERVED_COLLABORATION_OPERATION_IDS)[number];

/**
 * How the membership roster read is keyed in a script.
 *
 * The one operation of the seven whose slate row declares NO expected wire method —
 * the corpus registers a membership identifier on four write-shaped replies and on no
 * read — so `wire-truth/reply-walk.ts` requires its reply to be keyed on the operation
 * id under the `growth:` prefix rather than on a method name nobody has registered.
 * Named here, where both the handler and the scenario that answers it can take it from
 * one place instead of spelling the prefix twice.
 */
export const MEMBERSHIP_ROSTER_READ_CALL = "growth:membershipRosterRead";

/**
 * How the terminal-control holder read is keyed in a script.
 *
 * The second of the two whose slate row declares no expected wire method, and for a
 * different reason: the holder is a MEMBER of the runtime-node roster reply rather
 * than a read of its own, so there is no method string to key on even though the
 * member itself is registered.
 */
export const TERMINAL_CONTROL_HOLDER_READ_CALL = "growth:terminalControlHolderRead";

/** The channel and membership answers for one running scenario. */
export function fixtureCollaborationReads(
  engine: ScenarioEngine,
): Pick<GrowthPort, FixtureServedCollaborationOperationId> {
  return {
    // The three facts `channel.list` has never carried, per channel the caller may
    // see. The REQUEST travels with the call as it does for every entity-scoped read
    // here: this one is session-scoped, and a scenario answering it still reads which
    // session was asked about rather than answering every session with one roster.
    channelRosterRead: async (request) =>
      answerFromScriptedReply(engine, "channel.rosterRead", "channelRosterRead", request, () =>
        growthUnscriptedReply("channelRosterRead", "channel.rosterRead"),
      ),
    channelCreate: async (request) =>
      await answerScriptedWrite(engine, "channel.create", "channelCreate", request),
    channelMute: async (request) =>
      await answerScriptedWrite(engine, "channel.mute", "channelMute", request),
    channelUnmute: async (request) =>
      await answerScriptedWrite(engine, "channel.unmute", "channelUnmute", request),
    channelArchive: async (request) =>
      await answerScriptedWrite(engine, "channel.archive", "channelArchive", request),
    membershipRosterRead: async (request) =>
      answerFromScriptedReply(
        engine,
        MEMBERSHIP_ROSTER_READ_CALL,
        "membershipRosterRead",
        request,
        () => growthUnscriptedReply("membershipRosterRead", MEMBERSHIP_ROSTER_READ_CALL),
      ),
    participantPresenceDetailRead: async (request) =>
      answerFromScriptedReply(
        engine,
        "participant.presenceDetail",
        "participantPresenceDetailRead",
        request,
        () => growthUnscriptedReply("participantPresenceDetailRead", "participant.presenceDetail"),
      ),
    terminalControlHolderRead: async (request) =>
      answerFromScriptedReply(
        engine,
        TERMINAL_CONTROL_HOLDER_READ_CALL,
        "terminalControlHolderRead",
        request,
        () => growthUnscriptedReply("terminalControlHolderRead", TERMINAL_CONTROL_HOLDER_READ_CALL),
      ),
  };
}
