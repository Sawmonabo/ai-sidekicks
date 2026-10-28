# Repo Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-006 — Repo Attachment And Workspace Binding

```ts
// Plan-006 shared shapes (D-006-2 / D-006-4) — the Rust types live in
// crates/sidekicks-contracts/src/repo/mount.rs; Plan-007 imports these per Plan-006 CP-006-1.
// A project is a git repository: `repoMount.attach` refuses a folder that is not one, and a chat's
// own workspace is git-initialized from its first byte, so there is no non-git kind.
type VcsType = "git";
// Derived projection, never persisted — Spec-007 §Repo Mount Health (V1 Definition).
// "identityMismatch": root reachable but the re-derived common directory no longer equals the
// attach-persisted anchor (repo_mounts.metadata.commonDir); "unreachable" takes precedence;
// re-attach (`repoMount.reattach`) is the recovery while the folder is still a git repository.
// checkedAt: ISO-8601 instant of the probe that produced the verdict.
type RepoMountHealth =
  | { status: "healthy" | "unreachable"; checkedAt: string }
  | {
      status: "identityMismatch";
      // true: git answers for the root with a common directory other than the anchor, so the banner
      // offers `Re-attach`; false: its `.git` entry is gone or broken, so the banner offers
      // `Open folder…`.
      isRepository: boolean;
      checkedAt: string;
    };
// repoMount.health.changed — sent by the daemon's re-probe on the stream of every session on the
// mount whenever the verdict changes; the session's lost-folder banner reads it (Spec-007 §Fallback
// Behavior).
interface RepoMountHealthChangedPayload {
  repoMountId: RepoMountId;
  health: RepoMountHealth;
}

// RepoMountAttach — a mount belongs to the machine, not to one session: attach makes the project's
// one mount and no workspace. A session reaches the mount by binding to it — in the same step as
// `session.create` for a new session, through `workspace.bind` for a converted chat. The mount's
// machine is the daemon's own, stamped by the daemon and never taken from a caller. A folder that
// is not a git repository is refused; the repository is keyed by its git common folder, so
// attaching a linked worktree's folder finds the repository already attached. `Place` and
// `WslPlace` are `@ai-sidekicks/contracts/place`'s `"windows" | { distro: string }` and `{ distro:
// string }`.
interface RepoMountAttachRequest {
  // On the machine itself the path comes from the platform's own folder chooser, whose token the
  // main process's relay turns into a path; from another device it is the path of the folder
  // `machine.folder.list` showed.
  localPath: string; // user-entered path (provenance; persisted as repo_mounts.local_path)
  // The WSL 2 distribution a Linux path was given in; absent on macOS and Linux and wherever the
  // path's own form says, Windows itself among them.
  place?: WslPlace;
}
interface RepoMountAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string; // resolver output (absolute, symlink-resolved), never the echoed input, in its place's own form
  place?: Place; // where the root is, fixed for the mount's life; absent on macOS and Linux
}

// RepoMountRequest — the mount repoMount.read, repoMount.detach and repoMount.reattach act on.
interface RepoMountRequest {
  repoMountId: RepoMountId;
}
interface RepoMountReadResponse {
  id: RepoMountId;
  machineId: MachineId; // the daemon's own machine id, stamped at attach — never taken from a caller
  localPath: string; // user-entered provenance
  canonicalRoot: string; // resolver output — the trust-envelope and dedupe key
  place?: Place; // where both paths are, in that place's own form; absent on macOS and Linux
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth; // derived projection (defined above), never persisted
  attachedAt: string;
  origin: RepoMountOrigin;
  displayName?: ProjectName; // its project's name; absent on a chat's own workspace, which belongs to no project
  usedBy: RepoMountUser[]; // the sessions bound to this mount now — one mount serves every session in its project
}
// What the mount is, tagged by `kind`.
type RepoMountOrigin =
  | { kind: "attached"; repoMountId: RepoMountId; projectId: ProjectId } // a project's folder
  | { kind: "managed"; repoMountId: RepoMountId; sessionId: SessionId } // a chat's own workspace: the one chat that owns it
  | { kind: "worktree"; worktreeId: WorktreeId; projectId: ProjectId }; // a worktree the app made, under its project
interface RepoMountUser {
  sessionId: SessionId;
}

// RepoMountDetach (Plan-006 D-006-6; Spec-007 §Detach Semantics), on a `RepoMountRequest`
interface RepoMountDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState; // 'detached' — terminal; re-attach creates a new mount row
  archivedWorkspaceIds: WorkspaceId[]; // dependent workspaces archived by the cascade
}

// RepoMountReattach — the banner's `Re-attach` (Spec-007 §Repo Mount Health). In one transaction
// the old row turns 'detached' and a new 'attached' row is written at the same canonical root under
// the same project record, carrying the common directory just derived as its anchor; none of the
// detach's cascade runs, and each workspace on the old mount moves to the new one keeping its id.
// Refused with repoMount.reattachRefused (reason identityMatches), repoMount.rootResolutionFailed
// (reason notARepository), repoMount.alreadyAttached (conflictingRepoMountId, and
// conflictingProjectId, null when a chat's own workspace holds the repository), or
// repoMount.reattachConflict (runningSessionId and runningAgentId) while an agent runs anywhere in
// the project. Its `RepoMountRequest` names the mount reading identityMismatch.
interface RepoMountReattachResponse {
  repoMountId: RepoMountId; // the new mount
}

// WorkspaceBind — binds one session to its project's mount and to where it works: a worktree of its
// own (`provisionedWorktree`) or the checkout the project already has (`boundRoot`). A new session
// binds in the same step as `session.create`; this call serves a converted chat, and it checks,
// once, that the picked folder belongs to the project. A session already holding a live workspace
// on the mount is answered that workspace as it stands, and nothing is written.
interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string; // relative: subdirectory under the mount canonical root; absolute: names a working tree git lists for the mount's repository (Spec-007 trust-envelope rule) — containment re-checked after symlink resolution either way
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  // No root in this answer. A client reads the bound root from the workspace's `fsRoot` in
  // `WorkspaceListResponse` once `workspace.prepared` arrives: the EXACT ADMITTED RESOLVED
  // DIRECTORY the bind requested — `directory` resolved against the mount canonical root for the
  // relative form, taken as supplied for the absolute form, symlink-resolved and admitted by
  // containment within an admitted root; equal to a containing root only when the bind names the
  // root itself.
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
    lastError?: string; // present iff state = 'rootLost' from a recorded failure (workspaces.metadata.lastError, Spec-007 §State And Data Implications)
  }>;
}
```

## Repo Method-Name Registry

Plan-006's repo-attachment and workspace-binding surface is exposed as `repoMount.*`, `workspace.*` and `project.*` methods and `machine.folder.list` (Plan-006 D-006-1, CP-006-5). Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out, and each name follows the [wire-name grammar](./local-ipc-payloads.md#wire-name-grammar). These methods ride the daemon JSON-RPC transport only — repo mounts and workspaces are machine-local filesystem state (ADR-004), so no control-plane route sibling exists. Method strings are imperative and disjoint-by-form from the past-participle names of the daemon's own records (`repoMount.attached`, `repoMount.detached`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repoMount.attach` | `mutation` | `RepoMountAttachRequest` | `RepoMountAttachResponse` |
| `repoMount.read` | `query` | `RepoMountRequest` | `RepoMountReadResponse` |
| `workspace.bind` | `mutation` | `WorkspaceBindRequest` | `WorkspaceBindResponse` |
| `workspace.list` | `query` | `WorkspaceListRequest` | `WorkspaceListResponse` |
| `repoMount.detach` | `mutation` | `RepoMountRequest` | `RepoMountDetachResponse` |
| `repoMount.reattach` | `mutation` | `RepoMountRequest` | `RepoMountReattachResponse` |
| `repoMount.list` | `query` | `EmptyPayload` | `RepoMountListResponse` |
| `machine.folder.list` | `query` | `MachineFolderListRequest` | `MachineFolderListResponse` |
| `project.subscribe` | `subscription` | `EmptyPayload` | `ProjectList` (stream) |
| `project.rename` | `mutation` | `ProjectRenameRequest` | `ProjectEditResponse` |
| `project.archive` | `mutation` | `ProjectStateChangeRequest` | `ProjectEditResponse` |
| `project.reactivate` | `mutation` | `ProjectStateChangeRequest` | `ProjectEditResponse` |
| `project.setup.update` | `mutation` | `ProjectSetupUpdateRequest` | `ProjectEditResponse` |
| `project.environment.update` | `mutation` | `ProjectEnvironmentUpdateRequest` | `ProjectEditResponse` |
| `project.branchPattern.update` | `mutation` | `ProjectBranchPatternUpdateRequest` | `ProjectEditResponse` |
| `project.clone.start` | `mutation` | `ProjectCloneStartRequest` | `ProjectCloneStartResponse` |
| `project.clone.subscribe` | `subscription` | `ProjectCloneRequest` | `ProjectCloneStatus` (stream) |
| `project.clone.answer` | `mutation` | `ProjectCloneAnswerRequest` | `EmptyPayload` |
| `project.clone.cancel` | `mutation` | `ProjectCloneRequest` | `EmptyPayload` |
| `project.clone.folder.read` | `query` | `EmptyPayload` | `ProjectCloneFolderReadResponse` |
| `project.largeFile.pull` | `mutation` | `ProjectCloneRequest` | `EmptyPayload` |

The Rust types live in `crates/sidekicks-contracts/src/repo/folders.rs` (`repoMount.attach`, `repoMount.read`, `repoMount.list`, `machine.folder.list`, `repoMount.detach`, `repoMount.reattach`), `crates/sidekicks-contracts/src/repo/workspace.rs` (`workspace.bind`, `workspace.list`), `crates/sidekicks-contracts/src/project.rs` (the `project.*` methods) and `crates/sidekicks-contracts/src/repo/clone.rs` (`project.clone.start`, its card, its questions, its folder and `project.largeFile.pull`), the generated TypeScript at the matching `.ts` paths under `packages/contracts/src/`, per the api-payload-contracts.md §Source-of-Truth Policy; `crates/sidekicks-contracts/src/repo/methods.rs` declares every method of this table in the method table.

**The folders the service can reach.** `repoMount.list {}` lists every folder the service can reach, each with its `path` in its place's own form, its `place` (absent on macOS and Linux; on Windows `"windows"` or `{distro}`, since a Linux path alone cannot tell two distributions apart), its origin (`attached`, `managed` or `worktree`) and how many sessions use it; a project's worktrees follow their project's folder and its place. `project.subscribe` rows carry the same `place`, fixed at attach, and `repoMount.attach`'s and `repoMount.read`'s answers carry the mount's `place`, the place both its paths are written in. `repoMount.attach` takes the picked path, `{localPath, place?}`, where `place` is a distribution, `{distro}`, given only with a Linux path given in that distribution and absent wherever the path's own form says, Windows itself among them; the daemon decides the mount's place from them: a drive path, `/mnt/<drive>` given inside a distribution included, is Windows; a `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…` path, or a Linux path given from inside a distribution, is that distribution; a folder in a WSL 1 distribution is refused `repoMount.distributionNeedsWsl2`, and a path in a distribution not on this computer `repoMount.distributionNotFound` (error-contracts.md §Repo Mount). `machine.folder.list` lists the machine's folders in place for another device. `machine.folder.list` takes one folder, `{place?, path?, filter?, showHidden?}`, which opens that place's home folder when no path is given, its `place` a distribution, `{distro}`, and absent for Windows itself and on macOS and Linux; or `{top: true}`, the top level of a Windows computer, which starts no distribution; macOS and Linux have no top level and refuse `{top: true}` with `machine.folder.topLevel.notOffered`. The top level answers `{top: true, entries}`: the Windows drives first, `{kind: "drive", path}`, then one entry per WSL 2 distribution, `{kind: "distribution", place: {distro}}`, drawn `Ubuntu (WSL)`, which opens with `machine.folder.list {place: {distro}}` on its home folder, listed through its WSL server. A folder answers `{place?, path, segments, entries, more}`, its segments `{kind: "top"}` or `{kind: "folder", name, path}`: on Windows the first is `top`, so the device can go back up and change drive or distribution; macOS and Linux have no top segment. The answer's `place` is absent on macOS and Linux. A folder's answer carries the folder in view as the service writes its path, the path's segments from the top down (the last is the folder in view, each pressable to go back), every folder in it with its `name`, its `path` and whether it `isRepository`, and `more: true` when the filter would narrow further. The entries come in the machine's language order with numbers read by value (`build-9` before `build-10`). The service may page the entries or load them incrementally, and no folder is unreachable from it. A place naming a WSL 1 distribution is refused `repoMount.distributionNeedsWsl2`, and one naming a distribution not on this computer `repoMount.distributionNotFound`.

Plan-007's worktree surface adds the `worktree.*` methods, `workspace.executionRoot.prepare`, `project.branch.list` and `session.workingFolder.subscribe` (Plan-007 D-007-3), and the session move `session.workingFolder.update`, which registers on the session root (session-payloads.md §Session Method-Name Registry). A session's place is chosen in `session.create` or `workspace.bind`, so no mode select exists, and a worktree's figures ride `worktree.status.read`, so no reuse check exists. Registration rides the same Plan-005-partial `MethodRegistry` path. Method strings stay imperative and disjoint-by-form from the past-participle Spec-005 durable event names (`worktree.created` through `worktree.retired`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `workspace.executionRoot.prepare` | `mutation` | `WorkspaceExecutionRootPrepareRequest` | `WorkspaceExecutionRootPrepareResponse` |
| `worktree.retire` | `mutation` | `WorktreeRetireRequest` | `WorktreeRetireResponse` |
| `worktree.status.read` | `query` | `WorktreeStatusReadRequest` | `WorktreeStatusReadResponse` |
| `project.branch.list` | `query` | `ProjectBranchListRequest` | `ProjectBranchListResponse` |
| `session.workingFolder.subscribe` | `subscription` | `SessionWorkingFolderSubscribeRequest` | `WorkingTreeChange` (stream) |
| `worktree.setup.subscribe` | `subscription` | `WorktreeSetupRequest` | `WorktreeSetupStatus` (stream) |
| `worktree.setup.retry` | `mutation` | `WorktreeSetupRequest` | `EmptyPayload` |
| `worktree.copy.subscribe` | `subscription` | `WorktreeCopySubscribeRequest` | `WorktreeCopyProgress` (stream) |
| `worktree.removed.list` | `query` | `WorktreeRemovedListRequest` | `WorktreeRemovedListResponse` |
| `worktree.restore` | `mutation` | `RemovedWorktreeRequest` | `WorktreeRestoreResponse` |
| `worktree.removed.delete` | `mutation` | `RemovedWorktreeRequest` | `EmptyPayload` |

The Rust types live in `crates/sidekicks-contracts/src/worktree/lifecycle.rs` (`workspace.executionRoot.prepare`, `worktree.retire`, `worktree.status.read`; Plan-007 D-007-1), `crates/sidekicks-contracts/src/worktree/removed.rs` (the kept worktrees), `crates/sidekicks-contracts/src/worktree/setup.rs` (the setup card), `crates/sidekicks-contracts/src/worktree/copy_progress.rs` (the copies across volumes) and `crates/sidekicks-contracts/src/repo/git_reads.rs` (`project.branch.list`, `session.workingFolder.subscribe`), the generated TypeScript at the matching `.ts` paths under `packages/contracts/src/`, per the api-payload-contracts.md §Source-of-Truth Policy.

**The base list is `project.branch.list {repoMountId}`,** the one ordered list both base pickers draw: the default branch, then the branches this project's last picks came from, most recent first, then the rest by their newest commit. Each branch carries `ahead` and `behind` against its upstream, absent when it has none, and `heldBy`, the worktree that has it checked out, which the create form's list grays: its name always, and its `worktreeId` only for a tree the app made, so the project's own checkout and a tree the person made carry the name alone. `countsAsOf` is present when the last background fetch failed and says when the figures were last true.

**The setup card is `worktree.setup.subscribe {worktreeId}`.** Each emission is the whole card for one tree: its state and every step in run order across the three stages (making the tree, the project's own setup steps, warming what the session reads first), each with its label, its state, its elapsed time once it has run, and its error and the tail of its output when it failed. The steps are kept, so the card reads the same after leaving the session and coming back. A tree with no card to show — its setup did not run since the daemon started, or it has none — gets one emission in state `notRun` with no steps. `worktree.setup.retry {worktreeId}` runs the failed step and the ones after it.

**The worktree-candidate read is `worktree.status.read`, widened rather than joined by a sibling.** The switcher's rows need ahead, behind, dirtiness and occupancy per candidate directory; those members are on that read's own worktree rows. The read is keyed by project, `{projectId, sessionId?}`, and lists every worktree git lists for the repository, each row carrying its folder `path`, the path `session.workingFolder.update {sessionId, path}` takes: a tree the app made (`madeBy: "app"`) adds its record — its id, base, state and who made it — and a tree the person made (`madeBy: "person"`) carries none and has no removal. One read rather than two is the contract, not a convenience: a switcher composing its rows from a status read and a separate counts read could draw a directory as free while another read called it occupied, and the trash lock is exactly the affordance that must never be wrong.

**The tree-staleness signal is the daemon's, never the pane's inference.** `session.workingFolder.subscribe {sessionId}` carries it. The daemon watches the session's working folder and emits the signal; Review draws a reload affordance from it and re-reads nothing until the person presses. A working folder too large for the machine's own watch limit is checked on a slow tick instead, and the signal says which mode produced it, because a stale mark that is slow to arrive must not read as a tree that never changed. The bound is read from what the machine's watch limit allows and is never a figure on a screen.

**The worktree records the console depends on.** Creating and removing a worktree each leave a durable record under one category, so those rows survive a reload; a removal additionally leaves a PER-SESSION record for each session it swept back to the repo root, because the sweep changes where that session is standing and the session's own flow has to say so. Removal clears every pending working-folder move pointing at the removed tree, is refused while an agent is running in it, and never stops a run. The lifecycle records are `worktree.created` and `worktree.retired`, and the per-session one is `session.sweptToCheckout`; the taxonomy census is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s, and what is fixed here is that these records exist and what each carries.

**Removing a worktree keeps what it discards.** `worktree.retire {worktreeId, discard}` is the one removal of a worktree the app made, from the worktree switcher and from Runtime's `Remove`; a project's own folder is removed only by `repoMount.detach`. `discard: false` is the ordinary removal: when the tree has something to lose that the confirm did not show, it is refused with `worktree.retireConflict`, whose `reason` is `rootBusy`, naming the session whose agent runs in the tree, or `hasChanges` and, for `hasChanges`, carries the current risks so the confirm redraws them; ignored files such as an `.env` count as something to lose. `discard: true` is sent only after the discard confirm, and the daemon keeps what it discards until the person deletes it: the tree's own shells and project processes end first, then the folder moves whole into `worktrees/<project>/.removed/`, git's per-worktree record is copied, the staged objects are packed, the large-file objects staged pointers name are kept, and every commit the kept record names is pinned under `refs/sidekicks/removed/<id>/`. That removal's result carries `kept: {removedWorktreeId}`, and its `worktree.retired` record carries the same `removedWorktreeId`. Nothing deletes a kept worktree on its own. `worktree.removed.list {projectId?}` lists the kept worktrees for Runtime, each row `{removedWorktreeId, projectId, name, branch, headCommit, removedAt, sizeBytes, sizeReadAt, unreadablePutBackFolder}`, and what is left of a copy put back is listed only while it is the one source to rebuild a live tree put back that git cannot read, `unreadablePutBackFolder` naming that tree's folder, which is otherwise null. `worktree.restore {removedWorktreeId}` is `Put back`, from the switcher, the swept sessions' flow row and Runtime: the tree goes back on its own branch when that branch still points at the recorded commit and no other worktree holds it, and otherwise on `<branch>-restored`, at its own folder or `<name>-restored`, a taken name taking the next free number (`-restored-2` and on), one number shared by the folder and a new branch, and `branch` naming the branch used; what is left of a copy whose put-back tree git cannot read is put back again from its files while they are whole, its link moving to the new tree; it answers `{outcome: "restored", worktreeId, path, branch, onNewBranch}` or `{outcome: "refused", refusal}`, the refusal's `reason` being `projectNotAttached`, `repositoryMissing` with the `path` where the repository is missing, or `keptTreeMissing` when the kept folder no longer holds the tree, which `Delete now` still removes; a restore records `worktree.created` with `restoredFrom`, and a refused put-back keeps the kept copy. `worktree.removed.delete {removedWorktreeId}` is `Delete now`, which removes the kept folder and its pins. Where a removal or a put-back would cross a volume, the daemon copies the tree, and `worktree.copy.subscribe {projectId?}` carries the copies under way, one project's or every project's when `projectId` is absent: each emission is the whole list, `{copies}`, each copy either `{kind: "removing", worktreeId, projectId, name, copiedBytes, totalBytes}` for a worktree being removed or `{kind: "puttingBack", removedWorktreeId, projectId, name, copiedBytes, totalBytes}` for a kept worktree being put back, its id and `name` those of the row it draws on, `totalBytes` the size of every file the copy makes and `copiedBytes` the bytes written so far, the file being copied included. A copy's progress is sent four times a second while it runs, and once more when it ends, which drops it from the list, and there is no `Cancel`.

**Project administration.** A project is its own durable record kept beside its mount: its display name, its archived mark, its worktree setup steps, its own environment rows, its own branch-name pattern and, on a Windows computer, its place. `project.subscribe` is the live list the sessions list's project headers and Settings › Projects read, so a project attached on another device appears at once; each row carries the per-project tally of its sessions running, waiting on the person and done, which the daemon counts and serves live and the renderer never counts, and `isDistributionRemoved: true` when the project's WSL 2 distribution is no longer on this computer, so its sessions cannot run and the row reads `Ubuntu is no longer on this computer.` with `Remove`. The actions on a project's row:

- **Rename** is `project.rename`: it sets the display name and leaves the folder on disk untouched. It is the only name a person types for a project; the folder's own basename stands until they do.
- **Open in editor** is the bridge's `native.openInEditor`, which opens the project's folder in the editor Settings › General names.
- **Archive** is `project.archive`: it takes the project out of the session list's grouping and into an archived group carrying one action, unarchive; its sessions are kept and come back with it. **Unarchive** is `project.reactivate`, the inverse, which restores the grouping.
- **Delete** is `repoMount.detach`, the project's one removal act and the same act as Runtime's `Remove` on the project's folder. It is refused only while an agent runs anywhere in the project. It takes the project out of the projects page and out of the session list, forgets its setup steps and its branch-name pattern, and ARCHIVES its sessions, which stay readable. Nothing on disk is touched and it is not undoable, which is why the confirm states all three facts before it acts.
- **The setup steps** are written through `project.setup.update`: a per-project recipe — files to copy, a file the tree already has kept as it is, commands to run in order, and an optional time limit each command is given up on after, its absence meaning no limit — read and written from the projects page. They run with the repository's own git config, its hooks included, raise no approval card at any permission level, and make no approval rule. They are the person's own list on this machine rather than a file inside the repository.
- **The environment rows** are two lists. The machine-wide list is passed to every process the app starts and belongs to the machine's settings file, written through `machine.settings.update`; a project's own list, written through `project.environment.update`, is passed to every process that project's sessions start and belongs to the project record. A name in a project's list WINS over the same name machine-wide. The daemon reads both lists when it starts a project's process. A credential-shaped name is refused at save, in the list it was typed into, and nothing is written — credentials live in the account's credential home, never in an environment row — and so is a name the app sets itself on the processes it starts.
- **The branch-name pattern** is written through `project.branchPattern.update {projectId, pattern | null}`, `null` returning the project to the machine's own pattern, the `Every project` pattern, a key in the machine's settings file written through `machine.settings.update`.

**Cloning from a URL.** `Clone repository…` in the new-session picker clones a repository and attaches the finished folder as `Open folder…` attaches one; the session is minted at once. `project.clone.folder.read {}` → `{folder, place?, source: setting | lastProject | home}` is the one answer to where a clone goes, `place` the WSL 2 distribution a Linux folder is in and absent wherever the folder's own form says: the folder `Clone new repositories into` on Settings › Projects names (a key in the machine's settings file), else the folder holding the most recently attached project, else the home folder. `project.clone.start {url, parentFolder?, place?, projectId?, clientIdempotencyKey}` → `{projectId}`, `place` the distribution a Linux `parentFolder` is in, creates the project record at once (`clientIdempotencyKey`, a UUID, makes a resend under the same key after a reconnect answer the first clone's `projectId`, never start a second: return-or-conflict on the call's own record, a resend whose address, `parentFolder`, `place` or `projectId` differs refused `project.clone.idempotencyConflict` with the first `projectId`, the address compared with its credentials taken out), marked as cloning, and a `projectId` reruns a failed or canceled clone of that project. The address or path the person typed goes to git as typed, and git's own transport rules decide; submodules are included, and a destination that exists and is not empty is refused before anything is fetched. A parent folder whose resolved path is not valid Unicode is refused `repoMount.rootResolutionFailed` with reason `notUnicode`, and a relative `parentFolder` `request.paramsInvalid`, before anything is written. A folder in a WSL 1 distribution is refused `repoMount.distributionNeedsWsl2`, and one in a distribution not on this computer `repoMount.distributionNotFound`, which `project.clone.folder.read` also answers for a folder set for clones in such a distribution. The daemon runs git as an argument list with the person's own git config and credentials, stores no credential, and routes git's questions — a user name, a password or token, a key's passphrase, whether to trust a host's key — through its own askpass mode, which git runs by its `sidekicks-git-askpass` link, so no command interpreter reads the question, to the clone card in the composer. `project.clone.subscribe {projectId}` streams the card's state — the phase, the percent, a question waiting, the failure line in git's own words, and done — at most four updates a second, the latest winning; a failure names its step: `clone`, `largeFiles`, or `sessions` when the sessions that waited on the clone could not be started after it attached; `project.clone.answer {projectId, questionId, answer}` answers git's question, and the answer goes to git and nowhere else; `project.clone.cancel {projectId}` stops git and removes the folder the clone made before the card offers `Clone` again. Where the cloned repository keeps large files in Git LFS and Git LFS is not installed, `project.largeFile.pull {projectId}` fetches them once it is. A finished clone ends in the daemon's ordinary attach, and the project then reads `active` in the live `project.subscribe`; `repoMount.attached` is the daemon's own record and has no wire shape.
