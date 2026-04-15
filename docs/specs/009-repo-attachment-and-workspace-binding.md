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
- `WorkspaceBind` must accept repo mount or directory root plus intended execution mode from the canonical mode set where applicable.
- `WorkspaceExecutionModeCapabilitiesRead` must expose which execution modes are currently valid for the bound repo mount or workspace.
- `WorkspaceList` must expose workspace health and current binding state.

## State And Data Implications

- Repo mount records must persist canonical root, owner node, and lifecycle state.
- Workspace records must persist execution root, repo association, and health.
- Repo health and git metadata belong to daemon-owned projection state rather than client cache.

## Example Flows

- `Example: A participant attaches a repository to a session. The daemon resolves the canonical repo root, stores a repo mount, and exposes a default workspace for inspection.`
- `Example: A participant later selects worktree mode for a coding run. The workspace remains the same session-bound concept, but the daemon provisions an isolated execution root before the run starts.`
- `Example: A plain directory is attached for planning work. It becomes a valid workspace, but git-specific commands remain unavailable.`

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

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: the first implementation binds existing local checkouts only. Clone-from-URL attach flows are out of scope for v1.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
