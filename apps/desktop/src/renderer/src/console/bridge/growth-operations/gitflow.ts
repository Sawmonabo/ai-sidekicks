// The repo plane's ledger rows: the git action a workspace runs, the gitflow branch
// context and pull-request proposal built on top of it, and the workspace's own
// execution context.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type GitflowOperationId = Extract<
  GrowthOperationId,
  `gitflow${string}` | "gitActionExecute" | "workspaceExecutionContextRead"
>;

/** The repo rows, in the order the single table carried them. */
export const GITFLOW_GROWTH_OPERATIONS: Readonly<Record<GitflowOperationId, GrowthOperationEntry>> =
  {
    gitActionExecute: op(
      "gitActionExecute",
      "gitflow-actions",
      "method",
      "gitflow.gitActionExecute",
    ),
    // gitflow
    gitflowBranchContextRead: op(
      "gitflowBranchContextRead",
      "gitflow-actions",
      "method",
      "gitflow.branchContextRead",
    ),
    // The diff artifact both diff surfaces render. A MUTATION and not a read, which
    // is the registry's own classification and the reason the pane cannot simply ask
    // for a diff: the call MINTS a `diff_artifacts` row and its linked manifest, so a
    // surface asks for one to exist and then reads its payload through the artifact
    // plane — two calls, because the reply carries ids and never bytes.
    gitflowDiffArtifactCreate: op(
      "gitflowDiffArtifactCreate",
      "gitflow-actions",
      "method",
      "gitflow.diffArtifactCreate",
    ),
    gitflowPrPrepare: op("gitflowPrPrepare", "gitflow-actions", "method", "gitflow.prPrepare"),
    // The workspace's own execution context. NO EXPECTED WIRE METHOD, on the
    // identity-and-registry rows' rule rather than as an omission: the corpus registers
    // no read for this at all — the checkout root is a column on a daemon table and the
    // fallback marker is not a field anywhere — so a method string here would be one
    // this console invented.
    workspaceExecutionContextRead: op(
      "workspaceExecutionContextRead",
      "workspace-execution-context",
      "method",
    ),
  };

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const GITFLOW_GROWTH_OPERATION_SUMMARIES: Readonly<Record<GitflowOperationId, string>> = {
  gitActionExecute: "run a git action from the repos and diffs surfaces",
  gitflowBranchContextRead:
    "read the base, head, upstream, and worktree association a writable run executes against, for the repos surface's branch-context summary",
  gitflowDiffArtifactCreate:
    "mint a diff artifact between two named states for one run or one workspace, so the diff pane and the inline diff card have a change set to render",
  gitflowPrPrepare:
    "prepare a reviewable pull-request proposal from the recorded branch context, before any remote mutation",
  workspaceExecutionContextRead:
    "read the normalized checkout root a turn-boundary snapshot operates on and whether the workspace is executing under a substituted fallback mode, for the workspace card's three-path disclosure and its fallback badge",
};
