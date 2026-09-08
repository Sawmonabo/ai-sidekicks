// The first send: three wire calls, in order, reported as one act.
//
// SPLIT FROM THE DRAFT THAT COMPOSES ONE, on `aux-handoff-contract.ts`'s reading of
// the same line. `new-session-draft.ts` owns what a person has CHOSEN — the agents,
// the mount, the posture, the first turn — and the coalescing that keeps one draft to
// one session. This module owns what those choices become on the wire and what the
// result of sending them says, and it holds no state at all, so every rule in it can
// be checked without constructing a draft.
//
// "The first send coalesces `session.create`, one `agent.attach` per agent, and
// `run.queueCreate`; a failure in any of the three renders in the error slot with the
// calls that succeeded named, and the draft stays editable."
//
// ORDERED AND NOT PARALLEL, because the two calls after the create need the session it
// returns: issuing them together would mean inventing the id before the daemon minted
// it. So the send stops at the first call it cannot make, and what it reports is the
// prefix that landed — never a rollback, because a renderer cannot undo a
// `session.create` the daemon accepted and pretending otherwise would leave a real
// session the person believes was never made.
//
// AND THE ATTACH LEG GOES THROUGH THE GROWTH PORT RATHER THAN REFUSING LOCALLY.
// `agent.attach` is on `Plan-023 §Console growth slate`'s `agent-snapshot-axes` row
// and reaches the console as a growth operation the fixture serves from a script, so
// a draft that refused it by name was refusing a call it could have made — and, on
// the live bridge, was minting a second sentence for the refusal the port already
// composes. The port's own refusal travels instead, which is what names the document
// that owes the wire.
//
// EVERY CALL SETTLES. `callDaemon` never throws and the attach rides
// `settledGrowthCall`, so a leg that rejects becomes a refusal on the same arm as one
// that was refused — the alternative leaves a Send that answers a press by doing
// nothing while the fault reaches only an unhandled rejection a shipped window does
// not report.

import {
  callDaemon,
  readQueueItemCreateRequest,
  settledGrowthCall,
  type ConsoleBridge,
  type DaemonReplyRefusalCode,
} from "../../bridge/index.js";
import { refuse, type NarrowedRefusal } from "../../core/index.js";

/**
 * Why a send could not complete. Closed, so a further cause is a decision.
 *
 * ONE CODE PER CALL THAT COULD NOT BE MADE, rather than one word covering the three:
 * a person pasting a code into an issue is telling somebody which leg stopped, and
 * "the session exists and its sidekicks do not" is a different state to act on from
 * "the session and its sidekicks exist and nothing was said".
 */
export const NEW_SESSION_DRAFT_REFUSAL_CODES = [
  "draft-empty",
  "session-create-failed",
  // The create the console cannot answer for — see {@link NEW_SESSION_SEND_OUTCOMES}.
  // A SEPARATE CODE FROM `session-create-failed`, because the two are opposite
  // instructions: one says press again, and this one says do not.
  "session-create-unreadable",
  "agent-attach-failed",
  "first-turn-missing",
  "first-turn-failed",
  // Not a refusal the wire raised: `send` answers with a result on every path and
  // every call inside it settles, so this names a fault INSIDE the send — and the
  // alternative shipped once: a rejection that cleared the result and said nothing.
  "send-failed",
] as const;

/**
 * What a send SETTLED as. Closed and declared once, so no caller can forget an arm.
 *
 * Declared as a tuple on {@link NEW_SESSION_DRAFT_REFUSAL_CODES}' own terms rather
 * than inline on the result, because the vocabulary has consumers that must be TOTAL
 * over it — the control keys its announcement off a `Record` of this union — and a
 * union spelled inline is one a fifth arm can be added to without any of them
 * noticing.
 *
 *   • `sent` — every call the draft named landed.
 *   • `partial` — the session exists and a later leg did not; the draft stays, and a
 *     second press resumes at the first call that has not been made.
 *   • `refused` — nothing was created. Pressing Send again is the right act.
 *   • `created-unreadable` — the daemon answered `session.create` with a reply this
 *     build cannot read, so the console cannot say whether a session was created.
 *     NEITHER of the two dispositions beside it is honest: reporting `refused` invites
 *     a second press, which mints a second session where the first one landed, and
 *     reporting `partial` claims a session and an id nothing here holds. The wire
 *     carries no idempotency member for `session.create` — Spec-001 and Spec-002 mint
 *     none — so a renderer cannot make the retry safe, and the only safe act left is
 *     to go and look. This arm is terminal for the draft that reached it.
 */
export const NEW_SESSION_SEND_OUTCOMES = [
  "sent",
  "partial",
  "refused",
  "created-unreadable",
] as const;

/** One settled send outcome. Derived, so the vocabulary is declared once. */
export type NewSessionSendOutcome = (typeof NEW_SESSION_SEND_OUTCOMES)[number];

/** One draft refusal code. Derived, so the vocabulary is declared once. */
export type NewSessionDraftRefusalCode = (typeof NEW_SESSION_DRAFT_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const NEW_SESSION_DRAFT_REFUSAL_ORIGIN = "new-session-draft";

/** A typed draft refusal — `core`'s one refusal shape, narrowed on `code`. */
export type NewSessionDraftRefusal = NarrowedRefusal<NewSessionDraftRefusalCode>;

export function refuseDraft(
  code: NewSessionDraftRefusalCode,
  detail: string,
): NewSessionDraftRefusal {
  return refuse(NEW_SESSION_DRAFT_REFUSAL_ORIGIN, code, detail);
}

/** The wire names this module sends, spelled once each. */
export const SESSION_CREATE_METHOD = "session.create";
export const AGENT_ATTACH_METHOD = "agent.attach";
export const RUN_QUEUE_CREATE_METHOD = "run.queueCreate";

/**
 * What the coalesced send did.
 *
 * `completedCalls` carries the wire names verbatim and in order, because the rule
 * above requires the error slot to NAME the calls that succeeded — a person deciding
 * whether to press again needs to know a session already exists, and how many of its
 * sidekicks are on it.
 */
export interface NewSessionSendResult {
  readonly outcome: NewSessionSendOutcome;
  /**
   * Present once `session.create` answered READABLY, whatever happened after it.
   *
   * Absent on `created-unreadable`, which is the whole difficulty of that arm: a
   * session may exist and this console holds no name for it.
   */
  readonly sessionId: string | undefined;
  readonly completedCalls: readonly string[];
  readonly refusal: NewSessionDraftRefusal | undefined;
}

/**
 * What a send that REJECTED reports, rather than reporting nothing.
 *
 * {@link sendNewSessionDraft} returns a typed result on every path, so a rejection out
 * of it is a fault inside this family — the case a caller cannot invent a sentence for
 * and must not swallow. Built HERE so a control composing its own refusal cannot
 * become a second source of the codes a person pastes into an issue.
 */
export function refuseSendThatRejected(): NewSessionSendResult {
  return {
    outcome: "refused",
    sessionId: undefined,
    completedCalls: [],
    refusal: refuseDraft(
      "send-failed",
      "The draft could not be sent, and nothing was created. It is still here, and Send can be pressed again.",
    ),
  };
}

/**
 * The settlement for a create this console cannot answer for.
 *
 * ONE HOME, because two callers reach it: the send that first read the unreadable
 * reply, and the draft answering every LATER press without putting anything on the
 * wire. A second spelling would let the two disagree about what a person is told to
 * do — and the whole point of the arm is that the instruction is "do not send again".
 *
 * The sentence names the ambiguity rather than resolving it, and offers the one act
 * that is safe: the sessions list re-reads the node's directory, so a session that WAS
 * created appears there under its own name.
 */
export function refuseAmbiguousCreate(): NewSessionSendResult {
  return {
    outcome: "created-unreadable",
    sessionId: undefined,
    // Nothing is CLAIMED as landed: the call may have made a session and may not, and
    // a line reading "Already sent: session.create" would be an assertion this module
    // has no evidence for. The sentence carries the ambiguity instead.
    completedCalls: [],
    refusal: refuseDraft(
      "session-create-unreadable",
      "The daemon answered, but this build could not read the reply — so a session may have been created and this window cannot name it. Nothing else was sent. Check the sessions list rather than sending again: a second send would make a second session.",
    ),
  };
}

/** One agent the send attaches, by definition, with the account that pays. */
export interface NewSessionAgentLeg {
  readonly definitionId: string;
  readonly providerAccountId: string | undefined;
}

/**
 * Everything the send needs from the draft, and what it already did.
 *
 * `alreadyAttachedDefinitionIds` and `firstTurnAlreadyQueued` are what make a repeat
 * press resume at the first UNMADE call rather than repeat the ones that landed. A
 * send that re-issued a completed attach would put a second agent on the session for
 * one the person chose once; one that re-issued the turn would send their words twice.
 */
export interface NewSessionSendRequest {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly agents: readonly NewSessionAgentLeg[];
  readonly alreadyAttachedDefinitionIds: ReadonlySet<string>;
  readonly firstTurnAlreadyQueued: boolean;
  readonly firstTurn: string;
  readonly executionPostureMode: string | undefined;
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
  readonly attachedDefinitionIds: readonly string[];
  readonly firstTurnQueued: boolean;
}

/**
 * Issue the three calls in order, and report the prefix that landed.
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
      result: refuseAmbiguousCreate(),
      sessionId: undefined,
      createAnsweredUnreadably: true,
      attachedDefinitionIds: [],
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
      },
      sessionId: undefined,
      createAnsweredUnreadably: false,
      attachedDefinitionIds: [],
      firstTurnQueued: false,
    };
  }
  const { sessionId } = created;

  const attached: string[] = [];
  for (const agent of request.agents) {
    if (request.alreadyAttachedDefinitionIds.has(agent.definitionId)) {
      // Named as completed even though this press did not issue it, on the create
      // leg's rule: the slot says what EXISTS, and a sidekick put on the session by
      // the previous press is as much on it as one put there by this one.
      completedCalls.push(AGENT_ATTACH_METHOD);
      continue;
    }
    // Sequential and not `Promise.all`: the daemon stamps an agent's snapshot axes at
    // attach, and a partial batch reported as one rejection would leave the draft
    // unable to say WHICH sidekicks are on the session — which is the fact a person
    // needs before deciding whether to press again.
    const answer = await settledGrowthCall("agentAttach", async () =>
      request.bridge.growth.agentAttach({
        sessionId,
        definitionId: agent.definitionId,
        ...(agent.providerAccountId === undefined
          ? {}
          : { providerAccountId: agent.providerAccountId }),
        ...(request.executionPostureMode === undefined
          ? {}
          : { executionPostureMode: request.executionPostureMode }),
      }),
    );
    if (answer.status === "unavailable") {
      return {
        result: {
          outcome: "partial",
          sessionId,
          completedCalls,
          // The PORT's own sentence, carried rather than paraphrased: it names the
          // wire and the document that owes it, which is more than this module knows.
          refusal: refuseDraft(
            "agent-attach-failed",
            `The session was created, but a sidekick could not be attached, so no first turn was queued either. ${answer.detail}`,
          ),
        },
        sessionId,
        createAnsweredUnreadably: false,
        attachedDefinitionIds: attached,
        firstTurnQueued: false,
      };
    }
    attached.push(agent.definitionId);
    completedCalls.push(AGENT_ATTACH_METHOD);
  }

  const turn = await queueFirstTurn(request, sessionId, completedCalls);
  return {
    result: {
      outcome: turn.refusal === undefined ? "sent" : "partial",
      sessionId,
      completedCalls,
      refusal: turn.refusal,
    },
    sessionId,
    createAnsweredUnreadably: false,
    attachedDefinitionIds: attached,
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
    // Named as completed even though this press did not issue it: the slot's job is to
    // say what EXISTS, and a session made by the previous press is as real as one made
    // by this one.
    completedCalls.push(SESSION_CREATE_METHOD);
    return { settlement: "resolved", sessionId: request.sessionId };
  }
  // Through the bridge's one call door, which parses the request before sending and
  // the reply after and never throws.
  const reply = await callDaemon(request.bridge, SESSION_CREATE_METHOD, {});
  if (reply.status === "refused") {
    if (reply.refusal.code === ("reply-unreadable" satisfies DaemonReplyRefusalCode)) {
      // THE ONE REFUSAL THAT IS NOT EVIDENCE OF NOTHING HAPPENING. The door answers
      // this code when the call FULFILLED and the value failed the registered response
      // schema — so the daemon was reached, ran, and answered, and the only thing that
      // failed is this build's reading of what it said. A session was very possibly
      // created.
      //
      // NARROW ON PURPOSE, and the boundary is the door's own vocabulary rather than a
      // judgement made here: `request-unsendable` means nothing left this process,
      // `read-abandoned` is never reachable on a mutation (the door takes no signal
      // here), and `call-rejected` is the call itself failing — which this module
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
      refusal: refuseDraft(
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
  // wire is the participant's own bytes, so a first turn that opens with indented code
  // keeps its shape. `send-router.ts` states the same rule for the composer's path.
  if (request.firstTurn.trim().length === 0) {
    return {
      queued: false,
      refusal: refuseDraft(
        "first-turn-missing",
        "The session was created and its sidekicks are on it, but nothing was said yet — type the first message and press Send again.",
      ),
    };
  }
  // Read through the bridge family's own reader rather than cast: the store holds
  // wire-verbatim strings and `run.queueCreate` takes a branded id, so an id the wire
  // would refuse becomes a rendered refusal here instead of a rejected round trip.
  const queueRequest = readQueueItemCreateRequest({
    sessionId,
    payload: { content: request.firstTurn },
  });
  if (queueRequest === undefined) {
    return {
      queued: false,
      refusal: refuseDraft(
        "first-turn-failed",
        "The session was created, but the console could not build a first turn the daemon would accept, so it sent none.",
      ),
    };
  }
  const reply = await callDaemon(request.bridge, RUN_QUEUE_CREATE_METHOD, queueRequest);
  if (reply.status === "refused") {
    return {
      queued: false,
      refusal: refuseDraft(
        "first-turn-failed",
        `The session was created and its sidekicks are on it, but the first turn was not queued. ${reply.refusal.detail}`,
      ),
    };
  }
  completedCalls.push(RUN_QUEUE_CREATE_METHOD);
  return { queued: true, refusal: undefined };
}
