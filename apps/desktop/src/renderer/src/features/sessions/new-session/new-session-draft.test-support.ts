// Scaffolding every new-session suite drives: the scripted create reply and the bridge that
// answers it, the first-turn call a case makes answer or reject, and the draft factories
// (plain, and one that records what reached the wire). One copy, so the draft and control
// suites never script slightly different replies.

import type { AgentProviderBinding } from "@ai-sidekicks/contracts/agent-definition";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { withDaemonCall, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "@fixtures/scenario.js";
import type { FirstTurnQueueCall } from "./new-session-control-contract.js";
import { NewSessionDraft } from "./new-session-draft.js";
import { type DraftRepoMount } from "./new-session-send.js";
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
 * A project a draft can be pointed at, which makes the draft non-empty without a first
 * message: the path a person takes who picks a project and presses Send before typing.
 */
export const PROJECT_REPO_MOUNT: DraftRepoMount = {
  repoMountId: "770e8400-e29b-41d4-a716-446655440002" as RepoMountId,
  executionMode: "provisioned-worktree",
};

/**
 * The whole registered create response. The fixture bridge refuses a scripted reply that is
 * short of the method's shape, so a partial script would test a reply the daemon cannot send.
 */
export const CREATE_REPLY: {
  readonly sessionId: string;
  readonly shape: "chat";
  readonly state: "active";
} = {
  sessionId: CREATED_SESSION_ID,
  shape: "chat",
  state: "active",
};

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

/**
 * A bridge whose `session.create` answers, or one whose does not. The fixture bridge rather
 * than a stub, since a stub of `bridge.daemon.call` would be a second implementation of the
 * call these suites drive.
 */
export function bridgeFor(options: { readonly scriptsCreate: boolean }): PlatformBridge {
  return createFixtureBridge({ scenario: scenario(options) }).bridge;
}

/** A draft over the fixture bridge whose create is scripted by `options`. */
export function draftFor(options: ScriptedLegs): NewSessionDraft {
  return new NewSessionDraft({
    bridge: bridgeFor(options),
    queueFirstTurn: firstTurnCall(options, []),
    lead: NEW_SESSION_LEAD,
  });
}

/**
 * A draft over the fixture bridge, with `daemon.call` recorded on the way past through
 * `withDaemonCall`. The answer is `CREATE_REPLY` or a rejection, and the count is of what the
 * draft sent.
 */
export function countedDraftFor(options: ScriptedLegs): CountedDraft {
  const under = withDaemonCall(bridgeFor(options), async (call) => {
    if (!options.scriptsCreate) {
      throw new Error(`no reply is scripted for ${call.method}`);
    }
    return CREATE_REPLY;
  });
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

function scenario(options: { readonly scriptsCreate: boolean }): Scenario {
  return {
    id: "draft-send",
    label: "Draft send",
    purpose: "Drives the new-session draft's create call.",
    sessionId: "session-draft",
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
    bridgeFor({ scriptsCreate: true }),
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
