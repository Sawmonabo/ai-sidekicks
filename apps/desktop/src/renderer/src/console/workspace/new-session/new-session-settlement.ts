// What a new-session send SETTLES as: the closed vocabularies, and the three
// settlements a caller cannot compose for itself.
//
// SPLIT FROM `new-session-send.ts`, which makes the calls. That module owns the ORDER
// three wire calls go in and what each answer means; this one owns the words the result
// comes back in — and together they were one file past the package's ceiling. The seam
// is the one the family already reads along: the draft and the composition both import
// settlements from here and issue no call, so every rule below can be checked without
// a bridge.
//
// EVERY SETTLEMENT A CALLER MIGHT OTHERWISE SPELL IS BUILT HERE. Two of them have more
// than one producer — the ambiguous create is reached by the send that first read it
// and again by the draft answering every later press — and a second spelling anywhere
// would let two surfaces tell a person opposite things about one state. The codes are
// what a person pastes into an issue, so they have exactly one home.

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
 * `new-session-send.ts` returns a typed result on every path, so a rejection out
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
