// What a new-session send settles as: the closed vocabularies and the settlements a caller
// cannot compose for itself. `send.ts` owns the order of the calls; this module
// owns the words the result comes back in, and issues no call. Settlements with more than one
// producer are built here so two views never tell a person opposite things about one state,
// and the codes a person pastes into an issue have one home.

import { refuse, type NarrowedRefusal } from "#renderer/lib/refusal/contract.js";

/**
 * Why a send could not complete. Closed, so a further cause is a decision. One code per call
 * that could not be made, since "the session does not exist" and "the session exists and
 * nothing was said" call for different acts.
 */
export const NEW_SESSION_DRAFT_REFUSAL_CODES = [
  "draft-empty",
  "session-create-failed",
  // A separate code from `session-create-failed`: one says press again, this one says do not.
  "session-create-unreadable",
  "first-turn-missing",
  "first-turn-failed",
] as const;

/**
 * What a send settled as. A tuple, because consumers must be total over it (the control keys
 * its announcement off a `Record` of this union).
 *
 *   • `sent`: every call the draft named landed.
 *   • `partial`: the session exists and a later leg did not; the draft stays, and a second
 *     press resumes at the first call not yet made.
 *   • `refused`: nothing was created, so pressing Send again is right.
 *   • `created-unreadable`: `session.create` answered with a reply this build cannot read, so
 *     it cannot say whether a session was created. `refused` would invite a second session
 *     and `partial` would claim an id nothing holds. A retry carries the same idempotency key
 *     but returns the same unreadable reply, so the only act left is to go and look. Terminal
 *     for the draft that reached it.
 */
export const NEW_SESSION_SEND_OUTCOMES = [
  "sent",
  "partial",
  "refused",
  "created-unreadable",
] as const;

/** One settled send outcome, derived from the tuple. */
export type NewSessionSendOutcome = (typeof NEW_SESSION_SEND_OUTCOMES)[number];

/** One draft refusal code, derived from the tuple. */
export type NewSessionDraftRefusalCode = (typeof NEW_SESSION_DRAFT_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const NEW_SESSION_DRAFT_REFUSAL_ORIGIN = "new-session-draft";

/** A typed draft refusal: the one refusal shape, narrowed on `code`. */
export type NewSessionDraftRefusal = NarrowedRefusal<NewSessionDraftRefusalCode>;

/** Build a draft refusal under this module's origin. */
export function refuseNewSessionDraft(
  code: NewSessionDraftRefusalCode,
  detail: string,
): NewSessionDraftRefusal {
  return refuse(NEW_SESSION_DRAFT_REFUSAL_ORIGIN, code, detail);
}

/** The wire name a send reports its create leg under, spelled once. */
export const SESSION_CREATE_METHOD = "session.create";
/** The wire name a send reports its first-turn leg under, spelled once. */
export const RUN_QUEUE_CREATE_METHOD = "run.queueCreate";

/**
 * What the coalesced send did. `completedCalls` carries the wire names verbatim and in order,
 * so the error line can name the calls that succeeded.
 */
export interface NewSessionSendResult {
  readonly outcome: NewSessionSendOutcome;
  /**
   * Present once `session.create` answered readably, whatever happened after. Absent on
   * `created-unreadable`, where a session may exist that this app cannot name.
   */
  readonly sessionId: string | undefined;
  readonly completedCalls: readonly string[];
  readonly refusal: NewSessionDraftRefusal | undefined;
  /**
   * The draft revision this send read its composition from. It travels on the result because
   * the draft stays editable while the create runs, and a composition that moved on holds
   * words this send did not carry. `undefined` where the send read no draft: an empty draft,
   * or a press answered from what a previous one landed.
   */
  readonly sentRevision: number | undefined;
}

/**
 * The settlement for a create this app cannot answer for. One home, because the send that
 * first read the unreadable reply and the draft answering every later press both reach it,
 * and the instruction must stay "do not send again". The sentence names the ambiguity and
 * offers the safe act: the sessions list re-reads the directory, where a created session
 * appears under its own name. `sentRevision` is the caller's because the send read a draft and
 * the draft's memory read nothing.
 */
export function refuseAmbiguousCreate(sentRevision: number | undefined): NewSessionSendResult {
  return {
    outcome: "created-unreadable",
    sessionId: undefined,
    sentRevision,
    // Nothing is claimed as landed: "Already sent: session.create" would assert what this
    // module has no evidence for.
    completedCalls: [],
    refusal: refuseNewSessionDraft(
      "session-create-unreadable",
      "The background service answered, but this build could not read " +
        "the reply — so a session may have been created and this window " +
        "cannot name it. Nothing else was sent. Check the sessions list " +
        "rather than sending again: a second send would make a second " +
        "session.",
    ),
  };
}
