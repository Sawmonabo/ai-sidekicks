// Which workspace a worktree's change-proposal gate is asked under — and when nothing
// registered can say.
//
// The branch-context read is keyed by a workspace AND a worktree
// (`bridge/growth-signatures.ts`), and no registered reply pairs them: a worktree row
// carries `repoMountId` and no workspace id, and a workspace row carries no worktree
// id at all. The only relation either read establishes is the mount both sit under,
// so this module states the one inference that relation licenses and refuses the
// rest.
//
// THE RULE IS EXACTLY ONE. A mount with a single workspace pairs unambiguously —
// every worktree of that mount is a root of that workspace, because there is no other
// workspace it could belong to. A mount with several does NOT pair, and this returns
// the absence rather than picking the first, the newest, or the one whose `fsRoot`
// looks like a prefix of the worktree's: each of those would be a guess rendered as a
// reading, and a gate asked under the wrong workspace would show a real branch context
// belonging to somebody else's work.
//
// A mount with NO workspace does not pair either, and that case is not hypothetical
// dressing: attach mints a default workspace (`Spec-009 §Default Behavior`), so a
// mount with none means the roster and the mount disagree — which `MountCard` already
// says out loud — and a gate is not the surface to resolve it on.

import type { ProposalGateSubject } from "./proposal-gate-model.js";
import type { RepoWorkspaceRow } from "./repo-mounts-reader.js";
import type { WorktreeStatusRecord } from "./worktree-model.js";

/**
 * One worktree, with the gate subject it resolved to — or without one.
 *
 * The subject is optional rather than the row being dropped, because a root that
 * exists is a fact the section reports whether or not a gate can be asked about it.
 * Dropping the unpairable ones would make the roots list disagree with the read.
 */
export interface WorktreeGateRowSubject {
  readonly record: WorktreeStatusRecord;
  readonly subject?: ProposalGateSubject | undefined;
}

/** What the gate says where no registered read names the workspace to ask under. */
export const UNPAIRED_WORKTREE_COPY =
  "No read names which workspace this root belongs to. The branch-context read is asked under a workspace, this mount has more than one, and nothing on either reply pairs them — so the question is not put rather than put under a guess.";

/** What the gate says where the mount the root belongs to has no workspace at all. */
export const MOUNTLESS_WORKTREE_COPY =
  "This root's mount has no workspace in the roster, so there is nothing to ask the branch-context read under.";

/**
 * The roots of one mount, each with the workspace its gate is asked under.
 *
 * Order is the status read's own. The mode on a resolved subject is the workspace's
 * own `executionMode`, wire-verbatim, so the `no-context` arm names the mode the row
 * above it is showing rather than one this module chose.
 */
export function worktreeGateRowSubjects(
  worktrees: readonly WorktreeStatusRecord[],
  workspaces: readonly RepoWorkspaceRow[],
  repoMountId: string,
): readonly WorktreeGateRowSubject[] {
  const mountWorkspaces = workspaces.filter((workspace) => workspace.repoMountId === repoMountId);
  const onlyWorkspace = mountWorkspaces.length === 1 ? mountWorkspaces[0] : undefined;
  return worktrees
    .filter((record) => record.repoMountId === repoMountId)
    .map((record) =>
      onlyWorkspace === undefined
        ? { record }
        : {
            record,
            subject: {
              workspaceId: onlyWorkspace.id,
              worktreeId: record.worktreeId,
              executionMode: onlyWorkspace.executionMode,
            },
          },
    );
}

/** Which sentence an unpaired root gets: no workspace at all, or too many to choose. */
export function unpairedWorktreeCopy(
  workspaces: readonly RepoWorkspaceRow[],
  repoMountId: string,
): string {
  return workspaces.some((workspace) => workspace.repoMountId === repoMountId)
    ? UNPAIRED_WORKTREE_COPY
    : MOUNTLESS_WORKTREE_COPY;
}
