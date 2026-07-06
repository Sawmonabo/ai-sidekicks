# Spec-010: Worktree Lifecycle And Execution Modes

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `010` |
| **Slug** | `worktree-lifecycle-and-execution-modes` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md) |
| **Implementation Plan** | [Plan-010: Worktree Lifecycle And Execution Modes](../plans/010-worktree-lifecycle-and-execution-modes.md) |

> **Amendment (2026-07-06, capability-enhancement campaign B21 — amends the previously-`approved` spec; the header is flipped to `review` for the amendment's review window per the audit runbook's spec-amendment rule, and the campaign plan's Task 28 batch re-promotion restores `approved` after the W1.5 spec gate; dependent plans' code dispatch stays census-gated on that restoration).** This bundle lands one coordinated addition: §Turn-Boundary Snapshots — per-turn worktree snapshot refs (tracked + non-ignored untracked, temp-index capture recipe, `refs/sidekicks/runs/<runId>/turn-<N>` namespace, two-step restore with an index-only close, retention pruning, writable-modes-only applicability) — the mechanism the run time-travel file-restore leg requires ([ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log); consumed by the Spec-004 `rollback` intervention and Plan-010's snapshot tasks via the campaign's B2/B22 bundles). [Spec-011](011-gitflow-pr-and-diff-attribution.md) is explicitly unaffected — the no-impact statement is part of the section.

## Purpose

Define the lifecycle of worktrees and the execution modes available for repo-bound runs.

## Scope

This spec covers `read-only`, `branch`, `worktree`, and `ephemeral clone` execution modes plus worktree creation, reuse, and retirement.

## Non-Goals

- PR preparation details
- Merge policy
- Diff artifact rendering

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Deployment Topology](../architecture/deployment-topology.md)
- [ADR-006: Worktree First Execution Mode](../decisions/006-worktree-first-execution-mode.md)

## Required Behavior

- Every repo-bound run must bind to exactly one canonical execution mode: `read-only`, `branch`, `worktree`, or `ephemeral clone`.
- Repo-bound coding runs must default to `worktree` execution mode when the repository supports worktrees.
- `read-only` mode must prohibit repo mutation and support inspection, review, and diagnostic tasks.
- `branch` mode must be an explicit writable override that uses an existing checkout with explicit branch context.
- Starting a writable worktree-mode run must create or reuse a valid worktree before execution begins.
- `ephemeral clone` mode must provision a disposable isolated clone before writable execution begins.
- The system must not silently fall back from intended worktree mode to mutating the main checkout.
- The system must not silently substitute one canonical execution mode for another when the requested mode is unavailable.
- Worktree lifecycle must support `creating`, `ready`, `dirty`, `merged`, `retired`, and `failed`.
- Reusing an existing worktree must be explicit and must preserve branch and provenance context.

## Default Behavior

- Default branch naming pattern is `sidekicks/<session-short-id>/<task-slug>`.
- Default writable coding runs use one dedicated worktree per active task or branch context.
- `branch` mode and `ephemeral clone` mode are explicit selections or policy-driven overrides, not hidden defaults.
- Worktree retirement defaults to preserving metadata and artifacts even when filesystem cleanup later removes the checkout.
- Worktree or ephemeral-clone preparation must not automatically execute repository setup scripts in v1. This includes repository-controlled git hooks: provisioning git invocations must neutralize hook execution at the invocation layer (e.g. an empty `core.hooksPath`), so cloning or adding a worktree on a hostile repository executes no repository-controlled code.

## Fallback Behavior

- If a repo does not support worktrees, the system may offer `ephemeral clone` or explicit `branch` mode where safe, but it must mark the selected mode distinctly from normal worktree mode.
- If worktree creation fails, the run must remain blocked in setup rather than mutating the main checkout.
- If ephemeral clone preparation fails, the run must remain blocked in setup unless an operator or participant explicitly selects a different execution mode.
- "Blocked in setup" is a concrete run disposition: the run parks in the `starting` state with the typed preparation error surfaced; no `running` transition fires, the failure never silently mutates any checkout, and the parked run remains interruptible (cancel applies to `starting` runs, transitioning them to `interrupted`).
- If an intended reuse candidate is dirty or incompatible with the requested branch strategy, the system must require explicit user choice.
- Explicit reuse choice is candidate-anchored: the caller names the reuse candidate, and consent to bind a dirty candidate is a separate explicit acknowledgement — a candidate that becomes dirty between check and bind is refused rather than silently bound; a candidate incompatible with the requested branch strategy is never bindable.
- Preparing an execution root against a `stale` workspace must be refused with the typed stale error until the workspace is repaired (write-gate posture per Spec-009).
- When a repo mount detaches or an owning workspace archives, dependent non-terminal worktrees and ephemeral clones are retired by the daemon's asynchronous cleanup sweep — retirement is recorded and evented with metadata preserved; disk removal follows asynchronously. Retiring the clone backing a live `ephemeral clone`-mode workspace's current root returns that workspace to `provisioning` (awaiting the next per-run prepare); `stale` is reserved for fault paths (Spec-009 §Ephemeral Clone Lifecycle).
- If a repository requires setup commands before useful execution, v1 must surface them as explicit follow-on actions or workflow steps rather than hidden execution-root side effects.

## Interfaces And Contracts

- `ExecutionModeSelect` must distinguish `read-only`, `branch`, `worktree`, and `ephemeral clone`. Selection records the canonical mode and transitions the workspace; it does not materialize per-task execution roots — materialization is `ExecutionRootPrepare`'s surface (read-only resolves synchronously at select; an explicit mode switch is exactly one selection mutation, never a client-sequenced select-then-prepare chain).
- `ExecutionRootPrepare` must create or bind the execution root required by the selected mode before a run enters `running`. Explicit worktree reuse rides this interface by naming the candidate worktree.
- `WorktreeReuseCheck` must report branch, cleanliness, and compatibility.
- `EphemeralClonePrepare` must report clone root, lifecycle, and cleanup policy.
- `EphemeralCloneDispose` must support explicit disposal of a prepared clone (the `manual` cleanup-policy arm and operator-driven cleanup).
- `WorktreeRetire` must record retirement even if filesystem deletion happens asynchronously.
- `WorktreeStatusRead` must expose the session's worktree and ephemeral-clone records — lifecycle state, branch, cleanup bookkeeping, and provenance — as a daemon-owned read surface.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Worktree records must persist branch name, owning repo mount, lifecycle state, and provenance to the creating session and run.
- Execution mode must be stored as run setup data: the daemon persists a per-run execution binding (run → workspace, mode, execution root, and any worktree / ephemeral clone / branch context involved) that survives the run for provenance.
- Branch context must be persisted for writable `branch`, `worktree`, and `ephemeral clone` runs. The branch-context record is a polymorphic carrier: worktree-mode rows reference the worktree, ephemeral-clone rows reference the clone, and branch-mode rows reference neither (the main checkout carries no Plan-010 root row).
- Dirty and merged state belong to daemon-owned workspace projections.
- A workspace whose execution root is handed to an active run is `busy` for the run's duration (one holding run at a time in V1); concurrent root handoff is refused with a typed busy error, and the workspace returns to `ready` when the holding run reaches a terminal state.
- Daemon-provisioned execution roots (worktrees and ephemeral clones) live under the daemon's own execution-roots directory, never inside the attached repository checkout; they are inside the session's trust envelope by construction (Spec-009 §Local Trust Envelope).

## Turn-Boundary Snapshots

At each turn boundary of a writable-mode run — turn completion is first-class via the `completionKind` carve on `run.completed` ([Spec-006 §Run Lifecycle](006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle), campaign B1) — the daemon records the worktree's project state as a snapshot ref (campaign B21). This is the mechanism the run time-travel file-restore leg consumes (the Spec-004 `rollback` intervention; [ADR-017](../decisions/017-shared-event-sourcing-scope.md)'s forward `run.rolled_back` ruling).

- **Scope:** tracked **and** untracked files; `.gitignore`d paths are deliberately excluded on both the capture and restore legs. `git add -A` does not stage ignored paths at capture, and the restore's `git clean -ffd` (no `-x`) preserves them on disk — so rollback never deletes derived state the project itself declares disposable (build artifacts, caches, `node_modules`), and per-turn snapshots never churn the object store with artifact trees. The files/conversation coherence guarantee therefore covers project-declared state (tracked + non-ignored untracked) only.
- **Capture (temp-index recipe):** with `GIT_INDEX_FILE` pointing at a scratch index located **outside** the worktree — `git read-tree HEAD` → `git add -A` → `git write-tree` → `git commit-tree -p HEAD -m <fixed snapshot message>` with daemon-owned `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` + `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` env → `git update-ref`. The `commit-tree` leg is noninteractive and host-independent by construction: without `-m` the plumbing reads its message from stdin (a hang wherever the daemon leaves stdin open), and without explicit ident env it hard-fails (`Author identity unknown`) in passwd-less daemon/CI containers or silently stamps a passwd-derived OS ident elsewhere — machine-dependent snapshot OIDs and an identity leak into the object store (both empirically confirmed during the campaign's adversarial architecture pass). `git stash create` was experimentally refuted for this job: it captures tracked paths only, has no untracked option, and silently swallows `-u` as a commit message — a stash-style snapshot would restore turns minus every file they created. The out-of-worktree temp index also keeps snapshots from self-capturing index files — a worktree-resident scratch index would surface to `git add`/`git clean`/`git status` as stray untracked content (the restore legs always operate on the real index, which lives under `.git/` outside the worktree).
- **Ref namespace:** snapshot commits land under `refs/sidekicks/runs/<runId>/turn-<N>` — **never on `refs/heads/`** — so snapshots are invisible to branch history, PR preparation, and diff attribution by construction. [Spec-011](011-gitflow-pr-and-diff-attribution.md) is explicitly unaffected: its commits remain agent/user-authored and reviewable; no Spec-011 surface changes.
- **Restore:** `git read-tree --reset -u <snapshot-ref>` **followed by** `git clean -ffd` scoped to the worktree — a bare checkout-from-ref leaves post-snapshot files on disk (empirically confirmed), recreating exactly the files/conversation incoherence rollback exists to prevent — **closed by `git read-tree --reset HEAD` (index-only, no `-u`)**: the `-u` leg leaves the real index at the snapshot tree, so every captured-untracked file would otherwise surface as a staged addition against `HEAD`; resetting the index back to `HEAD` returns those files to untracked status and tracked edits to ordinary unstaged modifications, worktree bytes untouched (empirically confirmed — no fabricated staged intent survives a restore).
- **Retention:** snapshot refs prune when the run's retention window closes (terminal state + the configured window); the prune task lives with the run-retention owner. In `ephemeral clone` mode the refs live in the clone's own object store, so they additionally share the clone's disposal lifecycle (the configurable TTL below) — disposal is not a retention violation; there is no clone left to restore into.
- **Applicability:** `worktree`, `branch`, and `ephemeral clone` writable modes; `read-only` runs snapshot nothing. In `branch` mode the execution root is the shared main checkout, so a restore operates on that shared checkout — its post-snapshot untracked (non-ignored) files are discarded like any other rollback effect; branch mode's deliberately coarser isolation applies to restore exactly as it does to execution.

## Example Flows

- `Example: A user starts an implementation run. The daemon creates a dedicated worktree, binds the run to it, and only then starts provider execution.`
- `Example: A reviewer opens the repo in read-only mode, inspects diffs, and cannot accidentally mutate the checkout.`
- `Example: A repository cannot use worktrees safely, so a participant explicitly selects ephemeral clone mode and the daemon prepares a disposable clone for the writable run.`
- `Example: A later follow-up run explicitly reuses the same worktree because it targets the same branch and task lineage.`

## Implementation Notes

- Branch-name defaults should be deterministic and human-readable, but collision handling must be explicit.
- Worktree reuse is valuable, but the system should bias toward isolation over convenience.
- `branch` mode remains important for special maintenance tasks, but it must stay clearly non-default for mutable coding work.
- Repository bootstrap or setup commands should be modeled as explicit approved work, not as an implicit part of worktree creation.

## Pitfalls To Avoid

- Mutating the main checkout as a hidden fallback
- Treating worktree reuse as implicit magic
- Losing run provenance when a worktree is later retired

## Acceptance Criteria

- [ ] A writable coding run on a git repo defaults to worktree mode.
- [ ] The execution-mode contract distinguishes `read-only`, `branch`, `worktree`, and `ephemeral clone`.
- [ ] Worktree creation failure blocks the run instead of mutating the main checkout.
- [ ] Reused worktrees remain explicitly linked to branch and prior run context.

## ADR Triggers

- If worktree-first stops being the default execution strategy, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: branch prefix and slugging rules are product-defined and locked for consistency in v1: `sidekicks/<session-short-id>/<task-slug>`, where `<session-short-id>` is the first 8 hex characters of the session UUID and `<task-slug>` is derived from the originating queue-item summary — lowercased, non-alphanumeric runs collapsed to `-`, trimmed of leading/trailing `-`, truncated to 40 characters at a `-` boundary — falling back to `run-<run-short-id>` (first 8 hex of the run id) when no summary exists. User-configurable naming rules are deferred.
- V1 decision: branch-name collision handling is provenance-split. A caller-supplied branch name that collides with a live checkout is refused with the typed collision error — user intent is never silently adapted. A daemon-derived default name that collides takes the first free ordinal suffix (`-2`, `-3`, …) as part of the deterministic derivation rule; the chosen name is persisted and reported verbatim. Collision never implies implicit reuse: a fresh worktree on a suffixed name is created; explicit reuse remains the only reuse path.
- V1 decision: worktree base refs default to the repo mount's current HEAD branch; an explicit base ref may be supplied at preparation. Preparation against a detached-HEAD mount with no explicit base ref is refused rather than guessed.
- V1 decision: `branch` mode binds to the checkout's existing branch state and verifies it matches the requested branch context; the daemon never checks out, creates, or switches branches inside the main checkout (a mismatch is a typed refusal).
- V1 decision: ephemeral-clone TTL is daemon configuration (default 24 hours per Spec-009 §Ephemeral Clone Lifecycle), not a wire parameter.
- V1 decision: worktree and ephemeral-clone state transitions are not separately evented in V1 beyond the worktree lifecycle events already registered in the Spec-006 taxonomy; the `failed` transition and all ephemeral-clone transitions surface through the owning workspace's lifecycle events (`workspace.stale` carries the failure detail) and the `WorktreeStatusRead` surface. The Spec-006 event-type registry stays closed.
- V1 decision: repository setup scripts do not run automatically during worktree or ephemeral-clone preparation in the first implementation. Setup execution requires an explicit follow-on action under normal approval and policy rules.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
