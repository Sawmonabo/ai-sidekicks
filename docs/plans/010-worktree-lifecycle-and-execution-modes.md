# Plan-010: Worktree Lifecycle And Execution Modes

| Field               | Value                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Status**          | `approved`                                                                                                               |
| **NNN**             | `010`                                                                                                                    |
| **Slug**            | `worktree-lifecycle-and-execution-modes`                                                                                 |
| **Date**            | `2026-04-14`                                                                                                             |
| **Author(s)**       | `Codex`                                                                                                                  |
| **Spec**            | [Spec-010: Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)               |
| **Required ADRs**   | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies**    | [Plan-009](./009-repo-attachment-and-workspace-binding.md) (workspace infrastructure)                                    |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                |

## Goal

Implement the four-mode repo execution contract with worktree-first writable defaults plus the lifecycle management around worktree preparation, reuse, retirement, and ephemeral clone preparation.

## Scope

This plan covers execution mode selection, read-only and branch gating, worktree creation, ephemeral clone preparation, reuse validation, lifecycle projection, and fallback handling.

## Non-Goals

- PR preparation
- Diff attribution logic
- Non-repo directory execution semantics
- Automatic repository setup-script execution during execution-root preparation

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/execution-mode.ts`
- `packages/runtime-daemon/src/workspace/execution-root-service.ts`
- `packages/runtime-daemon/src/git/worktree-service.ts`
- `packages/runtime-daemon/src/git/ephemeral-clone-service.ts`
- `packages/runtime-daemon/src/workspace/execution-mode-service.ts`
- `packages/runtime-daemon/src/git/worktree-projector.ts`
- `packages/client-sdk/src/worktreeClient.ts`
- `apps/desktop/renderer/src/execution-mode-picker/`

## Data And Storage Changes

- Add local `worktrees`, `ephemeral_clones`, and `branch_contexts` tables.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add execution-mode select, execution-root prepare, worktree reuse-check, ephemeral clone prepare, and retire APIs.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Implement execution-mode contracts and persistence.
2. Build branch, worktree, and ephemeral clone prepare or reuse or retire services in the daemon.
3. Integrate run setup so repo-bound runs require a resolved execution root consistent with the selected mode.
4. Add desktop execution-mode picker and worktree status UI.

## Parallelization Notes

- Execution-mode contract work and git-service work can proceed together.
- UI work should start after worktree status projection payloads are stable.

## Test And Verification Plan

- Execution-mode selection tests across read-only, branch, worktree, and ephemeral clone
- Worktree create and reuse tests
- Ephemeral clone prepare and cleanup tests
- Failure-path tests that ensure no silent main-checkout mutation
- Tests proving execution-root preparation does not auto-run repository setup scripts
- Manual verification of worktree lifecycle from create through retire

## Rollout Order

1. Ship worktree persistence and daemon services
2. Enforce canonical execution-mode resolution in repo-bound run setup
3. Enable desktop execution-mode controls

## Rollback Or Fallback

- Disable automatic worktree creation and require explicit branch or read-only mode if rollout blocks too much valid work.

## Risks And Blockers

- Branch naming collisions
- Git edge cases on repos with unusual worktree support
- Ephemeral clone cleanup may leak disk usage without strong lifecycle handling
- Repositories with mandatory bootstrap steps will need explicit follow-on setup flows or workflows rather than hidden automatic preparation

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
