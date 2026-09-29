// The first send: two calls, in order, reported as one act.
//
// SPLIT FROM THE DRAFT THAT COMPOSES ONE. `new-session-draft.ts` owns what a person has
// CHOSEN — the mount, the posture, the first turn — and the coalescing that keeps one
// draft to one session. This module owns what those choices become on the wire, in what
// order, and which answer ends the send; the WORDS it settles in are
// `new-session-settlement.ts`'s. It holds no state at all, so every rule in it can be
// checked without constructing a draft.
//
// ORDERED AND NOT PARALLEL, because the turn needs the session the create returns:
// issuing them together would mean inventing the id before the daemon minted it. So the
// send stops at the first call it cannot make, and what it reports is the prefix that
// landed — never a rollback, because a renderer cannot undo a `session.create` the
// daemon accepted and pretending otherwise would leave a real session the person
// believes was never made.
//
// EVERY CALL SETTLES. `callDaemon` never throws and the first-turn call's rejection is
// caught, so a leg that fails becomes a refusal on the same arm as one that was refused
// — the alternative leaves a Send that answers a press by doing nothing while the fault
// reaches only an unhandled rejection a shipped window does not report.

import { callDaemon, type DaemonReplyRefusalCode } from "@renderer/services/daemon/daemon-reply.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { coerceToRefusal, type FirstTurnQueueCall } from "@renderer/console/seats/index.js";
import {
  NEW_SESSION_DRAFT_REFUSAL_ORIGIN,
  RUN_QUEUE_CREATE_METHOD,
  SESSION_CREATE_METHOD,
  refuseAmbiguousCreate,
  refuseNewSessionDraft,
  type NewSessionDraftRefusal,
  type NewSessionSendResult,
} from "./new-session-settlement.js";

/**
 * Everything the send needs from the draft, and what it already did.
 *
 * `sessionId` and `firstTurnAlreadyQueued` are what make a repeat press resume at the
 * first UNMADE call rather than repeat the ones that landed. A send that re-issued the
 * turn would send the person's words twice.
 */
export interface NewSessionSendRequest {
  readonly bridge: PlatformBridge;
  /** Queues the first message on the session, once it exists. */
  readonly queueFirstTurn: FirstTurnQueueCall;
  readonly sessionId: string | undefined;
  readonly firstTurnAlreadyQueued: boolean;
  readonly firstTurn: string;
  /**
   * Which revision of the draft the caller read this request out of.
   *
   * Carried through onto every settlement rather than asked of the draft afterwards:
   * the draft is editable for as long as the send is running, so the answer at the
   * moment a result lands is not the answer this send acted on.
   */
  readonly draftRevision: number;
}

/** What the send landed, so the draft can remember it and resume from it. */
export interface NewSessionSendProgress {
  readonly result: NewSessionSendResult;
  /** Present once the create answered readably — the id every later leg is addressed by. */
  readonly sessionId: string | undefined;
  /**
   * Whether `session.create` answered with a reply this build could not read.
   *
   * A SEPARATE MEMBER FROM `sessionId`, and not derivable from it: an absent id also
   * describes a create that plainly refused, and those two states take opposite next
   * acts. The draft records this one and never issues a create again.
   */
  readonly createAnsweredUnreadably: boolean;
  readonly firstTurnQueued: boolean;
}

/**
 * Issue the two calls in order, and report the prefix that landed.
 *
 * Takes the session it already has rather than creating unconditionally: a repeat
 * press after a partial addresses the session the first press made, because minting a
 * second one would leave the person looking at a session nothing they chose is in.
 */
export async function sendNewSessionDraft(
  request: NewSessionSendRequest,
): Promise<NewSessionSendProgress> {
  const completedCalls: string[] = [];
  const created = await resolveSession(request, completedCalls);
  if (created.settlement === "unreadable") {
    // The one arm that is neither a refusal nor a partial. Reported through
    // {@link NewSessionSendProgress} so the draft can REMEMBER it: a create that
    // answered unreadably is a create that must never be issued again from this
    // draft, and the memory is what makes the next press dispatch nothing.
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
 * How the create leg ended.
 *
 * Three arms and not two, because "nothing was created" and "we cannot say" are
 * different facts with opposite next acts, and an absent `sessionId` describes both.
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
    // Named as completed even though this press did not issue it: the completed-calls
    // list's job is to say what EXISTS, and a session made by the previous press is as
    // real as one made by this one.
    completedCalls.push(SESSION_CREATE_METHOD);
    return { settlement: "resolved", sessionId: request.sessionId };
  }
  // Through `callDaemon`, the bridge's one daemon call, which parses the request before sending and
  // the reply after and never throws.
  const reply = await callDaemon(request.bridge, SESSION_CREATE_METHOD, {});
  if (reply.status === "refused") {
    if (reply.refusal.code === ("reply-unreadable" satisfies DaemonReplyRefusalCode)) {
      // THE ONE REFUSAL THAT IS NOT EVIDENCE OF NOTHING HAPPENING. `callDaemon` answers
      // this code when the call FULFILLED and the value failed the registered response
      // schema — so the daemon was reached, ran, and answered, and the only thing that
      // failed is this build's reading of what it said. A session was very possibly
      // created.
      //
      // NARROW ON PURPOSE, and the boundary is `callDaemon`'s own vocabulary rather than a
      // judgment made here: `request-unsendable` means nothing left this process,
      // `read-abandoned` is never reachable on a mutation (`callDaemon` is handed no
      // cancellation here), and `call-rejected` is the call itself failing — which this module
      // treats as a plain refusal, because widening the ambiguous arm to every
      // transport hiccup would make a draft permanently unsendable for a fault that
      // reached no daemon.
      return { settlement: "unreadable" };
    }
    // The daemon's own message is not console copy — it crosses an IPC boundary, may
    // be a stack, and describes a subsystem the person cannot act on. The code names
    // which call failed, which is what a person pastes into an issue.
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
  // Blankness is decided by trimming and the text is never trimmed: what reaches the
  // wire is the user's own bytes, so a first turn that opens with indented code
  // keeps its shape. `send-router.ts` states the same rule for the composer's path.
  if (request.firstTurn.trim().length === 0) {
    return {
      queued: false,
      refusal: refuseNewSessionDraft(
        "first-turn-missing",
        "The session was created, but nothing was said yet — type the first message and press Send again.",
      ),
    };
  }
  try {
    await request.queueFirstTurn({ sessionId, content: request.firstTurn });
  } catch (error: unknown) {
    // The session exists whatever happened here, so the failure is reported as a
    // partial send that a second press resumes, and never as a send that made nothing.
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
