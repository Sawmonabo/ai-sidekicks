// The gitflow plane's values: a writable run's branch context, the request that mints
// a diff artifact, and the closed set a pull request is prepared in.
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
 * question, and `repos/proposals/proposal-gate-model.ts` answers it once as a read plan — the
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

/**
 * How the registered diff-artifact create is KEYED — one of exactly two arms.
 *
 * `docs/architecture/contracts/api-payload-contracts.md` registers
 * `DiffArtifactCreateRequest` as a union discriminated on `attributionMode`, and the
 * discriminant is what decides which workspace-resolver key is present: the
 * `run_attributed` arm carries a run and no workspace, the `workspace_fallback` arm a
 * workspace and no run. That is the wire's own refinement of the `{runId XOR
 * workspaceId}` invariant and it mirrors the at-rest CHECK behind it, so the union is
 * transcribed rather than flattened into two optional members — which would admit a
 * request carrying both keys and one carrying neither, the two shapes no producer
 * resolves.
 *
 * IT IS ALSO WHAT KEEPS THE RENDERER HONEST ONE LAYER UP. `Spec-011 §Pitfalls To
 * Avoid` names pretending a workspace diff is run-attributed; with the mode on the
 * REQUEST there is no shape in which a caller asks for a workspace diff and receives
 * something it may label with a run, because the arm it sent is the arm it gets back.
 *
 * BOTH REFS ARE REQUIRED ON BOTH ARMS. `Spec-011 §Interfaces And Contracts` requires
 * the create call to identify the compared states, so a create with one side missing
 * is a request the contract does not have — the caller names both or sends nothing.
 */
export type GrowthDiffArtifactCreateRequest =
  | {
      readonly attributionMode: "run_attributed";
      readonly runId: string;
      readonly baseRef: string;
      readonly headRef: string;
    }
  | {
      readonly attributionMode: "workspace_fallback";
      readonly workspaceId: string;
      readonly baseRef: string;
      readonly headRef: string;
    };

/**
 * What a minted diff artifact answers with: two ids and the instant it was minted.
 *
 * THREE MEMBERS AND NO PAYLOAD, which is the whole reason a diff costs two calls. The
 * registered response carries `diffArtifactId`, `artifactManifestId` and `createdAt`;
 * the computed diff is the payload of the manifest this call MINTS, so the bytes are
 * reached through the artifact plane's own read and never on this reply. A signature
 * that carried patch text here would be a shape no daemon can send.
 */
export interface GrowthDiffArtifactCreated {
  readonly diffArtifactId: string;
  /** The manifest the minted payload hangs off. The key the payload read takes. */
  readonly artifactManifestId: string;
  readonly createdAt: string;
}
