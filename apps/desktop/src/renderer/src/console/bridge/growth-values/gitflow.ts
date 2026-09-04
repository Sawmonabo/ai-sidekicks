// The gitflow plane's values: a writable run's branch context, and the closed set a
// pull request is prepared in.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

/**
 * How the registered branch-context read is KEYED — one of exactly two arms.
 *
 * `docs/architecture/contracts/api-payload-contracts.md` gives `BranchContextRead` a
 * `branchContextId`, or a `worktreeId` paired with the `workspaceId` that makes it a
 * key: a context is upserted per `(workspace, worktree)` binding while the worktree id
 * is retained across workspaces, so the worktree alone is 1:N and the PAIR is what
 * resolves one row. Both arms are declared because both are registered and this port
 * mirrors registered shapes; which of them a caller can fill is the caller's own
 * question, and `repos/proposal-gate-model.ts` answers it once as a read plan — the
 * console holds no `BranchContextId`, because that id is minted by
 * `repo.executionRootPrepare`, a wire no growth row carries.
 *
 * A UNION RATHER THAN TWO OPTIONAL MEMBERS, on the registered refinement's own terms:
 * optional members would admit a request carrying both keys and one carrying neither,
 * which are the two shapes no producer resolves.
 */
export type GrowthBranchContextReadRequest =
  | { readonly branchContextId: string }
  | { readonly workspaceId: string; readonly worktreeId: string };

/**
 * A writable run's branch context, as `Spec-011 §Interfaces And Contracts`
 * requires the read to expose it — base, head, upstream, and worktree association.
 *
 * THIS IS THE WHOLE REPLY AND NEVER A MEMBER OF ONE. `BranchContextReadResponse`
 * returns these fields directly, so the operation's value is this interface itself:
 * a signature that wrapped it in a `{ branchContext }` envelope made every
 * contract-shaped reply read as an absent context, which published the no-context arm
 * and withheld the proposal actions on exactly the sessions that had a context. Where
 * a pair resolves no row the registered read REFUSES — `worktree.not_found` /
 * `workspace.not_found` — so the absence is a refusal a surface renders and never an
 * `undefined` riding a served reply.
 *
 * The three optional members are optional on the wire for structural reasons, not
 * for convenience, and the reasons are worth carrying: `upstreamRef` is absent
 * until the head branch has one, and `worktreeId` / `ephemeralCloneId` are present
 * only on the anchoring their context actually has (`branch_contexts` carries an
 * at-most-one association CHECK). A required member here would force a producer to
 * supply a value for an anchoring the context does not have, and the only value it
 * could supply is a fabrication.
 */
export interface GrowthBranchContext {
  readonly branchContextId: string;
  readonly workspaceId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly upstreamRef?: string;
  readonly worktreeId?: string;
  readonly ephemeralCloneId?: string;
}

/**
 * The states a prepared pull request is in. Closed, declared once, derived below.
 *
 * `Spec-011 §Required Behavior` makes PR preparation reviewable BEFORE any remote
 * mutation, and these two are what that review is between: a proposal still being
 * assembled and one a person may send. Neither names a remote state — nothing here
 * has talked to a git host.
 */
export const GROWTH_PR_PREPARATION_STATES = ["draft", "ready"] as const;

/** One prepared-pull-request state. Derived, so the vocabulary has one home. */
export type GrowthPrPreparationState = (typeof GROWTH_PR_PREPARATION_STATES)[number];
