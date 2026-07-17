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
- Repo attach must resolve and persist the canonical repository root, not only the user-entered path.
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
- If canonical root resolution fails, repo attach must fail explicitly rather than guessing.
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

- Repo attach should not assume that the user-selected path is already the repo root.
- Workspace binding must remain explicit even when a session has only one repo mount.
- Repo mount ownership belongs to the runtime node that can actually access the filesystem path.

## Pitfalls To Avoid

- Treating a user-entered path as canonical without resolution
- Auto-writing to a workspace before execution mode is explicitly chosen
- Allowing client-only workspace binding with no daemon validation

## Acceptance Criteria

- [ ] Attaching a repository yields a durable repo mount with canonical root metadata.
- [ ] A session can contain multiple repo mounts and multiple bound workspaces.
- [ ] Non-git directory workspaces remain usable without pretending to support git-only features.

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

## Repo Mount Health (V1 Definition)

Repo mount health is the daemon-probed reachability of the mount's canonical root, exposed as a daemon-owned projection (`RepoMountHealth { status: "healthy" | "unreachable"; checkedAt: string }` — see [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-009). `status` is `healthy` when the canonical root is present and readable at probe time, `unreachable` otherwise; `checkedAt` is the ISO-8601 instant of the probe that produced the verdict. Health is derived at read time (every health-reporting read surface probes synchronously — the on-read floor) and refreshed by the daemon-owned background metadata refresh (§Default Behavior); it is never persisted as a row column and is distinct from the lifecycle `state` axis (§State And Data Implications).

## Detach Semantics (V1 Definition)

`RepoDetach` must accept a repo mount id and transition the mount to `detached` without deleting the durable record (request/response shapes in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-009).

- Detach is refused with `repo.detach_conflict` while any dependent workspace is `busy`; active work must finish or be cancelled first. There is no force-detach in V1.
- Otherwise, detach transitions the mount to `detached` and archives all dependent workspaces (`workspaces.state -> 'archived'`), emitting `repo.detached` plus one `workspace.archived` per dependent workspace (Spec-006 `session_lifecycle` taxonomy). Archived workspaces remain historically linked to completed runs. Dependent non-terminal worktree and ephemeral-clone rows follow via the Plan-010 asynchronous retirement sweep (`Spec-010 §Fallback Behavior` — retirement recorded and evented, metadata preserved).
- `detached` is terminal for the row: there is no `detached -> attached` transition. Re-attaching the same canonical root creates a NEW repo mount row (the active-mount uniqueness index constrains only `state = 'attached'` rows).
- The desktop renderer exposes no detach surface in V1; detach is SDK/CLI-surfaced only (renderer behavior is unspecified by this spec).

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
