# Plan-009: Repo Attachment And Workspace Binding

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `repo-attachment-and-workspace-binding` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-009: Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md) |

## Goal

Implement durable RepoMount attachment and explicit workspace binding for session execution.

## Scope

This plan covers repo root resolution, RepoMount persistence, workspace creation, and workspace health projection.

## Non-Goals

- Worktree lifecycle
- PR preparation
- Rich diff UI

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [ ] Blocking open questions are resolved or explicitly deferred

## Target Areas

- `packages/contracts/src/repo.ts`
- `packages/runtime-daemon/src/workspace/repo-mount-service.ts`
- `packages/runtime-daemon/src/workspace/workspace-service.ts`
- `packages/runtime-daemon/src/workspace/workspace-projector.ts`
- `packages/client-sdk/src/repoClient.ts`
- `apps/desktop/renderer/src/repo-attach/`

## Data And Storage Changes

- Add local `repo_mounts` and `workspaces` tables with health and ownership fields.

## API And Transport Changes

- Add repo attach or detach and workspace bind or list APIs to the client SDK.

## Implementation Steps

1. Implement canonical repo root resolution and trust-boundary validation.
2. Add RepoMount and workspace persistence plus projections.
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
