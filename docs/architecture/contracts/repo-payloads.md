# Repo Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-006 — Repo Attachment And Workspace Binding

```ts
// Plan-006 shared shapes (D-006-2 / D-006-4) — canonical origin
// packages/contracts/src/repo/mount.ts; Plan-007 imports these per Plan-006 CP-006-1.
// A project is a git repository: `repo.attach` refuses a folder that is not one, and a chat's own
// workspace is git-initialized from its first byte, so there is no non-git kind.
type VcsType = "git";
// Derived projection, never persisted — Spec-007 §Repo Mount Health (V1 Definition).
// "identity_mismatch": root reachable but the re-derived common directory no longer
// equals the attach-persisted anchor (repo_mounts.metadata.commonDir); "unreachable"
// takes precedence; re-attach (`repo.mountReattach`) is the recovery while the folder is still a git
// repository. checkedAt: ISO-8601 instant of the probe that produced the verdict.
type RepoMountHealth =
  | { status: "healthy" | "unreachable"; checkedAt: string }
  | {
      status: "identity_mismatch";
      // true: git answers for the root with a common directory other than the anchor, so the banner
      // offers `Re-attach`; false: its `.git` entry is gone or broken, so the banner offers
      // `Open folder…`.
      isRepository: boolean;
      checkedAt: string;
    };
// repo.mount_health_changed — sent by the daemon's re-probe on the stream of every session on the
// mount whenever the verdict changes; the session's lost-folder banner reads it (Spec-007 §Fallback
// Behavior).
interface RepoMountHealthChangedPayload {
  repoMountId: RepoMountId;
  health: RepoMountHealth;
}

// RepoAttach — a mount belongs to the machine, not to one session: attach makes the project's one mount
// and no workspace. A session reaches the mount by binding to it — in the same step as `session.create`
// for a new session, through `repo.workspaceBind` for a converted chat. The mount's node is the daemon's
// own, stamped by the daemon and never taken from a caller. A folder that is not a git repository is
// refused; the repository is keyed by its git common folder, so attaching a linked worktree's folder
// finds the repository already attached.
interface RepoAttachRequest {
  // On the machine itself the path comes from the platform's own folder chooser, whose token the main
  // process's relay turns into a path; from another device it is the path of the folder `repo.folderList`
  // showed.
  localPath: string; // user-entered path (provenance; persisted as repo_mounts.local_path)
}
interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string; // resolver output (absolute, symlink-resolved), never the echoed input
}

// RepoMountRead
interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
interface RepoMountReadResponse {
  id: RepoMountId;
  nodeId: NodeId; // the daemon's own node id, stamped at attach — never taken from a caller
  // What the mount is: `attached`, a project's folder; `managed`, a chat's own workspace; `worktree`, a
  // worktree the app made, under its project.
  origin: "attached" | "managed" | "worktree";
  managedSessionId?: SessionId; // present exactly when origin = 'managed': the one chat whose workspace this is
  usedBySessionIds: SessionId[]; // the sessions bound to this mount now — one mount serves every session in its project
  localPath: string; // user-entered provenance
  canonicalRoot: string; // resolver output — the trust-envelope and dedupe key
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth; // derived projection (defined above), never persisted
  attachedAt: string;
}

// RepoDetach (Plan-006 D-006-6; Spec-007 §Detach Semantics)
interface RepoDetachRequest {
  repoMountId: RepoMountId;
}
interface RepoDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState; // 'detached' — terminal; re-attach creates a new mount row
  archivedWorkspaceIds: WorkspaceId[]; // dependent workspaces archived by the cascade
}

// RepoMountReattach — the banner's `Re-attach` (Spec-007 §Repo Mount Health). In one transaction the
// old row turns 'detached' and a new 'attached' row is written at the same canonical root under the
// same project record, carrying the common directory just derived as its anchor; none of the
// detach's cascade runs, and each workspace on the old mount moves to the new one keeping its id.
// Refused with repo.reattach_refused (reason identity_matches), repo.root_resolution_failed (reason
// not_a_repository), repo.already_attached (conflictingRepoMountId, and conflictingProjectId, null
// when a chat's own workspace holds the repository), or repo.reattach_conflict (runningSessionId and
// runningAgentId) while an agent runs anywhere in the project.
interface RepoMountReattachRequest {
  repoMountId: RepoMountId; // the mount reading identity_mismatch
}
interface RepoMountReattachResponse {
  repoMountId: RepoMountId; // the new mount
}

// WorkspaceBind — binds one session to its project's mount and to where it works: a worktree of its own
// (`provisioned-worktree`) or the checkout the project already has (`bound-root`). A new session binds in
// the same step as `session.create`; this call serves a converted chat, and it checks, once, that the
// picked folder belongs to the project.
// A session already holding a live workspace on the mount is answered that workspace as it stands,
// and nothing is written.
interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string; // relative: subdirectory under the mount canonical root; absolute: names a working tree git lists for the mount's repository (Spec-007 trust-envelope rule) — containment re-checked after symlink resolution either way
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  // No root in this answer. A client reads the bound root from the workspace's `fsRoot` in `WorkspaceListResponse` once `workspace.ready` arrives: the EXACT ADMITTED RESOLVED DIRECTORY the bind requested — `directory` resolved against the mount canonical root for the relative form, taken as supplied for the absolute form, symlink-resolved and admitted by containment within an admitted root; equal to a containing root only when the bind names the root itself.
  executionMode: ExecutionMode;
  state: WorkspaceState;
}

// WorkspaceList
interface WorkspaceListRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId; // filter
}
interface WorkspaceListResponse {
  workspaces: Array<{
    id: WorkspaceId;
    repoMountId: RepoMountId;
    executionMode: ExecutionMode;
    state: WorkspaceState;
    fsRoot?: string;
    lastError?: string; // present iff state = 'stale' from a recorded failure (workspaces.metadata.lastError, Spec-007 §State And Data Implications)
  }>;
}
```

## Repo Method-Name Registry

Plan-006's repo-attachment and workspace-binding surface is exposed as `repo.*` methods (Plan-006 D-006-1, CP-006-5). Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out, and each name matches the `METHOD_NAME_FORMAT`. These methods ride the daemon JSON-RPC transport only — repo mounts and workspaces are node-local filesystem state (ADR-004), so no control-plane tRPC sibling exists. Method strings are imperative and disjoint-by-form from the past-participle names of the daemon's own records (`repo.attached`, `repo.detached`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repo.attach` | `mutation` | `RepoAttachRequest` | `RepoAttachResponse` |
| `repo.mountRead` | `query` | `RepoMountReadRequest` | `RepoMountReadResponse` |
| `repo.workspaceBind` | `mutation` | `WorkspaceBindRequest` | `WorkspaceBindResponse` |
| `repo.workspaceList` | `query` | `WorkspaceListRequest` | `WorkspaceListResponse` |
| `repo.detach` | `mutation` | `RepoDetachRequest` | `RepoDetachResponse` |
| `repo.mountReattach` | `mutation` | `RepoMountReattachRequest` | `RepoMountReattachResponse` |
| `repo.mountList` | `query` | `RepoMountListRequest` | `RepoMountListResponse` |
| `repo.folderList` | `query` | `RepoFolderListRequest` | `RepoFolderListResponse` |
| `repo.projectList` | `subscription` | `ProjectListRequest` | `ProjectListResponse` |
| `repo.projectRename` | `mutation` | `ProjectRenameRequest` | `ProjectEditResponse` |
| `repo.projectArchive` | `mutation` | `ProjectStateChangeRequest` | `ProjectEditResponse` |
| `repo.projectReactivate` | `mutation` | `ProjectStateChangeRequest` | `ProjectEditResponse` |
| `repo.projectSetupUpdate` | `mutation` | `ProjectSetupUpdateRequest` | `ProjectEditResponse` |
| `repo.projectEnvironmentUpdate` | `mutation` | `ProjectEnvironmentUpdateRequest` | `ProjectEditResponse` |
| `repo.projectBranchPatternUpdate` | `mutation` | `ProjectBranchPatternUpdateRequest` | `ProjectEditResponse` |
| `repo.clone` | `mutation` | `RepoCloneRequest` | `RepoCloneResponse` |
| `repo.cloneSubscribe` | `subscription` | `RepoCloneProjectRequest` | `RepoCloneSubscribeResponse` |
| `repo.cloneAnswer` | `mutation` | `RepoCloneAnswerRequest` | `EmptyPayload` |
| `repo.cloneCancel` | `mutation` | `RepoCloneProjectRequest` | `EmptyPayload` |
| `repo.cloneFolderRead` | `query` | `RepoCloneFolderReadRequest` | `RepoCloneFolderReadResponse` |
| `repo.largeFilesPull` | `mutation` | `RepoCloneProjectRequest` | `EmptyPayload` |

Canonical Zod schemas live in `packages/contracts/src/repo/folders.ts` (`repo.attach`, `repo.mountRead`, `repo.mountList`, `repo.folderList`, `repo.detach`, `repo.mountReattach`), `packages/contracts/src/repo/workspace.ts` (`repo.workspaceBind`, `repo.workspaceList`), `packages/contracts/src/project.ts` (the `repo.project*` methods) and `packages/contracts/src/repo/clone.ts` (`repo.clone`, its card, its questions, its folder and `repo.largeFilesPull`) per the api-payload-contracts.md §Source-of-Truth Policy; `packages/contracts/src/repo/methods.ts` holds every `repo.*` method's descriptor.

**The folders the service can reach.** `repo.mountList {}` lists every folder the service can reach, each with its `path`, its origin (`attached`, `managed` or `worktree`), how many sessions use it and `onOtherSideDisk`, true for a folder on the other side's disk of a Windows computer whose service runs in WSL 2; a project's worktrees follow their project's folder. `repo.projectList` rows carry the same `onOtherSideDisk`. `repo.folderList {path?, filter?, showHidden?}` lists the machine's folders in place for another device: it answers the folder in view as the service writes its path, the path's segments from the top down (the last is the folder in view, each pressable to go back), every folder in it with its `name`, its `path` and whether it `isRepository`, and `more: true` when the filter would narrow further. The service may page the entries or load them incrementally, and no folder is unreachable from it.

Plan-007's worktree surface adds further `repo.*` methods (Plan-007 D-007-3) — the same namespace, not a new root, because the namespace-root enumeration admits `repo` and mounts, workspaces and worktrees form one repo aggregate — and the session move `session.setWorkingFolder`, which registers on the session root (session-payloads.md §Session Method-Name Registry). A session's place is chosen in `session.create` or `repo.workspaceBind`, so no mode select exists, and a worktree's figures ride `repo.worktreeStatusRead`, so no reuse check exists. Registration rides the same Plan-005-partial `MethodRegistry` path. Method strings stay imperative and disjoint-by-form from the past-participle Spec-005 durable event names (`worktree.created` through `worktree.retired`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repo.executionRootPrepare` | `mutation` | `ExecutionRootPrepareRequest` | `ExecutionRootPrepareResponse` |
| `repo.worktreeRetire` | `mutation` | `WorktreeRetireRequest` | `WorktreeRetireResponse` |
| `repo.worktreeStatusRead` | `query` | `WorktreeStatusReadRequest` | `WorktreeStatusReadResponse` |
| `repo.branchList` | `query` | `RepoBranchListRequest` | `RepoBranchListResponse` |
| `repo.workingTreeSubscribe` | `subscription` | `WorkingTreeSubscribeRequest` | `WorkingTreeSubscribeResponse` |
| `repo.worktreeSetupSubscribe` | `subscription` | `WorktreeSetupRequest` | `WorktreeSetupSubscribeResponse` |
| `repo.worktreeSetupRetry` | `mutation` | `WorktreeSetupRequest` | `EmptyPayload` |
| `repo.worktreeCopySubscribe` | `subscription` | `WorktreeCopySubscribeRequest` | `WorktreeCopySubscribeResponse` |
| `repo.removedWorktreeList` | `query` | `RemovedWorktreeListRequest` | `RemovedWorktreeListResponse` |
| `repo.worktreeRestore` | `mutation` | `RemovedWorktreeRequest` | `WorktreeRestoreResponse` |
| `repo.removedWorktreeDelete` | `mutation` | `RemovedWorktreeRequest` | `EmptyPayload` |

Canonical Zod schemas live in `packages/contracts/src/worktree/lifecycle.ts` (`repo.executionRootPrepare`, `repo.worktreeRetire`, `repo.worktreeStatusRead`; Plan-007 D-007-1), `packages/contracts/src/worktree/removed.ts` (the kept worktrees), `packages/contracts/src/worktree/setup.ts` (the setup card), `packages/contracts/src/worktree/copy-progress.ts` (the copies across volumes) and `packages/contracts/src/repo/git-reads.ts` (`repo.branchList`, `repo.workingTreeSubscribe`) per the api-payload-contracts.md §Source-of-Truth Policy.

**The base list is `repo.branchList {repoMountId}`,** the one ordered list both base pickers draw: the default branch, then the branches this project's last picks came from, most recent first, then the rest by their newest commit. Each branch carries `ahead` and `behind` against its upstream, absent when it has none, and `heldBy`, the worktree that has it checked out, which the create form's list grays: its name always, and its `worktreeId` only for a tree the app made, so the project's own checkout and a tree the person made carry the name alone. `countsAsOf` is present when the last background fetch failed and says when the figures were last true.

**The setup card is `repo.worktreeSetupSubscribe {worktreeId}`.** Each emission is the whole card for one tree: its state and every step in run order across the three stages (making the tree, the project's own setup steps, warming what the session reads first), each with its label, its state, its elapsed time once it has run, and its error and the tail of its output when it failed. The steps are kept, so the card reads the same after leaving the session and coming back. A tree with no card to show — its setup did not run since the daemon started, or it has none — gets one emission in state `not_run` with no steps. `repo.worktreeSetupRetry {worktreeId}` runs the failed step and the ones after it.

**The worktree-candidate read is `repo.worktreeStatusRead`, widened rather than joined by a sibling.** The switcher's rows need ahead, behind, dirtiness and occupancy per candidate directory; those members are on that read's own worktree rows. The read is keyed by project, `{projectId, sessionId?}`, and lists every worktree git lists for the repository, each row carrying its folder `path`, the path `session.setWorkingFolder {sessionId, path}` takes: a tree the app made (`madeBy: "app"`) adds its record — its id, base, state and who made it — and a tree the person made (`madeBy: "person"`) carries none and has no removal. One read rather than two is the contract, not a convenience: a switcher composing its rows from a status read and a separate counts read could draw a directory as free while another read called it occupied, and the trash lock is exactly the affordance that must never be wrong.

**The tree-staleness signal is the daemon's, never the pane's inference.** `repo.workingTreeSubscribe {sessionId}` carries it. The daemon watches the session's working folder and emits the signal; Review draws a reload affordance from it and re-reads nothing until the person presses. A working folder too large for the machine's own watch limit is checked on a slow tick instead, and the signal says which mode produced it, because a stale mark that is slow to arrive must not read as a tree that never changed. The bound is read from what the machine's watch limit allows and is never a figure on a screen.

**The worktree records the console depends on.** Creating and removing a worktree each leave a durable record under one category, so those rows survive a reload; a removal additionally leaves a PER-SESSION record for each session it swept back to the repo root, because the sweep changes where that session is standing and the session's own flow has to say so. Removal clears every pending working-folder move pointing at the removed tree, is refused while an agent is running in it, and never stops a run. The lifecycle records are `worktree.created` and `worktree.retired`, and the per-session one is `session.swept_to_repo_root`; the taxonomy census is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s, and what is fixed here is that these records exist and what each carries.

**Removing a worktree keeps what it discards.** `repo.worktreeRetire {worktreeId, discard}` is the one removal of a worktree the app made, from the worktree switcher and from Runtime's `Remove`; a project's own folder is removed only by `repo.detach`. `discard: false` is the ordinary removal: when the tree has something to lose that the confirm did not show, it is refused with `worktree.retire_conflict`, whose `reason` is `root_busy`, naming the session whose agent runs in the tree, or `has_changes` and, for `has_changes`, carries the current risks so the confirm redraws them; ignored files such as an `.env` count as something to lose. `discard: true` is sent only after the discard confirm, and the daemon keeps what it discards until the person deletes it: the tree's own shells and project processes end first, then the folder moves whole into `worktrees/<project>/.removed/`, git's per-worktree record is copied, the staged objects are packed, the large-file objects staged pointers name are kept, and every commit the kept record names is pinned under `refs/sidekicks/removed/<id>/`. That removal's result carries `kept: {removedWorktreeId}`, and its `worktree.retired` record carries the same `removedWorktreeId`. Nothing deletes a kept worktree on its own. `repo.removedWorktreeList {projectId?}` lists the kept worktrees for Runtime, each row `{removedWorktreeId, projectId, name, branch, headCommit, removedAt, sizeBytes, sizeReadAt, unreadablePutBackFolder}`, and what is left of a copy put back is listed only while it is the one source to rebuild a live tree put back that git cannot read, `unreadablePutBackFolder` naming that tree's folder, which is otherwise null. `repo.worktreeRestore {removedWorktreeId}` is `Put back`, from the switcher, the swept sessions' flow row and Runtime: the tree goes back on its own branch when that branch still points at the recorded commit and no other worktree holds it, and otherwise on `<branch>-restored`, at its own folder or `<name>-restored`, a taken name taking the next free number (`-restored-2` and on), one number shared by the folder and a new branch, and `branch` naming the branch used; what is left of a copy whose put-back tree git cannot read is put back again from its files while they are whole, its link moving to the new tree; it answers `{outcome: "restored", worktreeId, path, branch, onNewBranch}` or `{outcome: "refused", refusal}`, the refusal's `reason` being `project_not_attached`, `repository_missing` with the `path` where the repository is missing, or `kept_tree_missing` when the kept folder no longer holds the tree, which `Delete now` still removes; a restore records `worktree.created` with `restoredFrom`, and a refused put-back keeps the kept copy. `repo.removedWorktreeDelete {removedWorktreeId}` is `Delete now`, which removes the kept folder and its pins. Where a removal or a put-back would cross a volume, the daemon copies the tree, and `repo.worktreeCopySubscribe {projectId?}` carries the copies under way, one project's or every project's when `projectId` is absent: each emission is the whole list, `{copies}`, each copy either `{kind: "removing", worktreeId, projectId, name, copiedBytes, totalBytes}` for a worktree being removed or `{kind: "putting_back", removedWorktreeId, projectId, name, copiedBytes, totalBytes}` for a kept worktree being put back, its id and `name` those of the row it draws on, `totalBytes` the size of every file the copy makes and `copiedBytes` the bytes written so far, the file being copied included. A copy's progress is sent four times a second while it runs, and once more when it ends, which drops it from the list, and there is no `Cancel`.

**Project administration.** A project is its own durable record kept beside its mount: its display name, its archived mark, its worktree setup steps, its own environment rows and its own branch-name pattern. `repo.projectList` is the live list the sessions list's project headers and Settings › Projects read, so a project attached on another device appears at once; each row carries the per-project tally of its sessions running, waiting on the person and done, which the daemon counts and serves live and the renderer never counts. The actions on a project's row:

- **Rename** is `repo.projectRename`: it sets the display name and leaves the folder on disk untouched. It is the only name a person types for a project; the folder's own basename stands until they do.
- **Open in editor** is the bridge's `native.openInEditor`, which opens the project's folder in the editor Settings › General names.
- **Archive** is `repo.projectArchive`: it takes the project out of the session list's grouping and into an archived group carrying one action, unarchive; its sessions are kept and come back with it. **Unarchive** is `repo.projectReactivate`, the inverse, which restores the grouping.
- **Delete** is `repo.detach`, the project's one removal act and the same act as Runtime's `Remove` on the project's folder. It is refused only while an agent runs anywhere in the project. It takes the project out of the projects page and out of the session list, forgets its setup steps and its branch-name pattern, and ARCHIVES its sessions, which stay readable. Nothing on disk is touched and it is not undoable, which is why the confirm states all three facts before it acts.
- **The setup steps** are written through `repo.projectSetupUpdate`: a per-project recipe — files to copy, a file the tree already has kept as it is, commands to run in order, and an optional time limit each command is given up on after, its absence meaning no limit — read and written from the projects page. They run with the repository's own git config, its hooks included, raise no approval card at any permission level, and make no approval rule. They are the person's own list on this machine rather than a file inside the repository.
- **The environment rows** are two lists. The machine-wide list is passed to every process the app starts and belongs to the machine's settings file, written through `daemon.machineSettingsUpdate`; a project's own list, written through `repo.projectEnvironmentUpdate`, is passed to every process that project's sessions start and belongs to the project record. A name in a project's list WINS over the same name machine-wide. The daemon reads both lists when it starts a project's process. A credential-shaped name is refused at save, in the list it was typed into, and nothing is written — credentials live in the account's credential home, never in an environment row — and so is a name the app sets itself on the processes it starts.
- **The branch-name pattern** is written through `repo.projectBranchPatternUpdate {projectId, pattern | null}`, `null` returning the project to the machine's own pattern, the `Every project` pattern, a key in the machine's settings file written through `daemon.machineSettingsUpdate`.

**Cloning from a URL.** `Clone repository…` in the new-session picker clones a repository and attaches the finished folder as `Open folder…` attaches one; the session is minted at once. `repo.cloneFolderRead {}` → `{folder, source: setting | lastProject | home}` is the one answer to where a clone goes: the folder `Clone new repositories into` on Settings › Projects names (a key in the machine's settings file), else the folder holding the most recently attached project, else the home folder. `repo.clone {url, parentFolder?, projectId?}` → `{projectId}` creates the project record at once, marked as cloning, and a `projectId` reruns a failed or canceled clone of that project. The address or path the person typed goes to git as typed, and git's own transport rules decide; submodules are included, and a destination that exists and is not empty is refused before anything is fetched. The daemon runs git as an argument list with the person's own git config and credentials, stores no credential, and routes git's questions — a user name, a password or token, a key's passphrase, whether to trust a host's key — through its own askpass program, whose launcher never lets a command interpreter read the question, to the clone card in the composer. `repo.cloneSubscribe {projectId}` streams the card's state — the phase, the percent, a question waiting, the failure line in git's own words, and done — at most four updates a second, the latest winning; a failure names its step: `clone`, `large_files`, or `sessions` when the sessions that waited on the clone could not be started after it attached; `repo.cloneAnswer {projectId, questionId, answer}` answers git's question, and the answer goes to git and nowhere else; `repo.cloneCancel {projectId}` stops git and removes the folder the clone made before the card offers `Clone` again. Where the cloned repository keeps large files in Git LFS and Git LFS is not installed, `repo.largeFilesPull {projectId}` fetches them once it is. A finished clone ends in the daemon's ordinary attach, and the project then reads `active` in the live `repo.projectList`; `repo.attached` is the daemon's own record and has no wire shape.
