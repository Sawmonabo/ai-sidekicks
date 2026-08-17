# Spec-009: Repo Attachment And Workspace Binding

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `repo-attachment-and-workspace-binding` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Session Model](../domain/session-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md) |
| **Implementation Plan** | [Plan-009: Repo Attachment And Workspace Binding](../plans/009-repo-attachment-and-workspace-binding.md) |

## Purpose

Define how repositories are attached to sessions and how workspaces are bound to execution.

## Scope

This spec covers repo mount creation, canonical root resolution, workspace binding, and non-git directory fallback.

## Non-Goals

- Worktree lifecycle details
- PR creation policy
- Artifact rendering

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [ADR-006: Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)

## Required Behavior

- Attaching a repository to a session must be an explicit action that creates a durable `RepoMount`.
- Repo attach must resolve and persist the canonical repository root — the MAIN checkout's working-tree root, identified by the repository's git common directory rather than by the top level of whatever working tree the supplied path sits in — not only the user-entered path (§Repo Identity And Common-Directory Keying (V1 Definition)).
- The system must support multiple repo mounts in one session.
- Workspace binding must be explicit and must resolve to one concrete execution root before a run begins.
- Git-backed workspace binding must support the canonical execution-mode taxonomy `read-only`, `branch`, `worktree`, and `ephemeral clone`.
- The system must reject path traversal or workspace binding outside the declared local trust envelope.
- Non-git directory workspaces must be supported as a fallback, but with reduced git-aware capabilities.

## Default Behavior

- Attaching a git repository defaults to creating one repo mount and one default workspace view rooted at the main checkout.
- Newly attached workspaces default to `read-only` context until a run explicitly selects a writable execution mode.
- Repo metadata defaults to background refresh through daemon-owned git services.

## Fallback Behavior

- If a path is not a git repository, the system may bind it as a plain directory workspace with git-specific features disabled.
- If a workspace cannot support one or more git-backed execution modes, the daemon must expose that capability gap explicitly rather than silently substituting a different mode.
- If canonical root resolution fails, repo attach must fail explicitly rather than guessing; a supplied path that does not exist, and a path whose git metadata is present but unusable, are both resolution failures and must never be attributed to an ancestor repository (§Repo Identity And Common-Directory Keying (V1 Definition)).
- If a workspace path becomes unavailable after binding, the workspace transitions to `stale` and new write runs must be blocked until repair.

## Interfaces And Contracts

- `RepoAttach` must accept a local path, session id, and owning runtime node.
- `RepoMountRead` must expose canonical root, VCS metadata, and current health.
- `WorkspaceBind` must accept repo mount or directory root plus intended execution mode from the canonical mode set where applicable. Directory-root binding is expressed by first attaching the directory as a plain-directory repo mount (`vcs_type = 'none'`); `WorkspaceBind` always references a repo mount.
- `WorkspaceExecutionModeCapabilitiesRead` must expose which execution modes are currently valid for the bound repo mount or workspace.
- `WorkspaceList` must expose workspace health and current binding state.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Repo mount records must persist canonical root, owner node, and lifecycle state.
- Workspace records must persist execution root, repo association, and health.
- Repo health and git metadata belong to daemon-owned projection state rather than client cache.

## Example Flows

- `Example: A participant attaches a repository to a session. The daemon resolves the canonical repo root, stores a repo mount, and exposes a default workspace for inspection.`
- `Example: A participant later selects worktree mode for a coding run. The workspace remains the same session-bound concept, but the daemon provisions an isolated execution root before the run starts.`
- `Example: A plain directory is attached for planning work. It becomes a valid workspace, but git-specific commands remain unavailable.`

## Execution Mode Transitions

When a workspace switches execution mode (e.g., `read-only` to `worktree`), the workspace entity is re-provisioned in place. The workspace ID remains the same; only the execution root changes.

State progression: `ready -> provisioning -> ready`.

- The old execution root is released and a new one is provisioned for the target mode.
- This is NOT a new workspace. The `workspaces` row keeps its `id`; `execution_mode` and `fs_root` are updated, and `state` cycles through `provisioning` before returning to `ready`.
- If the switch fails (e.g., the daemon cannot provision a worktree for the target mode), the workspace transitions to `stale` with an error detail recorded in the workspace's metadata. New write runs must be blocked until the workspace is repaired or the mode switch is retried.

### Ephemeral Clone Lifecycle

Ephemeral clones follow a linear lifecycle managed by the `ephemeral_clones` table (Plan-010).

States: `creating -> ready -> retired -> (deleted from disk)`.

- `creating`: Clone is being set up on disk. The workspace that owns it remains in `provisioning` until the clone reaches `ready`.
- `ready`: Clone is available for execution. The owning workspace transitions to `ready`.
- `retired`: Clone is marked for removal. No new runs may use it.
- `failed`: Handles creation failures. The owning workspace transitions to `stale`.

Cleanup triggers (any one is sufficient):

- Run completion (default, per `cleanup_policy = 'on_run_complete'`).
- Session archive (and workspace archival generally — e.g. the repo-detach cascade in §Detach Semantics; enforcement is the Plan-010 cleanup sweep).
- Explicit disposal by participant or daemon.
- TTL expiry (configurable as daemon configuration — not a wire parameter; default 24 hours).

Cleanup is asynchronous. The `ephemeral_clones` table marks the clone `retired` immediately. A background job removes the filesystem clone after the state change. This decouples the user-facing state transition from potentially slow disk I/O. Retiring the clone backing a live (non-archived) `ephemeral clone`-mode workspace's current root returns the owning workspace to `provisioning` via the workspace transition primitives — root unbound, awaiting the next per-run prepare; `stale` is reserved for fault paths such as preparation failures (`Spec-010 §Fallback Behavior`).

## Implementation Notes

- Repo attach should not assume that the user-selected path is already the repo root, nor that the working tree enclosing it is the repository's identity: a linked worktree's own top level is not its repository's main checkout root.
- Workspace binding must remain explicit even when a session has only one repo mount.
- Repo mount ownership belongs to the runtime node that can actually access the filesystem path.

## Pitfalls To Avoid

- Treating a user-entered path as canonical without resolution, or treating the enclosing working tree's top level as the repository's identity
- Auto-writing to a workspace before execution mode is explicitly chosen
- Allowing client-only workspace binding with no daemon validation

## Acceptance Criteria

- [ ] Attaching a repository yields a durable repo mount with canonical root metadata.
- [ ] A session can contain multiple repo mounts and multiple bound workspaces.
- [ ] Non-git directory workspaces remain usable without pretending to support git-only features.
- [ ] Attaching from a linked worktree and attaching from the same repository's main checkout resolve to one identical canonical root, so N working trees of one repository yield ONE repo mount while each bound workspace keeps its own per-worktree execution root.
- [ ] A supplied path that does not exist, a path whose git metadata is present but unusable, a working tree whose registration is missing or does not name it back, and a git pointer file that is not a regular file each fail repo attach explicitly rather than being attributed to an ancestor repository.

## ADR Triggers

- If repo mounts and workspaces cease to be separate concepts, create or update `../decisions/006-worktree-first-execution-mode.md` or a replacement architecture decision.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: the first implementation binds existing local checkouts only. Clone-from-URL attach flows are out of scope for v1.

## Local Trust Envelope (V1 Definition)

For repo attachment and workspace binding, the declared local trust envelope of a session is the set of fully resolved canonical roots of its attached repo mounts (including plain-directory mounts). Envelope admission is the explicit `RepoAttach` action; no path enters the envelope implicitly.

- A workspace execution root is inside the envelope iff its fully resolved form (absolute, symlink-resolved, platform-normalized) is path-contained within the fully resolved canonical root of a repo mount attached to the same session. Containment is path-component-boundary-aware (`/repo-evil` is not within `/repo`) and case-folded on case-insensitive filesystems (Windows tier per [ADR-019](../decisions/019-windows-v1-tier-and-pty-sidecar.md)).
- `WorkspaceBind`'s optional `directory` is resolved against the mount's canonical root and containment is re-checked AFTER symlink resolution; `..` traversal, absolute-path redirection, and symlink escape outside the mount root are rejected with the typed `repo.outside_trust_envelope` error.
- The node-level trust envelope governed by approval policy (`Spec-012 §Default Behavior`) is a separate run-time authorization layer; it is not this spec's bind-time validation and is out of scope here.
- Daemon-provisioned execution roots (Plan-010 worktrees and ephemeral clones under the daemon's execution-roots directory, keyed by the owning repo mount) are inside the envelope by construction: they are daemon-created derivatives of an admitted mount, never user-supplied paths, so the containment rule above governs user-supplied bind paths while provisioned roots are admitted by provenance (`Spec-010 §State And Data Implications`).
- A git-backed mount's envelope is its canonical root PLUS the working-tree paths the repository itself registers. Because the canonical root is the main checkout's root (§Repo Identity And Common-Directory Keying (V1 Definition)), a linked worktree of that repository is generally NOT path-contained within it, so containment alone would reject binds to working trees the repository demonstrably owns. Each registered path is admitted only when it passes the same bidirectional-link and physical-containment screens resolution applies; registration is read from the repository at bind time and never cached, so a working tree git no longer registers is no longer in the envelope. Containment within an admitted registered working tree is then checked exactly as it is within the canonical root (the containment rule above), and a user-supplied path that is neither contained in the canonical root nor in an admitted registered working tree is rejected with `repo.outside_trust_envelope` as before. This registration arm governs USER-SUPPLIED bind paths only; it does not narrow the provenance rule above. A daemon-provisioned execution root stays admitted by provenance regardless of its registration state, because the daemon knows it created that root — so a provisioned worktree whose registration git has pruned (the window between an external `git worktree prune` and the Plan-010 retirement sweep) remains in the envelope and is retired by that sweep rather than being silently ejected from it mid-run.

## Repo Mount Health (V1 Definition)

Repo mount health is the daemon-probed reachability of the mount's canonical root, exposed as a daemon-owned projection (`RepoMountHealth { status: "healthy" | "unreachable"; checkedAt: string }` — see [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-009). `status` is `healthy` when the canonical root is present and readable at probe time, `unreachable` otherwise; `checkedAt` is the ISO-8601 instant of the probe that produced the verdict. Health is derived at read time (every health-reporting read surface probes synchronously — the on-read floor) and refreshed by the daemon-owned background metadata refresh (§Default Behavior); it is never persisted as a row column and is distinct from the lifecycle `state` axis (§State And Data Implications).

## Detach Semantics (V1 Definition)

`RepoDetach` must accept a repo mount id and transition the mount to `detached` without deleting the durable record (request/response shapes in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-009).

- Detach is refused with `repo.detach_conflict` while any dependent workspace is `busy`; active work must finish or be cancelled first. There is no force-detach in V1.
- Otherwise, detach transitions the mount to `detached` and archives all dependent workspaces (`workspaces.state -> 'archived'`), emitting `repo.detached` plus one `workspace.archived` per dependent workspace (Spec-006 `session_lifecycle` taxonomy). Archived workspaces remain historically linked to completed runs. Dependent non-terminal worktree and ephemeral-clone rows follow via the Plan-010 asynchronous retirement sweep (`Spec-010 §Fallback Behavior` — retirement recorded and evented, metadata preserved).
- `detached` is terminal for the row: there is no `detached -> attached` transition. Re-attaching the same canonical root creates a NEW repo mount row (the active-mount uniqueness index constrains only `state = 'attached'` rows). Because the canonical root is the repository's main-checkout root (§Repo Identity And Common-Directory Keying (V1 Definition)), re-attaching from ANY working tree of a detached repository is a re-attach of that same canonical root and yields one new row for the repository, never one row per working tree.
- The desktop renderer exposes no detach surface in V1; detach is SDK/CLI-surfaced only (renderer behavior is unspecified by this spec).

## Repo Identity And Common-Directory Keying (V1 Definition)

A repository's identity is its git COMMON directory, not the top level of whatever working tree the supplied path happens to sit in. Git gives one repository many working trees — one main checkout plus N linked worktrees — and they share exactly one common directory (the main checkout's `.git`), which is why it is the only stable identity for that repository. The canonical root persisted on a repo mount is therefore the working-tree root of the MAIN checkout: the directory whose own `.git` IS that common directory. Attaching from a linked worktree resolves to that same main-checkout root, so N working trees of one repository resolve as ONE repo mount, and every daemon cache, filesystem watch, remote fetch, and throttle window keyed on repo identity is shared across them instead of duplicated per working tree.

- Identity keying does not move where work happens. A workspace's execution root (`workspaces.fs_root`) remains the per-working-tree path the participant bound or the daemon provisioned; only the repo-mount identity key (`repo_mounts.canonical_root`) collapses onto the main-checkout root. Resolution must therefore surface BOTH values — the repository identity and the enclosing working tree's own root — because attach persists the first and the default workspace of §Default Behavior roots at the second.
- Because the active-mount uniqueness index is keyed on the canonical root (§State And Data Implications), attaching a second working tree of an already-attached repository is a re-attach of the SAME repository and is refused as already attached rather than admitted as a second mount. Binding that working tree is a workspace operation on the existing mount, not a second attach.
- Resolution must refuse a supplied path that does not exist instead of walking up from it. Walking up lexically from a deleted or never-created path attributes it to whatever repository happens to contain its parent — a dotfiles repository checked out at the user's home directory is enough to make that attribution wrong for essentially every path beneath it.
- Resolution must distinguish "no git metadata here" from "git metadata here is unusable". An absent `.git` entry means the scan continues to the parent; a `.git` entry that is present but unreadable, malformed, or naming something that is not a usable git directory STOPS the scan with an explicit failure, because git itself stops there. Continuing past unusable metadata is precisely how a damaged repository gets silently attributed to its parent repository.
- A linked worktree is accepted as belonging to a repository only when git's link is BIDIRECTIONAL: the working tree's `.git` file names a git directory, AND that git directory's registration under `<common-dir>/worktrees/<name>/gitdir` names this working tree's own `.git` back. The registration must additionally be physically contained by the common directory it claims — the registered git directory's grandparent must canonically equal that common directory. A pointer file alone is attacker-writable and must never establish repository identity by itself.
- Every pointer file resolution reads — the working tree's `.git`, and the `commondir` / `gitdir` files under a git directory — must be stat-screened as a REGULAR file before it is opened, and read under a fixed byte ceiling. Without the screen, a FIFO named `commondir` planted in a scanned directory blocks the open indefinitely and wedges the scan; a device node or an unbounded file is the same hazard class.
- Both sides of every path comparison — bind containment, worktree-registration matching, and common-directory containment — must be canonicalized (symlink-resolved and absolutized) before they are compared. Comparing a canonicalized path against an uncanonicalized one produces false mismatches wherever the platform symlinks standard directories: on macOS `/tmp` is `/private/tmp`, so an uncanonicalized `/tmp/...` registration never equals its canonicalized peer and a legitimate worktree is refused.
- Each refusal above is a canonical-root resolution failure under §Fallback Behavior: attach fails explicitly with the typed root-resolution error rather than guessing a root. A path that is genuinely inside no repository remains the plain-directory fallback of §Fallback Behavior — a different outcome from a refusal, and the two must never be conflated, because classifying a refusal as a plain directory is exactly the silent misattribution this section exists to prevent.

## Notes

- **2026-08-16 — Repo-identity amendment (common-directory keying + resolution hardening).** This spec's canonical-root contract previously said only "resolve and persist the canonical repository root" and left the working-tree-vs-repository distinction unstated, so the shipped resolver read it as the enclosing working tree's own top level and gave every linked worktree of one repository its own repo identity. This amendment states the contract the daemon actually needs: identity keys on the git common directory (new §Repo Identity And Common-Directory Keying (V1 Definition)), execution roots stay per-working-tree, and resolution refuses nonexistent paths, unusable git metadata, unregistered or one-way worktree links, and non-regular pointer files rather than misattributing them to an ancestor repository. §Required Behavior, §Fallback Behavior, §Implementation Notes, and §Pitfalls To Avoid are amended in place at zero net line change so no inbound line cite moves; §Local Trust Envelope (V1 Definition) gains the git-registered-working-tree admission rule the identity change would otherwise have made unreachable — scoped to user-supplied bind paths so it never narrows the pre-existing provenance admission of daemon-provisioned execution roots, which would otherwise have ejected a provisioned worktree from the envelope mid-run in the window between an external `git worktree prune` and the Plan-010 retirement sweep — §Detach Semantics (V1 Definition) records that re-attach is per-repository rather than per-working-tree, and §Acceptance Criteria gains two criteria after the existing three. Per the audit runbook's spec-amendment rule this spec was flipped `approved -> review` for the amendment's review window and restored `approved` in the SAME diff by the targeted readiness-audit delta that accompanies it (the PR #278 same-PR flip-and-restore precedent); Plan-009's Preconditions audit checkbox re-opened scoped to this growth and re-checked with a Delivered record in the same diff. Ratified by the user 2026-08-16.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
