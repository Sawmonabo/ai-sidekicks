// What a person is told when the invite plane refuses, on each of its two paths.
//
// ONE MODULE FOR ONE JOB, and the job is narrow on purpose: every sentence here is
// what the reader can DO, printed beside the wire's own code and message and never
// instead of them. A surface that replaced the daemon's words with the console's
// would be answering for a control plane it cannot see, and one that printed the
// code alone would be handing a person a string to search for.
//
// TWO TABLES BECAUSE THERE ARE TWO ACTS, not two copies of one. `invite.create` is
// refused about a session the caller is already in and every remedy is something
// they can do here; `invite.accept` is refused about an invitation whose history the
// caller does not have, so several of its codes have no remedy at all and the honest
// sentence says what happened rather than what to press. Written as one table those
// two would have to share rows that mean different things — `invite.permission_denied`
// most of all, which on one path names the caller's own role and on the other names
// somebody else's.
//
// THE ACCEPTANCE TABLE IS EXHAUSTIVE OVER THE REGISTERED CODES, and the compiler
// holds it there: `INVITE_WIRE_REFUSAL_CODES` is the closed set the corpus registers
// for this plane, and the table is a `Record` over it, so a code registered later
// fails here rather than reaching a person as a bare identifier.

/**
 * Every refusal code the invite plane registers, in the order the corpus lists them.
 *
 * Declared here rather than imported because no contracts-package export carries the
 * set — the codes are registered in the architecture corpus's error table and reach
 * the wire as strings. One home in this console, and both readers below derive from
 * it, so the vocabulary is written once.
 */
export const INVITE_WIRE_REFUSAL_CODES = [
  "invite.not_found",
  "invite.already_accepted",
  "invite.expired",
  "invite.revoked",
  "invite.limit_exceeded",
  "invite.permission_denied",
] as const;

/** One registered invite refusal code. */
export type InviteWireRefusalCode = (typeof INVITE_WIRE_REFUSAL_CODES)[number];

/**
 * What a person can DO about one refusal of the CREATE path, where anything.
 *
 * Deliberately partial: two of these codes name a limit whose remedy is not in the
 * message, and the rest are answered by the wire's own sentence.
 *
 * NO COUNTDOWN, ON EITHER 429. `invite.pending_cap`
 * (`Spec-021 §Canonical Endpoint Group Registry`) is a concurrency cap: capacity
 * frees when a holder releases, so `Spec-021 §Overflow Response` requires the timing
 * pair omitted and there is no reset instant to count down to. The sliding-window
 * rows DO carry one on the wire, and the console still renders none — the refusal
 * reaches this renderer as `{code, message}` (`src/shared/wire-errors.ts`) and no
 * registered envelope in `packages/contracts` carries a retry field to read. A timer
 * counting down from a number the console invented would be worse than the sentence.
 */
export function inviteCreateRemedy(code: string): string | undefined {
  return INVITE_CREATE_REMEDIES[code];
}

const INVITE_CREATE_REMEDIES: Readonly<Record<string, string>> = {
  // The registered 429 for the create path. It covers both limits a mint can hit —
  // how many invitations may be waiting at once, and how quickly they may be minted
  // — and the code does not say which, so the sentence names the remedy that works
  // for either without claiming to know which one was reached.
  "invite.limit_exceeded":
    "Revoke an invitation that is still waiting, or leave it and try again shortly.",
  // The generic rate-limit envelope, which a cap trip arrives in.
  rate_limited: "Revoke an invitation that is still waiting, or leave it and try again shortly.",
  // Owner-only, per `Spec-002 §Invite Revocation` and the permission matrix. The
  // remedy is a person, not a control.
  "invite.permission_denied": "Only an owner of this session can invite someone to it.",
};

/**
 * What one refusal of the ACCEPT path means for the person holding the link.
 *
 * TOTAL over the registered codes, so every one of them reaches a reader as a
 * sentence. `undefined` for anything else — a code this plane does not register is
 * some other subsystem's, and inventing a sentence for it would be the console
 * guessing about a refusal it has never seen.
 */
export function inviteAcceptanceMeaning(code: string): string | undefined {
  return isInviteWireRefusalCode(code) ? INVITE_ACCEPTANCE_MEANINGS[code] : undefined;
}

/** True where a code is one this plane registers. The table's own membership test. */
export function isInviteWireRefusalCode(code: string): code is InviteWireRefusalCode {
  return (INVITE_WIRE_REFUSAL_CODES as readonly string[]).includes(code);
}

const INVITE_ACCEPTANCE_MEANINGS: Readonly<Record<InviteWireRefusalCode, string>> = {
  // 404. Deliberately not "the link is wrong": a control plane answers only about
  // invitations it issued, so a link minted by a different one reads exactly like a
  // mistyped one from here, and the sentence says both rather than picking.
  "invite.not_found":
    "This control plane has no such invitation. The link may be mistyped, or it may have been issued by a different server than the one this window is signed in to.",
  // 409. The invitation worked — possibly for this very person, on another machine —
  // so the sentence points at the session rather than at a failure.
  "invite.already_accepted":
    "This invitation has already been accepted. If that was you, the session is already yours to open.",
  // 410. An expiry is a decision the sender made, so the remedy is the sender.
  "invite.expired":
    "This invitation has passed the date it stops working. Ask whoever sent it for a fresh link.",
  // 410. Withdrawn rather than lapsed, and the two are worth telling apart: one is
  // the clock and the other is a person changing their mind.
  "invite.revoked":
    "Whoever sent this invitation has withdrawn it. Ask them for a fresh link if you still need one.",
  // 429. The only code on this path where trying again is the remedy.
  "invite.limit_exceeded":
    "The control plane is refusing invitation traffic just now. Nothing is wrong with the link — try it again shortly.",
  // 403. On this path the refusal is about who may act, and the answer is a person
  // this reader has to go to rather than a control they can press.
  "invite.permission_denied":
    "This account is not permitted to do that. A session's invitations are issued and withdrawn by its owner.",
};
