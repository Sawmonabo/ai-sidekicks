// What every new-session suite needs before it can send anything.
//
// One home for the scaffolding both suites drive: the scripted replies each leg of the
// coalesced send parses, the scenario builder that decides WHICH legs a case scripts,
// and the two draft factories — the plain one, and the one that records what reached
// the wire. The suites split on what they assert (one send's ladder, and what repeated
// sends do); the scaffolding does not split with them, and a second copy is how two
// files come to script slightly different replies for one wire.

import { createFixtureBridge } from "../../bridge/index.js";
import {
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { NewSessionDraft } from "./new-session-draft.js";
// The methods the SEND names, taken from the module that sends them rather than
// re-declared here: a script keyed on the suite's own copy of a wire string would go
// on answering a call production had stopped making.
import { RUN_QUEUE_CREATE_METHOD, SESSION_CREATE_METHOD } from "./new-session-settlement.js";

export const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";

/**
 * The WHOLE registered create response.
 *
 * Whole, because the fixture bridge parses a scripted reply against the method's own
 * shape and refuses one that is short of it — a partial script would have been a
 * console tested against a reply the daemon cannot send. Named once, so the scenario
 * and the counted arm below settle on the same thing.
 */
const CREATE_REPLY = {
  sessionId: CREATED_SESSION_ID,
  state: "active",
  memberships: [],
  channels: [],
} as const;

/**
 * The registered queue reply, whole for `CREATE_REPLY`'s reason.
 *
 * The call door parses the response, so a short script would put the first-turn leg on
 * the refused arm and prove nothing about the turn having been queued.
 */
const QUEUE_REPLY = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
} as const;

/** The attach reply the growth port serves from a script. */
const ATTACH_REPLY = { agentId: "agent-1" } as const;

/** What a scenario scripts, so a case says which legs the daemon will answer. */
export interface ScriptedLegs {
  readonly scriptsCreate: boolean;
  readonly scriptsAttach?: boolean;
  readonly scriptsFirstTurn?: boolean;
}

function scenario(options: ScriptedLegs): ConsoleScenario {
  return {
    id: "draft-send",
    label: "Draft send",
    purpose: "Drives the new-session draft's three wire calls.",
    sessionId: "session-draft",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: [
      ...(options.scriptsCreate ? [{ call: SESSION_CREATE_METHOD, result: CREATE_REPLY }] : []),
      ...(options.scriptsAttach === true ? [{ call: "agent.attach", result: ATTACH_REPLY }] : []),
      ...(options.scriptsFirstTurn === true
        ? [{ call: RUN_QUEUE_CREATE_METHOD, result: QUEUE_REPLY }]
        : []),
    ],
  };
}

export function draftFor(options: ScriptedLegs): NewSessionDraft {
  return new NewSessionDraft({ bridge: createFixtureBridge({ scenario: scenario(options) }) });
}

/** The method one recorded call named, for a count that reads as what it counts. */
export function sentMethod(call: RecordedDaemonCall): string {
  return call.method;
}

/** A draft plus a tally of what reached the wire behind it. */
export interface CountedDraft {
  readonly draft: NewSessionDraft;
  /**
   * Every call `daemon.call` was given, in order.
   *
   * The recorder's own live array, not a snapshot: a case reads it after the send it
   * is counting, and a copy taken at construction would always be empty.
   */
  readonly calls: readonly RecordedDaemonCall[];
}

/**
 * A draft over the fixture bridge, with `daemon.call` recorded on the way past.
 *
 * Through `withDaemonCall`, the console's one shared arm for this, rather than a
 * spread written here: `daemon-reply-chokepoint` scans source text and does not care
 * which tier wrote the reach, so a suite that spelled its own would be the second
 * implementation of the door every other suite already drives.
 *
 * The answer is `CREATE_REPLY` or a rejection, which is the two states the scenario
 * itself puts the fixture in — what these cases assert is what the DRAFT does with
 * each, and the count is of what it sent.
 */
export function countedDraftFor(options: ScriptedLegs): CountedDraft {
  const under = withDaemonCall(
    createFixtureBridge({ scenario: scenario(options) }),
    async (call) => {
      if (call.method === RUN_QUEUE_CREATE_METHOD) {
        if (options.scriptsFirstTurn !== true) {
          throw new Error(`no reply is scripted for ${call.method}`);
        }
        return QUEUE_REPLY;
      }
      if (!options.scriptsCreate) {
        throw new Error(`no reply is scripted for ${call.method}`);
      }
      return CREATE_REPLY;
    },
  );
  return { draft: new NewSessionDraft({ bridge: under.bridge }), calls: under.calls };
}

/**
 * A reply to `session.create` the registered response schema refuses.
 *
 * Short of `state`, `memberships` and `channels`, which `SessionCreateResponseSchema`
 * requires — so the call FULFILS and the call door answers `reply-unreadable`. That
 * distinction is the whole subject of the ambiguous arm: the daemon was reached, ran,
 * and answered, and only this build's reading of what it said failed.
 */
const UNREADABLE_CREATE_REPLY = { sessionId: CREATED_SESSION_ID } as const;

/**
 * A draft whose create answers unreadably, with the tally of what reached the wire.
 *
 * The counted arm rather than the plain one, because what these cases assert is a
 * NEGATIVE about the wire — that a second press sends no second `session.create` — and
 * a result alone cannot say how many calls were made.
 */
export function countedDraftOverUnreadableCreate(): CountedDraft {
  const under = withDaemonCall(
    createFixtureBridge({ scenario: scenario({ scriptsCreate: true }) }),
    async () => UNREADABLE_CREATE_REPLY,
  );
  return { draft: new NewSessionDraft({ bridge: under.bridge }), calls: under.calls };
}
