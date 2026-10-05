// The first send: two calls, in order, reported as one act. `new-session-draft.ts` owns what a
// person chose and the coalescing; this module owns what the choices become on the wire and
// which answer ends the send, and `new-session-settlement.ts` owns the words it settles in.
// It holds no state.
//
// The calls are ordered because the turn needs the session the create returns. The send stops
// at the first call it cannot make and reports the prefix that landed, never a rollback: a
// renderer cannot undo a `session.create` the daemon accepted. Every call settles
// (`callDaemon` never throws and the first-turn rejection is caught), so a failed leg becomes
// a refusal instead of an unhandled rejection a shipped window does not report.

import type { AgentProviderBinding } from "@ai-sidekicks/contracts/agent/definition";
import type { ExecutionMode, RepoMountId } from "@ai-sidekicks/contracts/repo/repo";
import type { SessionBinding } from "@ai-sidekicks/contracts/session/directory";
import { callDaemon, type DaemonReplyRefusalCode } from "@renderer/services/daemon/daemon-reply.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";
import { type FirstTurnQueueCall } from "./new-session-control-contract.js";
import {
  NEW_SESSION_DRAFT_REFUSAL_ORIGIN,
  RUN_QUEUE_CREATE_METHOD,
  SESSION_CREATE_METHOD,
  refuseAmbiguousCreate,
  refuseNewSessionDraft,
  type NewSessionDraftRefusal,
  type NewSessionSendResult,
} from "./new-session-settlement.js";

/** The project a new session works in, and whether in a worktree of its own or the checkout. */
export interface DraftRepoMount {
  readonly repoMountId: RepoMountId;
  readonly executionMode: ExecutionMode;
}

/**
 * Everything the send needs from the draft, and what it already did. `sessionId` and
 * `firstTurnAlreadyQueued` make a repeat press resume at the first unmade call, so the
 * person's words are never sent twice.
 */
export interface NewSessionSendRequest {
  readonly bridge: PlatformBridge;
  /** Queues the first message on the session, once it exists. */
  readonly queueFirstTurn: FirstTurnQueueCall;
  readonly sessionId: string | undefined;
  readonly firstTurnAlreadyQueued: boolean;
  /** The project the session works in; absent, the session is a chat. */
  readonly repoMount: DraftRepoMount | undefined;
  /** The lead's provider, model, account and effort the session starts on. */
  readonly lead: AgentProviderBinding;
  /** The draft's one key for its create, so a create sent again names the session already made. */
  readonly clientIdempotencyKey: string;
  readonly firstTurn: string;
  /**
   * The draft revision the caller read this request from, carried onto every settlement
   * because the draft stays editable while the send runs.
   */
  readonly draftRevision: number;
}

/** What the send landed, so the draft can remember it and resume from it. */
export interface NewSessionSendProgress {
  readonly result: NewSessionSendResult;
  /** Present once the create answered readably — the id every later leg is addressed by. */
  readonly sessionId: string | undefined;
  /**
   * Whether `session.create` answered with a reply this build could not read. Separate from
   * `sessionId`, since an absent id also describes a create that plainly refused and the two
   * take opposite next acts.
   */
  readonly createAnsweredUnreadably: boolean;
  readonly firstTurnQueued: boolean;
}

/**
 * Issue the two calls in order, and report the prefix that landed. Takes the session it
 * already has, so a repeat press after a partial addresses the first press's session.
 */
export async function sendNewSessionDraft(
  request: NewSessionSendRequest,
): Promise<NewSessionSendProgress> {
  const completedCalls: string[] = [];
  const created = await resolveSession(request, completedCalls);
  if (created.settlement === "unreadable") {
    // Reported through the progress so the draft remembers it and never issues another create.
    return {
      result: refuseAmbiguousCreate(request.draftRevision),
      sessionId: undefined,
      createAnsweredUnreadably: true,
      firstTurnQueued: false,
    };
  }
  if (created.settlement === "refused") {
    return {
      result: {
        outcome: "refused",
        sessionId: undefined,
        completedCalls,
        refusal: created.refusal,
        sentRevision: request.draftRevision,
      },
      sessionId: undefined,
      createAnsweredUnreadably: false,
      firstTurnQueued: false,
    };
  }
  const { sessionId } = created;

  const turn = await queueFirstTurn(request, sessionId, completedCalls);
  return {
    result: {
      outcome: turn.refusal === undefined ? "sent" : "partial",
      sessionId,
      completedCalls,
      refusal: turn.refusal,
      sentRevision: request.draftRevision,
    },
    sessionId,
    createAnsweredUnreadably: false,
    firstTurnQueued: turn.queued,
  };
}

/**
 * How the create leg ended. Three arms, because "nothing was created" and "we cannot say"
 * are different facts with opposite next acts.
 */
type CreateSettlement =
  | { readonly settlement: "resolved"; readonly sessionId: string }
  | { readonly settlement: "refused"; readonly refusal: NewSessionDraftRefusal }
  | { readonly settlement: "unreadable" };

/** The create leg, skipped for a draft whose session already exists. */
async function resolveSession(
  request: NewSessionSendRequest,
  completedCalls: string[],
): Promise<CreateSettlement> {
  if (request.sessionId !== undefined) {
    // Named as completed though this press did not issue it: the list says what exists.
    completedCalls.push(SESSION_CREATE_METHOD);
    return { settlement: "resolved", sessionId: request.sessionId };
  }
  // Through `callDaemon`, which parses the request and the reply and never throws.
  const reply = await callDaemon(request.bridge, SESSION_CREATE_METHOD, {
    clientIdempotencyKey: request.clientIdempotencyKey,
    binding: sessionBinding(request.repoMount),
    lead: request.lead,
  });
  if (reply.status === "refused") {
    if (reply.refusal.code === ("reply-unreadable" satisfies DaemonReplyRefusalCode)) {
      // The only refusal that is not evidence nothing happened: the call fulfilled and the
      // reply failed the response schema, so a session was very possibly created. Narrow on
      // purpose, by `callDaemon`'s own codes: `request-unsendable` left nothing this process,
      // `read-abandoned` is unreachable on a mutation, and `call-rejected` is a plain refusal,
      // since widening this arm would make a draft permanently unsendable after a fault that
      // reached no daemon.
      return { settlement: "unreadable" };
    }
    // The daemon's message crosses an IPC boundary and may be a stack. The code names which
    // call failed, which is what a person pastes into an issue.
    return {
      settlement: "refused",
      refusal: refuseNewSessionDraft(
        "session-create-failed",
        "The session could not be created. Nothing was sent, and the draft is still here.",
      ),
    };
  }
  completedCalls.push(SESSION_CREATE_METHOD);
  return { settlement: "resolved", sessionId: reply.value.sessionId };
}

/** Where the session works: the chosen project, or a chat when none was chosen. */
function sessionBinding(repoMount: DraftRepoMount | undefined): SessionBinding {
  return repoMount === undefined
    ? { kind: "chat" }
    : {
        kind: "project",
        repoMountId: repoMount.repoMountId,
        executionMode: repoMount.executionMode,
      };
}

/** The first-turn leg, which is the only one whose absence is the person's choice. */
async function queueFirstTurn(
  request: NewSessionSendRequest,
  sessionId: string,
  completedCalls: string[],
): Promise<{ readonly queued: boolean; readonly refusal: NewSessionDraftRefusal | undefined }> {
  if (request.firstTurnAlreadyQueued) {
    completedCalls.push(RUN_QUEUE_CREATE_METHOD);
    return { queued: true, refusal: undefined };
  }
  // Blankness is decided by trimming, but the text is never trimmed: the wire gets the user's
  // own bytes. `features/composer/draft-line/send-router.ts` states the same rule.
  if (request.firstTurn.trim().length === 0) {
    return {
      queued: false,
      refusal: refuseNewSessionDraft(
        "first-turn-missing",
        "The session was created, but nothing was said yet — type the " +
          "first message and press Send again.",
      ),
    };
  }
  try {
    await request.queueFirstTurn({ sessionId, content: request.firstTurn });
  } catch (error: unknown) {
    // The session exists whatever happened here, so report a partial send a second press resumes.
    const { detail } = coerceToRefusal(
      error,
      NEW_SESSION_DRAFT_REFUSAL_ORIGIN,
      "first-turn-failed",
    );
    return {
      queued: false,
      refusal: refuseNewSessionDraft(
        "first-turn-failed",
        `The session was created, but the first turn was not queued. ${detail}`,
      ),
    };
  }
  completedCalls.push(RUN_QUEUE_CREATE_METHOD);
  return { queued: true, refusal: undefined };
}
