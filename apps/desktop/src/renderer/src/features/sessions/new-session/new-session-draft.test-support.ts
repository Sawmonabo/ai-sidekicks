// Scaffolding both new-session suites drive: the scripted create reply, the first-turn call a
// case makes answer or reject, and the two draft factories (plain, and one that records what
// reached the wire). One copy, so the suites never script slightly different replies.

import type { AgentProviderBinding } from "@ai-sidekicks/contracts";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { withDaemonCall, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "../../../../../../fixtures/scenario.js";
import type { FirstTurnQueueCall } from "./new-session-control-contract.js";
import { NewSessionDraft } from "./new-session-draft.js";
// The method the send names, taken from the module that sends it, so a script never keys on a
// stale copy of a wire string.
import { SESSION_CREATE_METHOD } from "./new-session-settlement.js";

/** The session id the scripted create replies with. */
export const CREATED_SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5ac0de";

/** The lead every new session in these suites starts on. */
export const NEW_SESSION_LEAD: AgentProviderBinding = {
  driverName: "claude",
  modelId: "claude-opus-4-5",
  providerAccountId: null,
  effort: "high",
};

/**
 * The whole registered create response. The fixture bridge refuses a scripted reply that is
 * short of the method's shape, so a partial script would test a reply the daemon cannot send.
 */
const CREATE_REPLY = {
  sessionId: CREATED_SESSION_ID,
  shape: "chat",
  state: "active",
} as const;

/** What a case scripts, so it says which legs answer and which the first-turn call rejects. */
export interface ScriptedLegs {
  readonly scriptsCreate: boolean;
  readonly scriptsFirstTurn?: boolean;
}

/** One first message the send asked the first-turn call to queue. */
export interface QueuedFirstTurn {
  readonly sessionId: string;
  readonly content: string;
}

/** A draft plus a tally of what reached the wire behind it. */
export interface CountedDraft {
  readonly draft: NewSessionDraft;
  /**
   * Every call `daemon.call` was given, in order. The recorder's live array, not a snapshot:
   * a copy taken at construction would always be empty.
   */
  readonly calls: readonly RecordedDaemonCall[];
  /** Every first message the send handed the first-turn call, in order. */
  readonly firstTurns: readonly QueuedFirstTurn[];
}

/** A draft over the fixture bridge whose create is scripted by `options`. */
export function draftFor(options: ScriptedLegs): NewSessionDraft {
  return new NewSessionDraft({
    bridge: createFixtureBridge({ scenario: scenario(options) }).bridge,
    queueFirstTurn: firstTurnCall(options, []),
    lead: NEW_SESSION_LEAD,
  });
}

/** The method one recorded call named, for a count that reads as what it counts. */
export function sentMethod(call: RecordedDaemonCall): string {
  return call.method;
}

/**
 * A draft over the fixture bridge, with `daemon.call` recorded on the way past through
 * `withDaemonCall`. The answer is `CREATE_REPLY` or a rejection, and the count is of what the
 * draft sent.
 */
export function countedDraftFor(options: ScriptedLegs): CountedDraft {
  const under = withDaemonCall(
    createFixtureBridge({ scenario: scenario(options) }).bridge,
    async (call) => {
      if (!options.scriptsCreate) {
        throw new Error(`no reply is scripted for ${call.method}`);
      }
      return CREATE_REPLY;
    },
  );
  const firstTurns: QueuedFirstTurn[] = [];
  return {
    draft: new NewSessionDraft({
      bridge: under.bridge,
      queueFirstTurn: firstTurnCall(options, firstTurns),
      lead: NEW_SESSION_LEAD,
    }),
    calls: under.calls,
    firstTurns,
  };
}

/**
 * The first-turn call a case scripts: it records each request, then resolves or rejects. A
 * plain function, since the call is the send's argument and never a daemon method.
 */
function firstTurnCall(options: ScriptedLegs, recorded: QueuedFirstTurn[]): FirstTurnQueueCall {
  return (request) => {
    recorded.push(request);
    return options.scriptsFirstTurn === true
      ? Promise.resolve()
      : Promise.reject(new Error("no first turn is scripted"));
  };
}

function scenario(options: ScriptedLegs): Scenario {
  return {
    id: "draft-send",
    label: "Draft send",
    purpose: "Drives the new-session draft's create call.",
    sessionId: "session-draft",
    userIdsInJoinOrder: ["user-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: options.scriptsCreate ? [{ call: SESSION_CREATE_METHOD, result: CREATE_REPLY }] : [],
  };
}

/**
 * A reply to `session.create` the registered response schema refuses. It is short of `shape`
 * and `state`, so the call fulfills and `callDaemon` answers `reply-unreadable`: the daemon
 * answered and only this build's reading failed.
 */
const UNREADABLE_CREATE_REPLY = { sessionId: CREATED_SESSION_ID } as const;

/**
 * A draft whose create answers unreadably, with the tally of what reached the wire. Counted,
 * because the assertion is a negative about the wire (no second `session.create`).
 */
export function countedDraftOverUnreadableCreate(): CountedDraft {
  const under = withDaemonCall(
    createFixtureBridge({ scenario: scenario({ scriptsCreate: true }) }).bridge,
    async () => UNREADABLE_CREATE_REPLY,
  );
  const firstTurns: QueuedFirstTurn[] = [];
  return {
    draft: new NewSessionDraft({
      bridge: under.bridge,
      queueFirstTurn: firstTurnCall({ scriptsCreate: true }, firstTurns),
      lead: NEW_SESSION_LEAD,
    }),
    calls: under.calls,
    firstTurns,
  };
}
