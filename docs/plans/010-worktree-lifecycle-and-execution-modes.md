# Plan-010: Worktree Lifecycle And Execution Modes

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `010` |
| **Slug** | `worktree-lifecycle-and-execution-modes` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-010: Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md) |

## Goal

Implement worktree-first writable execution and the lifecycle management around worktree preparation, reuse, and retirement.

## Scope

This plan covers execution mode selection, worktree creation, reuse validation, lifecycle projection, and fallback handling.

## Non-Goals

- PR preparation
- Diff attribution logic
- Clone-based workspace strategy

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [ ] Blocking open questions are resolved or explicitly deferred

## Target Areas

- `packages/contracts/src/execution-mode.ts`
- `packages/runtime-daemon/src/git/worktree-service.ts`
- `packages/runtime-daemon/src/workspace/execution-mode-service.ts`
- `packages/runtime-daemon/src/git/worktree-projector.ts`
- `packages/client-sdk/src/worktreeClient.ts`
- `apps/desktop/renderer/src/execution-mode-picker/`

## Data And Storage Changes

- Add local `worktrees` and `branch_contexts` tables.

## API And Transport Changes

- Add execution-mode select, worktree prepare, reuse-check, and retire APIs.

## Implementation Steps

1. Implement execution-mode contracts and persistence.
2. Build worktree prepare or reuse or retire services in the daemon.
3. Integrate run setup so writable coding runs require resolved worktree state.
4. Add desktop execution-mode picker and worktree status UI.

## Parallelization Notes

- Execution-mode contract work and git-service work can proceed together.
- UI work should start after worktree status projection payloads are stable.

## Test And Verification Plan

- Worktree create and reuse tests
- Failure-path tests that ensure no silent main-checkout mutation
- Manual verification of worktree lifecycle from create through retire

## Rollout Order

1. Ship worktree persistence and daemon services
2. Enforce worktree resolution in writable run setup
3. Enable desktop execution-mode controls

## Rollback Or Fallback

- Disable automatic worktree creation and require explicit local mode if rollout blocks too much valid work.

## Risks And Blockers

- Branch naming collisions
- Git edge cases on repos with unusual worktree support

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
