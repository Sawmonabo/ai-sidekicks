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

import type { WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts";

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

/** Whether this verdict admits a prepare at all, and whether that prepare needs consent. */
export function reuseConsentRequired(verdict: ReuseVerdict): boolean {
  return verdict.kind === "dirty";
}

/** Whether a prepare against this verdict can be sent at all. */
export function reusePreparable(verdict: ReuseVerdict): boolean {
  return verdict.kind !== "incompatible";
}

/** What a prepare form holds. The branch is the only field a writable prepare needs. */
export interface PrepareFormState {
  readonly branchName: string;
  /** The participant's consent to a dirty candidate. Never defaulted on. */
  readonly acknowledgeDirtyCandidate: boolean;
}

/** An empty prepare form: no branch, no consent. */
export const EMPTY_PREPARE_FORM: PrepareFormState = {
  branchName: "",
  acknowledgeDirtyCandidate: false,
};

/** Whether a prepare can be sent, and if not, what is missing. */
export type PrepareFormVerdict =
  | { readonly status: "sendable" }
  | { readonly status: "incomplete"; readonly because: string };

/**
 * Read one prepare form against the reuse verdict it is being sent under.
 *
 * THE BRANCH NAME IS REQUIRED HERE THOUGH THE WIRE MAKES IT OPTIONAL, and the
 * difference is the caller: `branchName` is optional on `ExecutionRootPrepareRequest`
 * because a prepare made by a RUN can derive one, and a prepare made from this surface
 * is pre-run by definition and has nothing to derive it from. Sending without one
 * takes `workspace.branch_name_required`, which is a refusal a person cannot act on
 * without being told what to type.
 *
 * THE CONSENT IS CHECKED AGAINST THE VERDICT AND NOT AGAINST ITSELF, because a
 * consent given for a candidate that is no longer dirty is a consent to nothing — and
 * one withheld for a candidate that is dirty is the whole reason the guard exists.
 * The console never sends the acknowledgement on a verdict that does not call for it.
 */
export function prepareFormVerdict(
  form: PrepareFormState,
  verdict: ReuseVerdict,
): PrepareFormVerdict {
  if (form.branchName.trim().length === 0) {
    return { status: "incomplete", because: "Name the branch this root should check out." };
  }
  if (!reusePreparable(verdict)) {
    return { status: "incomplete", because: REUSE_VERDICT_COPY.incompatible };
  }
  if (reuseConsentRequired(verdict) && !form.acknowledgeDirtyCandidate) {
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
 * flag under a `dirty` verdict, a refresh — another participant committing, say — then
 * settles the candidate `reusable`, the checkbox unmounts with the flag still set, and
 * the act carried a consent to a condition that had gone. Reading the verdict at the
 * moment of the send is what closes it, and a stale `true` is dropped rather than
 * cleared, because clearing it would lose a consent that is still good if the candidate
 * goes dirty again.
 */
export function prepareAcknowledgement(form: PrepareFormState, verdict: ReuseVerdict): boolean {
  return reuseConsentRequired(verdict) && form.acknowledgeDirtyCandidate;
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
 */
export const DISPOSAL_CONSEQUENCE: Readonly<Record<DisposalSubject["kind"], string>> = {
  worktree:
    "The root is recorded retired now; its files are removed by the cleanup sweep afterwards, so a retired root with files still on disk is an ordinary state. Anything uncommitted in that tree goes with them.",
  "ephemeral-clone":
    "The clone is disposed now rather than at its deadline. Its files and anything uncommitted in them are gone; the clone would have reached this same terminal on its own.",
};

/** Build one disposal subject, with the consequence its kind carries. */
export function disposalSubjectFor(kind: DisposalSubject["kind"], rootId: string): DisposalSubject {
  return { kind, rootId, consequence: DISPOSAL_CONSEQUENCE[kind] };
}
