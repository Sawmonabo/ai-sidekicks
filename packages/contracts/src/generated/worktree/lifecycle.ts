// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A worktree's ids, state and lifecycle payload, and the requests and responses of the worktree methods: preparing an execution root, retiring a tree and the details of its refusals, and reading the project's trees.

import type { AgentId } from "../agent/definition.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { ProjectId } from "../project.js";
import type { RepoMountId, WorkspaceId, WorkspaceState } from "../repo/mount.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { WorkflowRunId } from "../workflow/run/id.js";

/**
 * The daemon-minted id of a worktree row.
 */
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
/**
 * The daemon-minted id of a branch context: the workspace-anchored branch record.
 */
export type BranchContextId = string & { readonly __brand: "BranchContextId" };
/**
 * The id of a worktree removed with `Discard and remove` and kept whole until the person
 * deletes the copy; a record apart from the retired worktree, since the copy outlives the tree
 * and a put-back makes a new worktree.
 */
export type RemovedWorktreeId = string & { readonly __brand: "RemovedWorktreeId" };
/**
 * A worktree's lifecycle state. `retired` and `failed` are not live; moving to `failed` emits no
 * `worktree.*` event (the failure is evented as `workspace.rootLost`), and failed rows stay
 * readable through `worktree.status.read`.
 */
export type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
/**
 * The state of a listed worktree: every state but `retired`, since a retired tree is never listed.
 * It is a wire enum of its own so a client's table keyed by it covers exactly the listed states;
 * the conversion from [`WorktreeState`] matches every state, so the two cannot drift apart.
 */
export type ListedWorktreeState = "creating" | "ready" | "dirty" | "merged" | "failed";
/**
 * The details of a `worktree.retireConflict` refusal, by why the removal was refused.
 */
export type WorktreeRetireConflictDetails =
  | {
      reason: "rootBusy";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * The session the agent runs in.
       */
      runningSessionId: SessionId;
    }
  | {
      reason: "hasChanges";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * What removing it would lose now.
       */
      risks: WorktreeRemovalRisks;
    };
/**
 * The run live in a folder another act would take from under it: an agent's run, named by its
 * agent, or a workflow run, by `kind`.
 */
export type RunningHolder =
  | {
      kind: "agent";
      /**
       * The agent the run is for.
       */
      agentId: AgentId;
    }
  | {
      kind: "workflowRun";
      /**
       * The run.
       */
      runId: WorkflowRunId;
    };
/**
 * One worktree git lists for the repository, with every figure its switcher row draws;
 * `path` is the folder `session.workingFolder.update` takes. A tree the app made carries
 * its record, and one the person made carries none and has no removal of its own.
 */
export type WorktreeStatusRecord =
  | {
      madeBy: "app";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its mount.
       */
      repoMountId: RepoMountId;
      /**
       * The branch it was made from.
       */
      baseBranchName: string;
      /**
       * Its state.
       */
      state: ListedWorktreeState;
      /**
       * The session that made it.
       */
      createdBySessionId: SessionId;
      /**
       * The run that made it; absent for a tree prepared before any run.
       */
      createdByRunId?: RunId;
      /**
       * When it was made.
       */
      createdAt: WireInstant;
      /**
       * When it last changed.
       */
      updatedAt: WireInstant;
      /**
       * The tree's folder.
       */
      path: string;
      /**
       * Its name.
       */
      name: string;
      /**
       * Its branch.
       */
      branchName: string;
      /**
       * Commits ahead of the upstream as of the last fetch; absent with no upstream.
       */
      ahead?: number;
      /**
       * Commits behind the upstream as of the last fetch; absent with no upstream.
       */
      behind?: number;
      /**
       * Uncommitted files.
       */
      uncommittedFileCount: number;
      /**
       * Commits no remote-tracking branch reaches.
       */
      unpushedCommitCount: number;
      /**
       * The sessions standing in it.
       */
      occupyingSessionIds: SessionId[];
      /**
       * The session whose agent runs in it, which locks its removal, or `null`.
       */
      runningSessionId: SessionId | null;
    }
  | {
      madeBy: "person";
      /**
       * The tree's folder.
       */
      path: string;
      /**
       * Its name.
       */
      name: string;
      /**
       * Its branch.
       */
      branchName: string;
      /**
       * Commits ahead of the upstream as of the last fetch; absent with no upstream.
       */
      ahead?: number;
      /**
       * Commits behind the upstream as of the last fetch; absent with no upstream.
       */
      behind?: number;
      /**
       * Uncommitted files.
       */
      uncommittedFileCount: number;
      /**
       * Commits no remote-tracking branch reaches.
       */
      unpushedCommitCount: number;
      /**
       * The sessions standing in it.
       */
      occupyingSessionIds: SessionId[];
      /**
       * The session whose agent runs in it, which locks its removal, or `null`.
       */
      runningSessionId: SessionId | null;
    };

/**
 * The payload of a `worktree.*` lifecycle event; the emitter sets `worktreeId` on every one.
 */
export interface WorktreeLifecyclePayload {
  /**
   * The envelope's session, repeated so a projector can read the payload alone.
   */
  sessionId: SessionId;
  /**
   * The mount, when it is the subject or beside it.
   */
  repoMountId?: RepoMountId;
  /**
   * The workspace, when it is the subject or beside it.
   */
  workspaceId?: WorkspaceId;
  /**
   * The worktree, when it is the subject.
   */
  worktreeId?: string;
  /**
   * The subject's state after the transition.
   */
  state: WorktreeState;
  /**
   * The envelope's actor, repeated; a system event sends `null` or leaves it out.
   */
  actor?: string | null;
}
/**
 * `workspace.executionRoot.prepare`: the workspace and its branch, which makes the root for the
 * workspace's execution mode before a run starts. It carries no run id: the daemon supplies it, so
 * a caller cannot forge run provenance.
 */
export interface WorkspaceExecutionRootPrepareRequest {
  /**
   * The workspace.
   */
  workspaceId: WorkspaceId;
  /**
   * The branch. A `provisionedWorktree` workspace with none is refused
   * `workspace.branchNameRequired` before any git call; a `boundRoot` workspace binds its stored
   * folder and needs none.
   */
  branchName?: string;
  /**
   * The base; absent means the mount's current branch, and a detached HEAD with no base is
   * refused. The daemon refuses a leading dash before git reads it as an option.
   */
  baseRef?: string;
  /**
   * Carries the session's uncommitted work, untracked files included, onto the new tree; refused
   * unless the new base is the branch the work sits on.
   */
  carryUncommitted?: boolean;
}
/**
 * The `workspace.executionRoot.prepare` result: the prepared root and the rows it names. A prepare
 * resolves a root or refuses; there is no partial success.
 */
export interface WorkspaceExecutionRootPrepareResponse {
  /**
   * The root.
   */
  executionRoot: string;
  /**
   * The workspace's state.
   */
  state: WorkspaceState;
  /**
   * The worktree, for a `provisionedWorktree` prepare only.
   */
  worktreeId?: WorktreeId;
  /**
   * The branch context every prepare writes or refreshes.
   */
  branchContextId: BranchContextId;
}
/**
 * `worktree.retire`. `discard: false` is the ordinary removal: it removes nothing the confirm
 * did not show, and is refused with the current risks when the tree changed since they were
 * read. `discard: true` comes only from the discard confirm, and the daemon keeps the tree whole
 * instead of deleting it.
 */
export interface WorktreeRetireRequest {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * Whether to keep the tree whole instead of deleting it.
   */
  discard: boolean;
}
/**
 * The kept copy a discard made.
 */
export interface KeptWorktree {
  /**
   * The kept copy.
   */
  removedWorktreeId: RemovedWorktreeId;
}
/**
 * The `worktree.retire` result: the worktree, now `retired`, and the kept copy when a discard
 * kept one. A refusal is an error, never a reply with the unchanged state.
 */
export interface WorktreeRetireResponse {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * Its state.
   */
  state: "retired";
  /**
   * The kept copy.
   */
  kept?: KeptWorktree;
}
/**
 * What removing a tree would lose, each named in the confirm: uncommitted files, ignored files (an
 * `.env`, say), commits no remote-tracking branch of the folder reaches, and the sessions standing
 * in it.
 */
export interface WorktreeRemovalRisks {
  /**
   * Uncommitted files.
   */
  uncommittedFileCount: number;
  /**
   * Ignored files that would be destroyed.
   */
  ignoredFileCount: number;
  /**
   * Commits no remote-tracking branch reaches.
   */
  unpushedCommitCount: number;
  /**
   * The sessions standing in it.
   */
  occupyingSessionIds: SessionId[];
}
/**
 * The details of a `worktree.retireIncomplete` refusal: the tree, still live, and the kept copy
 * listed for it. No folder is named; the screen finds both from the lists.
 */
export interface WorktreeRetireIncompleteDetails {
  /**
   * The worktree.
   */
  worktreeId: WorktreeId;
  /**
   * The kept copy.
   */
  removedWorktreeId: RemovedWorktreeId;
}
/**
 * The details of a `worktree.createFailed` refusal with reason `carryCheckoutRunning`: the
 * session whose run is live in the checkout the work would be carried from, and that run.
 */
export interface WorktreeCarryCheckoutRunningDetails {
  /**
   * Why.
   */
  reason: "carryCheckoutRunning";
  /**
   * The session running there.
   */
  runningSessionId: SessionId;
  /**
   * Its run.
   */
  runningHolder: RunningHolder;
}
/**
 * `worktree.status.read`: the project whose worktrees are listed, and the session asking, when
 * one is, so the read also answers the new-worktree form's suggestion for it.
 */
export interface WorktreeStatusReadRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * The session asking.
   */
  sessionId?: SessionId;
}
/**
 * What the new-worktree form opens with, from the daemon function that names and creates the
 * tree, so the form copies none of the daemon's naming.
 */
export interface NewWorktreeSuggestion {
  /**
   * The name's fixed part, from the branch pattern.
   */
  fixedPart: string;
  /**
   * A tail suggested from the session title; absent when the name has none, as for a branch
   * name the person typed that the pattern did not make or a session with no title words.
   */
  suggestedTail?: string;
  /**
   * The folder up to that tail.
   */
  folderBefore: string;
}
/**
 * The project's own checkout.
 */
export interface RepoRootStatus {
  /**
   * Its folder.
   */
  path: string;
  /**
   * Its branch.
   */
  branchName: string;
}
/**
 * The `worktree.status.read` result: the project's own checkout and its standing trees from one
 * read, so no row shows a tree free that another read calls occupied. `countsAsOf` says when the
 * ahead and behind figures were last true if the last fetch failed.
 */
export interface WorktreeStatusReadResponse {
  /**
   * The project's own checkout.
   */
  repoRoot: RepoRootStatus;
  /**
   * Its standing trees.
   */
  worktrees: WorktreeStatusRecord[];
  /**
   * When the figures were last true.
   */
  countsAsOf?: WireInstant;
  /**
   * The new-worktree form's suggestion for the session asking.
   */
  newWorktree?: NewWorktreeSuggestion;
}

export {
  validateRemovedWorktreeId,
  validateWorktreeId,
  validateWorktreeLifecyclePayload,
  validateWorktreeState,
} from "../checks/worktree/lifecycle.js";
