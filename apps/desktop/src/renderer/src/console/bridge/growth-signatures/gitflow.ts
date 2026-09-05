// The repo plane: the git action a workspace runs, and the gitflow branch context
// and pull-request proposal built on top of it.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// section comment below is the file's own, kept with the rows it explains.

import type { GrowthBranchContext, GrowthPrPreparationState } from "../growth-values/index.js";

export interface GitflowGrowthSignatures {
  gitActionExecute: {
    request: { readonly workspaceId: string; readonly action: string };
    value: { readonly accepted: boolean };
  };
  // gitflow
  //
  // The registered request is one of two arms — a `branchContextId`, or a
  // `worktreeId` paired with the `workspaceId` that makes it a key. Only the
  // second is here, because the console holds no `BranchContextId` to ask with:
  // that id is minted by `repo.executionRootPrepare`, a wire the console does not
  // have and no growth row carries, so an arm keyed on it would be a request shape
  // with no caller. The context id travels the other way, on the reply, which is
  // where the proposal gate below gets the one it sends.
  //
  // The value is an ENVELOPE rather than a bare context, so "this workspace has no
  // branch context" is a served answer rather than an absent one. The two facts a
  // repos surface has to tell apart are "nobody asked" (the port's refusal) and
  // "we asked and there is none", and a bare optional value would have collapsed
  // the second into the shape of the first.
  gitflowBranchContextRead: {
    request: { readonly workspaceId: string; readonly worktreeId: string };
    value: { readonly branchContext: GrowthBranchContext | undefined };
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
}
