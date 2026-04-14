# ADR-006: Worktree First Execution Mode

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Git Workflow` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `TBD` |

## Context

Writable coding runs need isolation from the main checkout, attributable diffs, and a predictable path toward review and PR preparation.

## Problem Statement

What should be the default execution mode for writable repo-bound coding runs?

### Trigger

The repo and worktree domain docs and specs need a default execution stance before plans can be written.

## Decision

We will default writable coding runs to dedicated worktree execution rather than mutating the main checkout.

## Alternatives Considered

### Option A: Worktree-First Execution (Chosen)

- **What:** Create or reuse a dedicated worktree for writable coding work by default.
- **Steel man:** Gives strong isolation, better provenance, and cleaner PR flow.
- **Weaknesses:** Adds branch and worktree management overhead.

### Option B: Main Checkout Mutation By Default (Rejected)

- **What:** Let runs write directly into the primary checkout unless users opt into isolation.
- **Steel man:** Simpler mental model and lower setup cost.
- **Why rejected:** Increases risk, weakens attribution, and makes clean review flow harder.

### Option C: Clone-Or-Copy Isolation By Default (Rejected)

- **What:** Use copied directories or clones instead of git worktrees.
- **Steel man:** Works even when worktrees are awkward or unsupported.
- **Why rejected:** Heavier on disk and less aligned with normal gitflow than worktrees.

## Reversibility Assessment

- **Reversal cost:** Moderate. Branch strategy, UI defaults, and plans would need adjustment.
- **Blast radius:** Worktree prep, repo UI, diff attribution, PR prep, and docs.
- **Migration path:** Change execution defaults and migrate outstanding plan assumptions; existing worktrees remain usable.
- **Point of no return:** After plans, operations, and UI defaults deeply assume worktree-first behavior.

## Consequences

### Positive

- Better isolation for mutable coding runs
- Cleaner provenance and review behavior

### Negative (accepted trade-offs)

- More worktree lifecycle management
- Some repositories will need an explicit fallback when worktrees are unavailable

### Unknowns

- How often users will prefer explicit local mode for special maintenance tasks

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `005-repo-git-worktree-diff.md` | Extraction note | Worktree-backed coding is the strongest pattern for isolation and diff review | [tmp/extraction/005-repo-git-worktree-diff.md](../tmp/extraction/005-repo-git-worktree-diff.md) |
| `specs/010-worktree-lifecycle-and-execution-modes.md` | Canonical spec | Worktree-first is the default writable execution contract | [specs/010-worktree-lifecycle-and-execution-modes.md](../specs/010-worktree-lifecycle-and-execution-modes.md) |

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
| 2026-04-14 | Accepted | Selected as the default writable execution mode |
