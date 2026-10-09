# Worktree Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-007 — Worktree Lifecycle And Execution Modes

```ts
// Branded IDs introduced by Plan-007 (canonical origin: packages/contracts/src/worktree/lifecycle.ts;
// declared in-block rather than under api-payload-contracts.md §Branded ID Types / api-payload-contracts.md §Shared Enums for cite stability)
type BranchContextId = string & { readonly __brand: "BranchContextId" };
// A worktree removed with `Discard and remove`, or a removed one the cleanup sweep found holding
// something its removal did not show, kept whole until the person deletes the copy: a record apart
// from the retired worktree row, because the copy outlives the tree and a put-back makes a new
// worktree.
type RemovedWorktreeId = string & { readonly __brand: "RemovedWorktreeId" };

// ExecutionRootPrepare — materializes (or binds) the execution root for the workspace's selected mode.
// It carries no `runId`: the run-setup gate supplies it service-side, so a caller cannot forge run
// provenance.
interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string; // optional in the schema, required in practice: a wire prepare has no run to derive a name from, so omitting it draws the typed workspace.branch_name_required refusal before any git call
  baseRef?: string; // worktree base; default = mount HEAD branch; detached HEAD without baseRef → typed refusal; a leading dash is refused before git
  carryUncommitted?: boolean; // carry the session's uncommitted work, untracked files included, onto the new tree; refused unless the new base is the branch the work sits on
}
interface ExecutionRootPrepareResponse {
  executionRoot: string; // at most FILE_PATH_MAX_LEN; a prepare resolves a root or refuses with a typed error, never a partial success
  state: WorkspaceState;
  worktreeId?: WorktreeId; // present for a provisioned-worktree prepare only
  branchContextId: BranchContextId; // every prepare writes or refreshes a branch context (Spec-008 §State And Data Implications)
}

// WorktreeRetire — records retirement before any disk work; disk cleanup is asynchronous, and a folder
// holding anything the removal did not show is kept aside and listed rather than deleted. `discard:
// false` is the ordinary removal, refused when the tree has something to lose the confirm did not show;
// `discard: true` is sent only after the discard confirm, and the daemon keeps what it discards
// (repo-payloads.md §Repo Method-Name Registry).
interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
  discard: boolean;
}
interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">; // the one success state; a refusal is the typed worktree.retire_conflict error
  kept?: { removedWorktreeId: RemovedWorktreeId }; // present when a discard kept a copy: the kept copy `Put back` restores
}

// WorktreeStatusRead — the project whose worktrees are listed, and the session asking, when one is. A
// session's switcher names itself, so the read also answers the new-worktree form's suggestion for it.
interface WorktreeStatusReadRequest {
  projectId: ProjectId;
  sessionId?: SessionId;
}
// ONE read supplies every figure a switcher row draws, on this existing repo surface rather than a
// second one, so the switcher never shows a tree as free while another read calls it occupied. The
// daemon keeps the figures true with a background fetch — every few minutes while a session on the
// project is live, under the person's own git identity, never pulling and never pruning. Only
// standing trees are listed, so a row never carries `retired`; a copy kept by a discard is listed by
// `repo.removedWorktreeList`.
interface WorktreeStatusReadResponse {
  repoRoot: { path: string; branchName: string }; // the project's own checkout and the branch it is on
  worktrees: WorktreeStatusRecord[]; // every standing tree git lists for the repository, empty when it has none
  // Present when the LAST background fetch failed, and says when `ahead` and `behind` were last true,
  // so a row can say `as of <time>` instead of silently reading stale numbers as current.
  countsAsOf?: string;
  newWorktree?: NewWorktreeSuggestion; // present when the request named the asking session
}
// One worktree git lists for the repository, as its switcher row draws it; `path` is the folder
// `session.setWorkingFolder` takes. A tree the app made carries its record (`madeBy: "app"`); one the
// person made with git carries none, and has no removal of its own.
type WorktreeStatusRecord = (
  | {
      madeBy: "app";
      worktreeId: WorktreeId;
      repoMountId: RepoMountId;
      baseBranchName: string; // the branch it was cut from (`off <base>`)
      state: Exclude<WorktreeState, "retired">;
      createdBySessionId: SessionId;
      createdByRunId?: RunId; // absent for a tree prepared before any run
      createdAt: string;
      updatedAt: string;
    }
  | { madeBy: "person" }
) & {
  path: string; // the tree's folder: under the daemon's worktrees folder for one the app made
  name: string; // the tree's own name
  branchName: string;
  // Commits against the branch's upstream, read against the daemon's latest background fetch; absent
  // when the branch has none.
  ahead?: number;
  behind?: number;
  // The same figures the removal confirm names. Unpushed means not reachable from ANY remote-tracking
  // branch of this folder, which is local knowledge and never a hosting read.
  uncommittedFileCount: number;
  unpushedCommitCount: number;
  // The sessions standing in this directory. Occupancy is why a removal is refused and why the trash
  // names its occupant, and it is the daemon's answer rather than a renderer-side tally: two sessions
  // may share a worktree, and their runs may work in it at once.
  occupyingSessionIds: SessionId[];
  runningSessionId: SessionId | null; // the session whose agent is running in the tree, which locks the trash
};
// What the new-worktree form opens with, from the same daemon function that creates the tree and
// names its folder: the fixed leading part of the name (the project's branch pattern filled in up to
// `{title}`), the suggested tail derived from the session's title, and the folder the tree will get
// up to that tail. The form shows the folder as `folderBefore` followed by whatever tail is typed, so
// it copies none of the daemon's naming.
interface NewWorktreeSuggestion {
  fixedPart: string;
  suggestedTail: string;
  folderBefore: string;
}

// session.swept_to_repo_root payload (Spec-005 §Repo, Workspace, and Worktree Lifecycle). A sweep is not
// a state transition: it records that this session's working folder is now the repository root because the
// worktree it was attached to was removed. `worktreeId` names the REMOVED tree, and `pendingMoveCleared`
// is present only where the same removal cleared a pending working-folder move that pointed at it — the
// presence-discriminator idiom, absent rather than `false`. One event is appended per session the removal
// moved, so each moved session's own flow row survives a reload.
interface SessionSweptToRepoRootPayload {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  worktreeId: WorktreeId;
  pendingMoveCleared?: true;
}
```
