// What a reuse check said, what a prepare form needs, and what disposal costs.
//
// PURE. Everything here is a function of a reply or of what a participant typed;
// nothing reaches a bridge, holds a lifetime, or decides eligibility.
//
// THE REUSE CHECK'S THREE BOOLEANS ARE NOT THREE INDEPENDENT FACTS, and reading them
// as though they were is the defect this module exists to prevent. `Spec-010
// §Interfaces And Contracts` puts `available`, `isClean`, and `compatible` on the reply
// as DECIDED verdicts rather than as raw git state, and the combinations they form are
// three different situations with three different next moves:
//
//   • NO CANDIDATE. `available: false`. There is nothing to reuse and nothing to
//     consent to; the prepare creates a root.
//   • A DIRTY CANDIDATE. Live, compatible, and carrying uncommitted work. This is the
//     ONE case `acknowledgeDirtyCandidate` exists for — the participant is consenting
//     to run in a tree that is not clean, and the consent is a separate act from
//     naming the candidate, which is why the wire carries two members and not one.
//   • AN INCOMPATIBLE CANDIDATE. Live and unusable. There is NO override: the daemon
//     will not bind it under any acknowledgement, so a surface that offered one would
//     be offering a control that cannot work.
//
// COLLAPSING THE LAST TWO IS THE FAILURE MODE. Both are "there is a checkout and you
// cannot just take it", and a single "reuse anyway?" prompt over both would offer
// consent for a refusal that consent does not lift — and would train a person to press
// through a guard that is sometimes real.
//
// AND A VERDICT NOBODY HAS ANSWERED YET IS ITS OWN SITUATION, which is why the form is
// read against a STANDING rather than against a verdict. Folding "the check has not
// come back" into "there is no candidate" makes the two indistinguishable, and they are
// the opposite of each other: one is a decided negative the prepare may be sent on, and
// the other is a question still on the wire whose answer decides whether the prepare
// carries a candidate at all. Sending under the second omits `reuseWorktreeId` against a
// branch that has one, which the daemon meets as an implicit collision.
//
// TYPE-ONLY, SO THIS MODULE IS STILL PURE. The reading's four states are declared in
// `store/act-reading.ts` and named here as a type; nothing below reaches a controller,
// a bridge, or a lifetime.

import { WORKTREE_GIT_REF_MAX_LEN, type WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts";

import type { ActPrerequisiteReading } from "../../../store/index.js";

/** What the reuse check found, split by what a person can do about it. */
export type ReuseVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "reusable"; readonly worktreeId: string }
  | { readonly kind: "dirty"; readonly worktreeId: string; readonly reason: string | undefined }
  | {
      readonly kind: "incompatible";
      readonly worktreeId: string;
      readonly reason: string | undefined;
    };

/**
 * The one verdict that carries a consent, named so a control can hold its candidate.
 *
 * A CONSENT BELONGS TO A TREE AND NOT TO A BRANCH, which is why this arm is named at
 * all: the acknowledgement a participant gives is recorded against `worktreeId`, so a
 * lifecycle refresh that replaces one dirty checkout of a branch with a DIFFERENT dirty
 * checkout of the same branch cannot inherit it.
 */
export type DirtyReuseCandidate = Extract<ReuseVerdict, { readonly kind: "dirty" }>;

/**
 * Read one reuse reply into the verdict a control can act on.
 *
 * INCOMPATIBLE IS TESTED BEFORE DIRTY, and the order is the claim: a candidate that is
 * both dirty and incompatible cannot be taken at all, so offering the dirty consent
 * for it would put a control on screen whose press is already decided. The reverse
 * order would have made that combination reachable.
 *
 * AN ABSENT `compatible` IS NOT READ AS COMPATIBLE. The three verdict members are
 * optional on the wire because they are meaningless when nothing is available, so a
 * reply that says a candidate exists and declines to say whether it is usable has not
 * cleared it — reading the absence as permission would consent on the daemon's behalf.
 */
export function reuseVerdictFor(reply: WorktreeReuseCheckResponse): ReuseVerdict {
  if (!reply.available || reply.worktreeId === undefined) {
    return { kind: "none" };
  }
  if (reply.compatible !== true) {
    return { kind: "incompatible", worktreeId: reply.worktreeId, reason: reply.reason };
  }
  if (reply.isClean !== true) {
    return { kind: "dirty", worktreeId: reply.worktreeId, reason: reply.reason };
  }
  return { kind: "reusable", worktreeId: reply.worktreeId };
}

/** The sentence each verdict puts on screen, above whatever control it earns. */
export const REUSE_VERDICT_COPY: Readonly<Record<ReuseVerdict["kind"], string>> = {
  none: "No live checkout of that branch exists on this mount. Preparing creates one.",
  reusable: "A clean, compatible checkout of that branch already exists. Preparing reuses it.",
  dirty:
    "A compatible checkout of that branch exists and has uncommitted changes in it. Reusing it runs in that tree as it stands; nothing is stashed, committed, or discarded.",
  incompatible:
    "A checkout of that branch exists and cannot be bound. This is not a consent you can give — prepare under a different branch name, or retire that root first.",
};

/**
 * Whether this verdict needs a consent, narrowing to the candidate that carries one.
 *
 * A TYPE PREDICATE RATHER THAN A BOOLEAN, because every caller that asks the question
 * then needs the candidate's own id — the control that records the consent, the reader
 * that decides whether a recorded one still applies, and the act that sends it. Handing
 * back the narrowing is what keeps those three from each re-testing `kind` by hand.
 */
export function reuseConsentRequired(verdict: ReuseVerdict): verdict is DirtyReuseCandidate {
  return verdict.kind === "dirty";
}

/** Whether a prepare against this verdict can be sent at all. */
export function reusePreparable(verdict: ReuseVerdict): boolean {
  return verdict.kind !== "incompatible";
}

/** What a prepare form holds. The branch is the only field a writable prepare needs. */
export interface PrepareFormState {
  readonly branchName: string;
  /**
   * The dirty candidate this participant consented to, or `undefined` for no consent.
   *
   * AN ID RATHER THAN A BOOLEAN, and the difference is a defect this form used to carry.
   * A flag records THAT a consent was given and not WHAT it was given for, so the only
   * thing that could retire one was an edit to the branch TEXT — and the candidate a
   * branch resolves to is not a function of that text. A lifecycle refresh retires one
   * dirty checkout and serves another for the same branch, the flag survives untouched
   * because nothing a person typed changed, and the prepare sends the NEW worktree's id
   * under a consent read for the old one. Holding the id makes the consent apply to one
   * tree by construction: a served candidate that is not this one matches nothing.
   */
  readonly acknowledgedCandidateId: string | undefined;
}

/** An empty prepare form: no branch, no consent. */
export const EMPTY_PREPARE_FORM: PrepareFormState = {
  branchName: "",
  acknowledgedCandidateId: undefined,
};

/**
 * Where the reuse question stands for the branch the form currently holds.
 *
 * TWO FACTS AND NOT ONE, because a control has to distinguish "the answer says there is
 * nothing to reuse" from "there is no answer". Both leave `verdict` at `none` — there is
 * no candidate to name in either — and only `answered` separates a prepare that may be
 * sent from one that would be guessing.
 */
export interface PrepareReuseStanding {
  /** Whether the reuse question has an answer this form may be sent against. */
  readonly answered: boolean;
  /** The candidate the newest answer named, or `none` where there is none to act on. */
  readonly verdict: ReuseVerdict;
}

/** The standing's verdict wherever there is no candidate on the table to act on. */
const NO_REUSE_CANDIDATE: ReuseVerdict = { kind: "none" };

/**
 * Read the reuse half of one prepare reading into the standing a form is read against.
 *
 * A MODE THAT REUSES NOTHING IS ANSWERED, NOT UNANSWERED. An ephemeral clone is minted
 * per run and no check is ever asked for one, so its reading sits at `not-read` forever;
 * treating that as a question in flight would close the clone control permanently.
 *
 * A REFUSED CHECK IS AN ANSWER TOO, and deliberately does not hold the form shut. The
 * refusal is drawn under the field with its own recovery, the check cannot be forced
 * from here, and the prepare's own typed refusal — `worktree.branch_collision` — is the
 * backstop for the collision this guard exists to avoid walking into blind. Blocking on
 * it would close the control for a branch that has no candidate at all, on the strength
 * of an outage in a different call.
 */
export function prepareReuseStanding(
  reading: ActPrerequisiteReading<ReuseVerdict>,
  reusesCandidates: boolean,
): PrepareReuseStanding {
  if (!reusesCandidates) {
    return { answered: true, verdict: NO_REUSE_CANDIDATE };
  }
  switch (reading.status) {
    case "read":
      return { answered: true, verdict: reading.value };
    case "refused":
      return { answered: true, verdict: NO_REUSE_CANDIDATE };
    case "not-read":
    case "reading":
      return { answered: false, verdict: NO_REUSE_CANDIDATE };
  }
}

/** Whether a prepare can be sent, and if not, what is missing. */
export type PrepareFormVerdict =
  | { readonly status: "sendable" }
  | { readonly status: "incomplete"; readonly because: string };

/** The sentence a form held shut by a reuse check that has not come back puts on screen. */
export const REUSE_UNANSWERED_COPY =
  "The reuse check for that branch has not answered yet. Preparing before it does could take a live checkout without asking.";

/**
 * Read one prepare form against the reuse standing it is being sent under.
 *
 * THE BRANCH NAME IS REQUIRED HERE THOUGH THE WIRE MAKES IT OPTIONAL, and the
 * difference is the caller: `branchName` is optional on `ExecutionRootPrepareRequest`
 * because a prepare made by a RUN can derive one, and a prepare made from this surface
 * is pre-run by definition and has nothing to derive it from. Sending without one
 * takes `workspace.branch_name_required`, which is a refusal a person cannot act on
 * without being told what to type.
 *
 * THE LENGTH IS THE CONTRACT'S OWN AND IS MEASURED IN CODE UNITS, exactly as the attach
 * and bind forms measure theirs: `WORKTREE_GIT_REF_MAX_LEN` is a Zod `max` on the
 * string, so this guard is exact rather than approximate, and it reads the UNTRIMMED
 * text because that is what the request carries. Both prepare requests bound the member,
 * so without it the control is open onto a schema failure naming a member path.
 *
 * AN UNANSWERED CHECK HOLDS THE CONTROL SHUT, which is the guard the `reading` state
 * used to be missing: it folded into a no-candidate verdict, the form was sendable the
 * instant a branch was typed, and a prepare sent inside the debounce window omitted
 * `reuseWorktreeId` for a branch that had a candidate — an implicit collision the daemon
 * refuses, which can leave the workspace `stale`.
 *
 * THE CONSENT IS CHECKED AGAINST THE VERDICT AND NOT AGAINST ITSELF, because a
 * consent given for a candidate that is no longer dirty is a consent to nothing — and
 * one withheld for a candidate that is dirty is the whole reason the guard exists.
 * The console never sends the acknowledgement on a verdict that does not call for it.
 */
export function prepareFormVerdict(
  form: PrepareFormState,
  standing: PrepareReuseStanding,
): PrepareFormVerdict {
  if (form.branchName.trim().length === 0) {
    return { status: "incomplete", because: "Name the branch this root should check out." };
  }
  if (form.branchName.length > WORKTREE_GIT_REF_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That branch name is ${String(form.branchName.length)} characters. The wire accepts ${String(WORKTREE_GIT_REF_MAX_LEN)}.`,
    };
  }
  if (!standing.answered) {
    return { status: "incomplete", because: REUSE_UNANSWERED_COPY };
  }
  if (!reusePreparable(standing.verdict)) {
    return { status: "incomplete", because: REUSE_VERDICT_COPY.incompatible };
  }
  if (reuseConsentRequired(standing.verdict) && !prepareAcknowledgement(form, standing.verdict)) {
    return {
      status: "incomplete",
      because: "Confirm that you are reusing a checkout with uncommitted changes in it.",
    };
  }
  return { status: "sendable" };
}

/**
 * The acknowledgement this prepare may carry, which is none unless the verdict asks.
 *
 * THE RULE ABOVE, MADE INTO A VALUE RATHER THAN LEFT AS A SENTENCE. `prepareFormVerdict`
 * reads the consent to decide whether the form may be sent; this decides what is sent,
 * and until it existed the two disagreed on one reachable state: the checkbox sets the
 * consent under a `dirty` verdict, a refresh — another participant committing, say —
 * then settles the candidate `reusable`, the checkbox unmounts with the consent still
 * recorded, and the act carried a consent to a condition that had gone. Reading the
 * verdict at the moment of the send is what closes it, and a stale consent is dropped
 * rather than cleared, because clearing it would lose one that is still good if that
 * same candidate goes dirty again.
 *
 * AND IT IS THE CANDIDATE'S OWN ID THAT IS COMPARED, which closes the second half of
 * the same defect: the verdict can stay `dirty` across a refresh and still be about a
 * DIFFERENT tree. `Spec-010`'s pair travels together or not at all, so a consent that
 * names no tree, or names one the daemon is no longer offering, sends nothing.
 *
 * DOUBLE DUTY, DELIBERATELY: this is also what a consent control reads for its own
 * checked state, so the box on screen and the member on the wire cannot disagree.
 */
export function prepareAcknowledgement(form: PrepareFormState, verdict: ReuseVerdict): boolean {
  return reuseConsentRequired(verdict) && form.acknowledgedCandidateId === verdict.worktreeId;
}

/** What one disposal is about, and the consequence its confirmation must state. */
export interface DisposalSubject {
  /** Which of the two roots this is. Decides which call the act sends. */
  readonly kind: "worktree" | "ephemeral-clone";
  /** The root's own id, sent verbatim. */
  readonly rootId: string;
  /** What the person is agreeing to. Different for the two kinds, so it is not shared. */
  readonly consequence: string;
}

/**
 * The consequence sentence for each kind of root, stated as the daemon models it.
 *
 * THE TWO ARE NOT THE SAME ACT AND DO NOT SHARE A SENTENCE. Retiring a worktree
 * RECORDS a transition — the row and its event land before any disk mutation and the
 * sweep stamps the cleanup afterwards — so files on disk after a retire is an ordinary
 * state rather than a failure. Disposing a clone is the terminal a clone reaches
 * anyway under `on_run_complete`, so the sentence must not imply the clone would have
 * survived; what disposal changes is WHEN.
 *
 * BOTH SENTENCES ARE RECORDED-THEN-CLEANED, AND THE CLONE'S USED NOT TO BE. It said the
 * files were already gone, and they are not: `EphemeralCloneDisposeResponse.state` is
 * the single literal `retired` and carries no cleanup instant, because dispose records
 * the transition and the sweep removes the disk afterwards — I-010-9's ordering, which
 * this method shares with retire. A consequence claiming the bytes are gone is the
 * renderer answering a question the daemon deliberately did not, on the one screen
 * where a person is agreeing to it, and it makes the ordinary post-dispose state — a
 * disposed clone whose files are still there — read as a failure.
 */
export const DISPOSAL_CONSEQUENCE: Readonly<Record<DisposalSubject["kind"], string>> = {
  worktree:
    "The root is recorded retired now; its files are removed by the cleanup sweep afterwards, so a retired root with files still on disk is an ordinary state. Anything uncommitted in that tree goes with them.",
  "ephemeral-clone":
    "The clone is recorded disposed now rather than at its deadline; its files are removed by the cleanup sweep afterwards, so a disposed clone with files still on disk is an ordinary state. Anything uncommitted in that tree goes with them, and the clone would have reached this same terminal on its own.",
};

/** Build one disposal subject, with the consequence its kind carries. */
export function disposalSubjectFor(kind: DisposalSubject["kind"], rootId: string): DisposalSubject {
  return { kind, rootId, consequence: DISPOSAL_CONSEQUENCE[kind] };
}
