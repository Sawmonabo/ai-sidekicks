# ADR-006: Worktree First Execution Mode

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 1 (two-way door)` |
| **Domain**    | `Git Workflow`          |
| **Date**      | `2026-04-14`            |
| **Author(s)** | `Codex`                 |
| **Reviewers** | `Accepted 2026-04-15`   |

## Context

A project session's agents edit files, and those edits need isolation from the checkout the person works in, attributable diffs, and a predictable path toward review and pull requests. How much a session may change is already carried by its permission level, so the place a session works in answers only where its files live.

## Problem Statement

Where does a project session work, and where does a new one start?

### Trigger

The repo and worktree domain docs and specs need a default execution stance before plans can be written.

## Decision

A project session works in one of two places: a worktree of its own, which the daemon makes under its own execution-roots directory and never inside the repository, or the checkout the project already has. There is no disposable copy and no read-only place, because how much a session may change is its permission level. A chat session always works in its own managed workspace, which is the checkout arm. A new project session starts in a new worktree of its own unless the person chose the checkout when creating it; the machine's `Default checkout for a new project session` setting, `A new worktree` out of the box, decides the default and never overrides a choice made at creation.

The contract is `ExecutionMode = "bound-root" | "provisioned-worktree"`. `bound-root` runs at the root already bound to the session's workspace and makes nothing (no worktree id). `provisioned-worktree` runs in a new worktree the daemon's worktree lifecycle made (the worktree id is set). A session moves into another tree only through `session.setWorkingFolder`. `ExecutionMode` holds whether the bound root is the repository's main working tree or a linked worktree, and for a chat's managed workspace.

## Alternatives Considered

### Option A: Two Places, A Worktree Of Its Own By Default (Chosen)

- **What:** A project session works in a worktree of its own or in the project's checkout, starting in a new worktree unless the person chose otherwise; how much it may change is its permission level.
- **Steel man:** One place per session keeps isolation, provenance and a clean pull-request path, while the permission level stays the single read-only concept, so no fact is carried twice.
- **Weaknesses:** Adds worktree management: creating, setting up, listing and removing trees, and keeping a removed tree until the person deletes it.

### Option B: Branch-Or-Main-Checkout Mutation By Default (Rejected)

- **What:** Start every new project session in the project's checkout and make a worktree only when the person asks for one.
- **Steel man:** Simpler mental model and lower setup cost.
- **Why rejected:** Two sessions editing one checkout mix their changes in one folder, which weakens attribution and makes a clean review harder; the checkout stays one press away for the person who wants it.

### Option C: A Read-Only Place Beside The Two (Rejected)

- **What:** Keep a third place, a read-only binding, for inspection and review work.
- **Steel man:** Makes "this session cannot change files" visible in where it works.
- **Why rejected:** The permission level already says how much a session may change, so a read-only place would carry the same fact a second time and the two could disagree.

## Reversibility Assessment

- **Reversal cost:** Moderate. The default setting, the worktree switcher and the plans would need adjustment.
- **Blast radius:** Worktree setup, the worktree switcher, Review's diff, pull requests, and docs.
- **Migration path:** Change the default setting's value; existing worktrees remain usable.
- **Point of no return:** After plans, operations, and screens deeply assume a worktree-first default.

## Consequences

### Positive

- Better isolation for a session's edits
- The places and one permission level, each fact said once
- Cleaner provenance and review behavior

### Negative (accepted trade-offs)

- More worktree lifecycle management, including keeping a discarded tree until the person deletes it
- A repository where a worktree cannot be made is worked in its own checkout, which the person picks; the daemon never falls back to it silently

### Unknowns

- How often people will change the machine's default to the project's checkout

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `domain/repo-workspace-worktree-model.md` | Canonical domain doc | A project session works in a worktree of its own or the project's checkout, and a new one starts in a new worktree | [domain/repo-workspace-worktree-model.md](../domain/repo-workspace-worktree-model.md) |
| `specs/008-worktree-lifecycle-and-execution-modes.md` | Canonical spec | The places and the worktree lifecycle | [specs/008-worktree-lifecycle-and-execution-modes.md](../specs/008-worktree-lifecycle-and-execution-modes.md) |
| `specs/009-gitflow-pr-and-diff-attribution.md` | Canonical spec | Worktree-backed execution supports attributable diff review and PR preparation | [specs/009-gitflow-pr-and-diff-attribution.md](../specs/009-gitflow-pr-and-diff-attribution.md) |

### Related Domain Docs

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

### Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)

### Related Specs

- [Repo Attachment And Workspace Binding](../specs/007-repo-attachment-and-workspace-binding.md)
- [Worktree Lifecycle And Execution Modes](../specs/008-worktree-lifecycle-and-execution-modes.md)
- [Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md)

### Related ADRs

- [SQLite Local State And Postgres Control Plane](./004-sqlite-local-state-and-postgres-control-plane.md)
