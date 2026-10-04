// What a reuse check said, and what a prepare form needs. Pure. The check's three booleans
// combine into different situations: no candidate (the prepare creates a root), a dirty
// candidate (the one case `acknowledgeDirtyCandidate` exists for), and an incompatible
// candidate (no override, since the daemon will not bind it under any acknowledgement).
// Collapsing the last two would offer consent for a refusal that consent does not lift. An
// unanswered check is a fourth situation, so the form reads a standing, not a bare verdict.

import type { WorktreeReuseCheckResponse } from "@ai-sidekicks/contracts/worktree";

import type { ActPrerequisiteReading } from "../../acts/act-reading.js";

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
 * The one verdict that carries a consent. The acknowledgement is recorded against `worktreeId`,
 * so a refresh that replaces one dirty checkout of a branch with another cannot inherit it.
 */
export type DirtyReuseCandidate = Extract<ReuseVerdict, { readonly kind: "dirty" }>;

/**
 * Read one reuse reply into the verdict a control can act on. Incompatible is tested before
 * dirty, so a candidate that is both never offers a consent whose press is already decided. An
 * absent `compatible` is not read as compatible: a candidate the reply declines to clear has not
 * been cleared.
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

/** What a prepare form holds. The branch is the only field a writable prepare needs. */
export interface PrepareFormState {
  readonly branchName: string;
  /**
   * The dirty candidate this user consented to, or `undefined` for none. An id, not a flag: a
   * refresh can retire one dirty checkout and serve another for the same branch, and a flag
   * would carry the consent across. A served candidate that is not this one matches nothing.
   */
  readonly acknowledgedCandidateId: string | undefined;
}

/**
 * Whether this verdict needs a consent, narrowing to the candidate that carries one, so the
 * control, the reader and the act need not each re-test `kind`.
 */
export function reuseConsentRequired(verdict: ReuseVerdict): verdict is DirtyReuseCandidate {
  return verdict.kind === "dirty";
}

/** Whether a prepare against this verdict can be sent at all. */
export function reusePreparable(verdict: ReuseVerdict): boolean {
  return verdict.kind !== "incompatible";
}

/** An empty prepare form: no branch, no consent. */
export const EMPTY_PREPARE_FORM: PrepareFormState = {
  branchName: "",
  acknowledgedCandidateId: undefined,
};

/**
 * Where the reuse question stands for the branch the form holds. Two facts, because "nothing to
 * reuse" and "no answer yet" both leave `verdict` at `none`, and only `answered` separates a
 * prepare that may be sent from one that would be guessing.
 */
export interface ReuseCheckState {
  /** Whether the reuse question has an answer this form may be sent against. */
  readonly answered: boolean;
  /** The candidate the newest answer named, or `none` where there is none to act on. */
  readonly verdict: ReuseVerdict;
}

/** The verdict wherever no candidate is on the table. */
const NO_REUSE_CANDIDATE: ReuseVerdict = { kind: "none" };

/** Whether a prepare can be sent, and if not, what is missing. */
export type PrepareFormVerdict =
  | { readonly status: "sendable" }
  | { readonly status: "incomplete"; readonly because: string };

/** Read the reuse half of a prepare reading into a standing; anything unanswered holds the form. */
export function readReuseCheckState(
  reading: ActPrerequisiteReading<ReuseVerdict>,
): ReuseCheckState {
  switch (reading.status) {
    case "read":
      return { answered: true, verdict: reading.value };
    case "not-read":
    case "reading":
    case "refused":
      return { answered: false, verdict: NO_REUSE_CANDIDATE };
  }
}

/** The sentence a form held shut by a reuse check that has not come back puts on screen. */
export const REUSE_UNANSWERED_COPY =
  "The reuse check for that branch has not answered yet. Preparing before it does could take a live checkout without asking.";

/**
 * Read one prepare form against the reuse standing it is sent under. The branch is required
 * here though optional on the wire, because only a run can derive one; sending without it is
 * rejected with `workspace.branch_name_required`. Git's own rule judges the name, so the form
 * sets no length. An unanswered check holds the control
 * shut, since a prepare sent inside the debounce window would omit `reuseWorktreeId` for a
 * branch that has a candidate, an implicit collision the daemon refuses. The consent is checked
 * against the verdict, so one given for a candidate that has stopped being dirty is ignored.
 */
export function resolvePrepareForm(
  form: PrepareFormState,
  standing: ReuseCheckState,
): PrepareFormVerdict {
  if (form.branchName.trim().length === 0) {
    return { status: "incomplete", because: "Name the branch this root should check out." };
  }
  if (!standing.answered) {
    return { status: "incomplete", because: REUSE_UNANSWERED_COPY };
  }
  if (!reusePreparable(standing.verdict)) {
    return { status: "incomplete", because: REUSE_VERDICT_COPY.incompatible };
  }
  if (reuseConsentRequired(standing.verdict) && !isDirtyReuseAcknowledged(form, standing.verdict)) {
    return {
      status: "incomplete",
      because: "Confirm that you are reusing a checkout with uncommitted changes in it.",
    };
  }
  return { status: "sendable" };
}

/**
 * The acknowledgement this prepare may carry: none unless the verdict asks for one. It compares
 * the candidate's own id at the moment of the send, so a consent left over from a candidate that
 * has since become reusable, or from a different tree, is dropped and not sent. It is dropped
 * rather than cleared, because it stays good if the same candidate goes dirty again. The consent
 * control reads it for its checked state, so the box and the wire member cannot disagree.
 */
export function isDirtyReuseAcknowledged(form: PrepareFormState, verdict: ReuseVerdict): boolean {
  return reuseConsentRequired(verdict) && form.acknowledgedCandidateId === verdict.worktreeId;
}
