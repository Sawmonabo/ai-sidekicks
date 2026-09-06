// What a branch context IS, read as something a surface can draw — and nothing else.
//
// THIS MODULE'S RULE, and the console's only home for it: four named values plus a
// worktree association on every writable coding run, and no inferring base or
// head from a pane, a tab, or a focused view. Both halves live here: the shape that
// carries the four values, and the one function that reads which root a context is
// bound to. Nothing in this module computes a branch name.
//
// THE SHAPE IS THE CONSOLE'S OWN, AND SAYS SO. `packages/contracts` registers no
// `gitflow` module: there is no `baseBranch`, no `headBranch`, and no `upstreamRef`
// anywhere in the workspace — only `BranchContextId`, a branded scalar `worktree.ts`
// mints and `ExecutionRootPrepareResponse` carries. So this is the shape the SURFACE
// needs, derived from what this family renders, exactly as `bridge/growth-port/growth-port.ts`
// derives its request and value types; it is not a claim about the eventual wire,
// which `Spec-011` owns. The one vocabulary imported rather than invented is
// `ExecutionMode`, because the mode is what decides whether a writable context exists
// at all and the contract already closes it at four.
//
// IT LIVES BESIDE `prepared-proposal.ts` RATHER THAN INSIDE IT because a branch context
// outlives any one proposal: a writable run has one whether or not a proposal has been
// prepared, which is why the gate can render a context with no proposal and never the
// reverse. One module per noun, and this is the other noun.

import type { ExecutionMode } from "@ai-sidekicks/contracts";

// --- The branch context -----------------------------------------------------

/**
 * The four named values this module requires, plus the association that makes them
 * actionable.
 *
 * `branchContextId` is spelled as a plain string rather than as the contract's
 * `BranchContextId` brand for the reason `repo-reads.ts` records about `SessionId`:
 * the console never MINTS one, it forwards the opaque value it was handed, and a
 * brand on a display shape would claim this file validated something it did not.
 */
export interface BranchContextReading {
  readonly branchContextId: string;
  /** Where the change lands. Wire-verbatim; never inferred from the selected pane. */
  readonly baseBranch: string;
  /** What is proposed. Wire-verbatim; never inferred from the selected pane. */
  readonly headBranch: string;
  /** The tracking ref, where one is set. Absence means no upstream, not an unread field. */
  readonly upstreamRef?: string | undefined;
  /** The workspace's selected mode, which decides which association below is lawful. */
  readonly executionMode: ExecutionMode;
  readonly worktreeId?: string | undefined;
  readonly ephemeralCloneId?: string | undefined;
}

/**
 * What a branch context is bound to. Closed at three, and the third is the one that
 * is easy to render wrong: `branch` mode carries NEITHER id, and drawing an empty
 * association slot beside it would read as a missing value rather than as the mode's
 * own answer.
 */
export const BRANCH_CONTEXT_ASSOCIATIONS = ["worktree", "ephemeral-clone", "in-place"] as const;

/** One association. Derived, so the vocabulary is declared exactly once. */
export type BranchContextAssociation = (typeof BRANCH_CONTEXT_ASSOCIATIONS)[number];

/**
 * One association, ready to draw: which kind, the id where the kind has one, and the
 * sentence that says what the binding means.
 */
export interface BranchContextAssociationReading {
  readonly association: BranchContextAssociation;
  readonly label: string;
  /** The bound id, wire-verbatim. Absent on `in-place`, which binds no separate root. */
  readonly boundId?: string | undefined;
  readonly meaning: string;
}

/**
 * Read a context's association off the mode and the two ids.
 *
 * MODE FIRST, ids second. The ids are plain-optional on the wire because which set is
 * lawful depends on the selected mode and no schema can see it, so reading the ids
 * first would let a stale `worktreeId` on a re-selected `branch`-mode context decide
 * the answer. Reading the mode first makes the mode the answer and the id the detail.
 */
export function branchContextAssociationReading(
  context: BranchContextReading,
): BranchContextAssociationReading {
  if (context.executionMode === "worktree") {
    return {
      association: "worktree",
      label: "Worktree",
      boundId: context.worktreeId,
      meaning: "This context executes in a dedicated checkout on this node.",
    };
  }
  if (context.executionMode === "ephemeral clone") {
    return {
      association: "ephemeral-clone",
      label: "Ephemeral clone",
      boundId: context.ephemeralCloneId,
      meaning: "This context executes in a clone the daemon disposes of on its own schedule.",
    };
  }
  return {
    association: "in-place",
    label: "In place",
    meaning: "This context executes in the mount's own checkout and binds no separate root.",
  };
}
