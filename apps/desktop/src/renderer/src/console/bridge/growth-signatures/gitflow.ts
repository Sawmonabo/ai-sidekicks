// The repo plane: the git action a workspace runs, the gitflow branch context and
// pull-request proposal built on top of it, and the workspace's own execution context.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section comment below is the file's own, kept with the rows it explains.

import type {
  GrowthBranchContext,
  GrowthBranchContextReadRequest,
  GrowthPrPreparationState,
} from "../growth-values/index.js";

export interface GitflowGrowthSignatures {
  // THE REGISTERED SHAPE, MEMBER FOR MEMBER, and the correction is structural rather
  // than cosmetic: this row carried `{ workspaceId, action } -> { accepted }`, and
  // `docs/architecture/contracts/api-payload-contracts.md` registers
  // `GitActionExecuteRequest` as `{ repoMountId, action, params, causationRunId?,
  // causationParticipantId? }` answering `{ success, output?, error? }`. `workspaceId`
  // is on NEITHER side of that contract, `params` is required rather than optional, and
  // `accepted` was never a reply member at all — so every act this console sent would
  // have been refused by a contract-valid daemon before it ran, on a shape no test
  // could have caught while the fixture was the only reader.
  //
  // `params` IS REQUIRED AND ITS CONTENT IS THE CALLER'S. The wire types it
  // `Record<string, unknown>` — the action vocabulary is unregistered, so the daemon
  // cannot type the parameters of an action it has not named — which makes the members
  // a caller's to state and to justify. `repos/proposals/git-action-request.ts` is where this
  // console states them, per act, from the branch context it read; nothing here
  // defaults it, because a default would be a parameter no read supplied.
  //
  // BOTH CAUSATION MEMBERS ARE OPTIONAL AND MEAN IT. They are attribution the caller
  // offers, not the authority the act runs under — the daemon resolves its own
  // principal — so an unread identity omits the member rather than blocking the act or
  // sending a placeholder, and a surface with no run in view omits the run.
  gitActionExecute: {
    request: {
      readonly repoMountId: string;
      readonly action: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly causationRunId?: string;
      readonly causationParticipantId?: string;
    };
    value: {
      readonly success: boolean;
      /** Diagnostic text from the act. Rendered nowhere and scraped nowhere. */
      readonly output?: string;
      /** Why a `success: false` act did not happen. Rendered verbatim, never paraphrased. */
      readonly error?: string;
    };
  };
  // gitflow
  //
  // BOTH REGISTERED SHAPES, VERBATIM. The request is the two-arm union
  // `BranchContextRead` is keyed by and the value is `BranchContextReadResponse`
  // itself — flat, with the context's fields directly on it. An earlier signature
  // narrowed the request to one arm and wrapped the value in a `{ branchContext }`
  // envelope, and the envelope was the expensive half: a contract-shaped reply made
  // the reader's `outcome.value.branchContext` evaluate to `undefined`, so every gate
  // published the no-context arm and withheld its proposal actions on exactly the
  // sessions that had a context.
  //
  // THERE IS NO SERVED ABSENCE HERE, and that is the registered read's own shape
  // rather than a simplification: a `(workspaceId, worktreeId)` pair that resolves no
  // row is a refusal — `worktree.not_found` / `workspace.not_found` — so "we asked and
  // there is none" arrives as a refusal a surface renders, and "nobody asked" is the
  // port's own. The two facts stay apart without an envelope to carry one of them.
  gitflowBranchContextRead: {
    request: GrowthBranchContextReadRequest;
    value: GrowthBranchContext;
  };
  gitflowPrPrepare: {
    request: {
      readonly branchContextId: string;
      readonly targetBranch: string;
      readonly title?: string;
      readonly description?: string;
    };
    value: {
      readonly prPreparationId: string;
      readonly state: GrowthPrPreparationState;
      readonly proposalBlob: Readonly<Record<string, unknown>>;
    };
  };
  // The workspace execution context.
  //
  // THREE ROOTS AND A MARKER, and the three roots are three facts rather than one
  // repeated: `Spec-010 §Turn-Boundary Snapshots` separates the workspace's BOUND root
  // from the NORMALIZED CHECKOUT root the snapshot service operates on, and the mount's
  // own resolved root is a third that neither is derived from — in `branch` mode all
  // three can differ. The mount root is not on this reply because the console already
  // holds it from `repo.mountRead`; asking for it twice would be two answers to one
  // question, and the disclosure that draws all three composes them.
  //
  // `checkoutRoot` IS OPTIONAL BECAUSE IT IS RUN-BORNE. The column that holds it is
  // captured per run, so a workspace that has hosted no run has no normalized checkout
  // root yet — an absence the disclosure renders as such rather than as the bound root
  // standing in for it.
  //
  // `fallbackFromMode` IS THE MARKER, and it is the SUPERSEDED mode rather than a
  // boolean, because the badge has to say what was substituted away from. Absent means
  // the workspace is running the mode that was selected, which is the ordinary case.
  // `Spec-010 §Fallback Behavior` requires the selected mode to be marked distinctly
  // from normal worktree mode, and a boolean would mark it without saying from what.
  workspaceExecutionContextRead: {
    request: { readonly workspaceId: string };
    value: {
      readonly workspaceId: string;
      readonly boundRoot: string;
      readonly checkoutRoot?: string;
      readonly fallbackFromMode?: string;
    };
  };
}
