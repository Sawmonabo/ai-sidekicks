# Plan-009: Repo Attachment And Workspace Binding

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `repo-attachment-and-workspace-binding` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-009: Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | None |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement durable RepoMount attachment and explicit workspace binding for session execution.

## Scope

This plan covers repo root resolution, RepoMount persistence, workspace creation, execution-mode capability exposure, and workspace health projection.

## Non-Goals

- Worktree lifecycle
- PR preparation
- Rich diff UI

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/repo.ts`
- `packages/runtime-daemon/src/workspace/repo-mount-service.ts`
- `packages/runtime-daemon/src/workspace/workspace-service.ts`
- `packages/runtime-daemon/src/workspace/workspace-projector.ts`
- `packages/client-sdk/src/repoClient.ts`
- `apps/desktop/src/renderer/src/repo-attach/`

## Data And Storage Changes

- Add local `repo_mounts` and `workspaces` tables with health, ownership, and execution-mode capability fields.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add repo attach or detach, workspace bind or list, and execution-mode capability read APIs to the client SDK.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Implement canonical repo root resolution and trust-boundary validation.
2. Add RepoMount and workspace persistence plus execution-mode capability projections.
3. Add client SDK methods for attach and workspace listing.
4. Add desktop repo attach and workspace-binding UI.

## Parallelization Notes

- RepoMount persistence and workspace projection work can proceed in parallel after contracts land.
- Desktop repo attach UI should wait on stable workspace health payloads.

## Test And Verification Plan

- Repo attach validation tests
- Workspace stale-state tests
- Manual verification of attaching multiple repositories to one session

## Rollout Order

1. Ship RepoMount and workspace persistence
2. Enable attach via internal tooling or CLI
3. Enable desktop repo attach UX

## Rollback Or Fallback

- Disable multi-repo attach and keep one RepoMount per session if the first rollout shows projection instability.

## Risks And Blockers

- Path canonicalization bugs can leak outside the intended trust envelope
- Stale workspace handling needs clear UX and blocking behavior

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
