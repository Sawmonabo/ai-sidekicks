// The repo plane's ledger rows: the git action a workspace runs, and the gitflow
// branch context and pull-request proposal built on top of it.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`. The section
// comment below is the single table's own, kept with the rows it heads.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-entry.js";
import { op } from "./operation-entry.js";

/** The repo rows, in the order the single table carried them. */
/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type GitflowOperationId = Extract<GrowthOperationId, `gitflow${string}` | "gitActionExecute">;

export const GITFLOW_GROWTH_OPERATIONS: Readonly<Record<GitflowOperationId, GrowthOperationEntry>> =
  {
    gitActionExecute: op(
      "gitActionExecute",
      "gitflow-actions",
      "method",
      "run a git action from the repos and diffs surfaces",
      "gitflow.gitActionExecute",
    ),
    // gitflow
    gitflowBranchContextRead: op(
      "gitflowBranchContextRead",
      "gitflow-actions",
      "method",
      "read the base, head, upstream, and worktree association a writable run executes against, for the repos surface's branch-context summary",
      "gitflow.branchContextRead",
    ),
    gitflowPrPrepare: op(
      "gitflowPrPrepare",
      "gitflow-actions",
      "method",
      "prepare a reviewable pull-request proposal from the recorded branch context, before any remote mutation",
      "gitflow.prPrepare",
    ),
  };
