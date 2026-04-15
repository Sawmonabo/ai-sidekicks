# ADR-006: Worktree First Execution Mode

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `proposed` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Git Workflow` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `Pending assignment` |

## Context

Writable coding runs need isolation from the main checkout, attributable diffs, and a predictable path toward review and PR preparation.

## Problem Statement

What should be the default execution mode for writable repo-bound coding runs?

### Trigger

The repo and worktree domain docs and specs need a default execution stance before plans can be written.

## Decision

We will use the four-mode execution taxonomy `read-only`, `branch`, `worktree`, and `ephemeral clone`, and we will default writable coding runs to dedicated `worktree` execution rather than mutating the main checkout.

## Alternatives Considered

### Option A: Four-Mode Taxonomy With Worktree-First Writable Default (Chosen)

- **What:** Standardize repo-bound runs on `read-only`, `branch`, `worktree`, and `ephemeral clone`, with `worktree` as the default writable coding mode.
- **Steel man:** Gives one complete execution model while preserving strong isolation, better provenance, and cleaner PR flow.
- **Weaknesses:** Adds branch, worktree, and clone management overhead.

### Option B: Branch-Or-Main-Checkout Mutation By Default (Rejected)

- **What:** Let writable runs default to an existing checkout branch and only opt into isolation when requested.
- **Steel man:** Simpler mental model and lower setup cost.
- **Why rejected:** Increases risk, weakens attribution, and makes clean review flow harder.

### Option C: Ephemeral-Clone-First Isolation By Default (Rejected)

- **What:** Use disposable clones as the normal writable path instead of worktrees.
- **Steel man:** Works even when worktrees are awkward or unsupported.
- **Why rejected:** Heavier on disk and less aligned with normal gitflow than worktrees when worktrees are available.

## Reversibility Assessment

- **Reversal cost:** Moderate. Branch strategy, UI defaults, and plans would need adjustment.
- **Blast radius:** Worktree prep, repo UI, diff attribution, PR prep, and docs.
- **Migration path:** Change execution defaults and migrate outstanding plan assumptions; existing worktrees remain usable.
- **Point of no return:** After plans, operations, and UI defaults deeply assume worktree-first behavior.

## Consequences

### Positive

- Better isolation for mutable coding runs
- One execution-mode taxonomy that matches the product vision end to end
- Cleaner provenance and review behavior

### Negative (accepted trade-offs)

- More worktree lifecycle management
- Some repositories will need explicit `branch` or `ephemeral clone` fallback when worktrees are unavailable

### Unknowns

- How often users will prefer explicit `branch` mode or `ephemeral clone` mode for special maintenance tasks

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `domain/repo-workspace-worktree-model.md` | Canonical domain doc | Worktree-backed execution is the default coding mode and the main checkout is not the default write target | [domain/repo-workspace-worktree-model.md](../domain/repo-workspace-worktree-model.md) |
| `specs/010-worktree-lifecycle-and-execution-modes.md` | Canonical spec | Worktree-first is the default writable execution contract | [specs/010-worktree-lifecycle-and-execution-modes.md](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| `specs/011-gitflow-pr-and-diff-attribution.md` | Canonical spec | Worktree-backed execution supports attributable diff review and PR preparation | [specs/011-gitflow-pr-and-diff-attribution.md](../specs/011-gitflow-pr-and-diff-attribution.md) |

### Related Domain Docs

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)

### Related Specs

- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/011-gitflow-pr-and-diff-attribution.md)

### Related ADRs

- [SQLite Local State And Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Re-baselined | Reviewer assignment and template-complete acceptance remain incomplete |
