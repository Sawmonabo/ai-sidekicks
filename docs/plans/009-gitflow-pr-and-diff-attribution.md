# Plan-009: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-009: Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-008](./008-worktree-lifecycle-and-execution-modes.md) (worktree infrastructure), [Plan-012](./012-artifacts-files-and-attachments.md) (artifact manifests) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |
| **References** | [Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter) (Agent Trace attribution, GitHostingAdapter) |

## Goal

Implement branch-context tracking, reviewable PR preparation, and diff attribution quality modes.

## Scope

This plan covers branch context persistence for writable execution modes, diff artifact generation, PR preparation records, and desktop review surfaces.

## Non-Goals

- Final merge automation
- Full GitHub or git-host integration breadth
- Workflow-specific review logic

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/gitflow.ts`
- `packages/runtime-daemon/src/gitflow/branch-context-service.ts`
- `packages/runtime-daemon/src/artifacts/diff-artifact-service.ts`
- `packages/runtime-daemon/src/gitflow/pr-preparation-service.ts`
- `packages/client-sdk/src/gitflowClient.ts`
- `apps/desktop/src/renderer/src/diff-review/`

## Data And Storage Changes

- Add local `diff_artifacts` and `pr_preparations` tables (CREATE).
- Extend `branch_contexts` (owner: Plan-008 — Plan-009 ALTER/USE).
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add branch-context read, diff artifact read, and PR prepare APIs to the client SDK.
- Emit one settlement event, `git.settled`, for each act that sends a session's work off this machine's working folder: a commit, a push, or an opened pull request. Its cause set is closed at three — `committed`, `pushed`, `pull_request_opened` — and each cause carries exactly the reference the session's flow row names: the commit's identifier, the branch, or the request's number with its address on the hosting service ([Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts)). The type and its payload are registered in the session event taxonomy ([Spec-005 §Event Type Enumeration](../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration)).

## Invariants

- **I-009-1** — A diff artifact emitted under the workspace-fallback path is labeled as such and is never presented as run-attributed ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).
- **I-009-2** — PR preparation derives base and head exclusively from the recorded branch context, never from transient client/tab state ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).
- **I-009-3** — No remote git mutation occurs without a prior durable, reviewable preparation record ([Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior), [Spec-009 §State And Data Implications](../specs/009-gitflow-pr-and-diff-attribution.md#state-and-data-implications), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid)).

## Cross-Plan Obligations

- **CP-009-1 (consumes)** — Imports `BranchContextId` and reads/extends the `branch_contexts` row owned by Plan-008 (Plan-008 CP-008-6). Plan-009 extends via ALTER + service access, never by editing Plan-008's git/ module.
- **CP-009-2 (consumes)** — Uses `artifact_manifests` + the OCI envelope and the `artifacts/` module owned by Plan-012 ([Plan-012 §Target Areas](./012-artifacts-files-and-attachments.md#target-areas); [Spec-012 §State And Data Implications](../specs/012-artifacts-files-and-attachments.md#state-and-data-implications)). DiffArtifact rides as artifactType `"diff"` under that envelope.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- The `#### Tasks` rows live under §Implementation Phase Sequence below, grouped per phase.

## Implementation Phase Sequence

Plan-009 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable. The ordering is the one §Rollout Order and §Parallelization Notes set out.

### Phase 1 — Branch-Context Persistence

**Precondition:** none. §Rollout Order step 1's branch-context half — the schema §Parallelization Notes gates both parallel service legs on.

#### Tasks

- **T11.1** — Implement branch-context persistence tied to writable execution modes and runs.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (every writable run executes against an explicit branch context; base, head and worktree association tracked per writable context), [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts) (`BranchContextRead` exposes base/head/upstream/worktree), [Spec-009 §Acceptance Criteria](../specs/009-gitflow-pr-and-diff-attribution.md#acceptance-criteria) (explicit branch context on every writable run).
  - **Verifies invariant:** none (no I-009 invariant governs persistence directly).
  - **Consumes:**
    - `BranchContextId` ← Plan-008 provider (Plan-008 CP-008-6) — minted by `repo.executionRootPrepare`; SHAPE verified present.
    - `branch_contexts` row (ALTER/extend) ← Plan-008 provider ([`branch_contexts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009)) — at-most-one association CHECK + (worktree_id, workspace_id) partial-unique index present.
    - `WorktreeId`, `WorkspaceId`, `EphemeralCloneId` branded types ← Plan-008 provider (api-payload-contracts BranchContextReadResponse fields) — present.

### Phase 2 — Diff Artifact Generation

**Precondition:** Phase 1 merged (branch-context schema exists — §Parallelization Notes); **Plan-012 Phase 2 merged** — the `artifact_manifests` table + OCI envelope this plan's CP-009-2 consumes (DiffArtifact rides as `artifactType: "diff"`). §Rollout Order step 1's diff-artifact half, parallel to Phase 3 per §Parallelization Notes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 009, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 012, phase: 2 }
```

#### Tasks

- **T11.2** — Build diff artifact generation with explicit attribution mode. Use Agent Trace standard and git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for commit-level and line-level provenance. DiffArtifact is a specialized artifact (`artifactType: "diff"`) using the OCI manifest envelope defined in Spec-012.
  - **Attribution-mode value set (D-009-2):** the `diff_artifacts.attribution_mode` value set is `run_attributed` / `workspace_fallback` — the [Spec-009 §Default Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#default-behavior) / [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior) provenance-quality vocabulary. The enum/CHECK edge is executable: `attributionMode: "run_attributed" | "workspace_fallback"` (api-payload-contracts.md) and `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))` (local-sqlite-schema.md).
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (diff provenance to the producing run, `artifactType: "diff"` in the Spec-012 envelope, labeled workspace-level fallback, Agent Trace + git trailers), [Spec-009 §Default Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#default-behavior) (default attribution mode `run_attributed`), [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior) (fallback emits `workspace_fallback` with explicit labeling), [Spec-009 §Acceptance Criteria](../specs/009-gitflow-pr-and-diff-attribution.md#acceptance-criteria) (the two attribution modes are distinguished).
  - **Verifies invariant:** I-009-1 — workspace-fallback never labeled run-attributed.
  - **Consumes:**
    - `artifact_manifests` + OCI envelope, `artifactType: "diff"` ← Plan-012 provider ([`artifact_manifests`](../architecture/schemas/local-sqlite-schema.md#artifact-tables-plan-012); [Spec-012 §Interfaces And Contracts](../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts), return-cite [Spec-012 §State And Data Implications](../specs/012-artifacts-files-and-attachments.md#state-and-data-implications)) — SHAPE verified: `"diff"` admitted by the artifactType discriminator.
    - `diff_artifacts` table (CREATE, Plan-009-owned) — fully specified ([`diff_artifacts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009): FK to artifact_manifests, `run_id` (nullable — present for `run_attributed`, null for `workspace_fallback`) + `workspace_id` (nullable mirror, `REFERENCES workspaces(id)` — present for `workspace_fallback`, null for `run_attributed`; the durable workspace-level provenance [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) mandates, D-009-4), both guarded by the symmetric biconditional `CHECK((attribution_mode = 'run_attributed' AND run_id IS NOT NULL AND workspace_id IS NULL) OR (attribution_mode = 'workspace_fallback' AND run_id IS NULL AND workspace_id IS NOT NULL))` per [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) / [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior), attribution_mode, base_ref, head_ref).
    - `attributionMode` enum ← D-009-2: the Spec vocabulary `run_attributed` / `workspace_fallback` in both contract (api-payload-contracts.md `attributionMode: "run_attributed" | "workspace_fallback"`) and schema (local-sqlite-schema.md `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))`).

### Phase 3 — PR Preparation And Remote Mutation Handoff

**Precondition:** Phase 1 merged (PR preparation derives base and head exclusively from the recorded branch context — I-009-2). Parallel to Phase 2 per §Parallelization Notes ("can progress in parallel once branch-context schema exists"); §Rollout Order step 3 sequences remote-mutation enablement after step 2's read-only review surfaces.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 009, phase: 1, status: merged }
```

#### Tasks

- **T11.3** — Build reviewable PR preparation records and remote mutation handoff. Implement the `GitHostingAdapter` interface with `gh` CLI as the V1 backend; use normalized `createChangeRequest` terminology and auto-detect provider from the git remote URL. Each act that reaches the remote or the local history appends one `git.settled` event as it settles — cause `committed`, `pushed` or `pull_request_opened`, carrying that cause's own reference (the commit's identifier, the branch, or the request's number and its address on the service) and, where an agent performed the act as an ordinary tool call, the run that did it; a person pressing the control leaves that member absent.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (PR prep uses the recorded base/head rather than the client tab; commit, push and PR are reviewable before execution), [Spec-009 §Default Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#default-behavior) (default PR target is the recorded base), [Spec-009 §Interfaces And Contracts](../specs/009-gitflow-pr-and-diff-attribution.md#interfaces-and-contracts) (`PRPrepare` reviewable proposal before remote mutation; `GitActionExecute` preserves causation), [Spec-009 §Git Hosting Adapter](../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter) (GitHostingAdapter / `gh` / `createChangeRequest` / remote auto-detect), [Spec-009 §Acceptance Criteria](../specs/009-gitflow-pr-and-diff-attribution.md#acceptance-criteria) (a reviewable proposal tied to base and head).
  - **Verifies invariant:** I-009-2 + I-009-3 — base/head from recorded context, durable reviewable record before remote mutation.
  - **Consumes:**
    - `pr_preparations` table (CREATE, Plan-009-owned) — fully specified ([`pr_preparations`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009): branch_context_id FK, state CHECK, proposal_blob, target_branch).
    - `RepoMountId`, `RunId`, `UserId` branded types ← upstream providers (GitActionExecute fields) — present.
    - `GitHostingAdapter` param/result types (`ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, `CommentResult`) ← D-009-1: all nine host-agnostic shapes are defined in `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Gitflow PR And Diff Attribution` (GitHostingAdapter supporting-types block), each using generic ChangeRequest terminology with the `gh`-CLI field mapping noted inline — SHAPE present.
    - wire method names `gitflow.prPrepare` / `gitflow.gitActionExecute` ← D-009-5: the request/response shapes are defined in api-payload-contracts.md (`PRPrepareRequest`/`PRPrepareResponse`, `GitActionExecuteRequest`/`GitActionExecuteResponse`), and the four `gitflow.*` wire method-name strings are registered in the canonical method table there (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`) — `dotted-camelCase` per the `METHOD_NAME_FORMAT` registry, which **rejects** the PascalCase type symbols (`PRPrepare`, `GitActionExecute`) as method strings.

### Phase 4 — Desktop Review Surfaces

**Precondition:** Phases 2 and 3 merged — §Parallelization Notes holds the review UI on the attribution-mode and artifact-payload contracts (T11.2), and the PR-preparation surface renders T11.3's records. Delivers §Rollout Order step 2's read-only review surfaces and step 3's PR-preparation review surface.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: plan_phase, plan: 009, phase: 2, status: merged }
  - { type: plan_phase, plan: 009, phase: 3, status: merged }
```

#### Tasks

- **T11.4** — Add desktop diff and PR preparation review surfaces.
  - **Spec coverage:** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior) (reviewable before execution; explicit fallback labeling, never implied run attribution), [Spec-009 §Pitfalls To Avoid](../specs/009-gitflow-pr-and-diff-attribution.md#pitfalls-to-avoid) (attribution quality is a first-class field, not an inferred UI decoration), [Spec-009 §Acceptance Criteria](../specs/009-gitflow-pr-and-diff-attribution.md#acceptance-criteria) (modes distinguished; reviewable proposal).
  - **Verifies invariant:** I-009-1 — UI surfaces the fallback label honestly.
  - **Consumes:**
    - renderer path `apps/desktop/src/renderer/src/diff-review/` ← Plan-009-owned ([§Target Areas](#target-areas)) — present/pinned.
    - `gitflowClient` SDK ← Plan-009-owned (`packages/client-sdk/src/gitflowClient.ts`, §Target Areas) — to be authored by this plan; depends on the four `gitflow.*` wire methods (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`), per D-009-5 — the four method names are registered in the canonical method table in api-payload-contracts.md (`dotted-camelCase` per `METHOD_NAME_FORMAT`).
    - attribution-mode + artifact-payload contracts ← consumes the same enum/shapes as Step 2 — per D-009-2, whose `run_attributed`/`workspace_fallback` mode labels are what the surface renders.

## Parallelization Notes

- Diff artifact generation and PR preparation services can progress in parallel once branch-context schema exists.
- Desktop review UI should wait for attribution mode and artifact payload contracts.

## Test And Verification Plan

- Attribution-mode tests for run-attributed versus workspace-fallback diffs
- PR preparation contract tests
- Manual verification from writable run to diff review to PR prepare

## Rollout Order

1. Ship branch context and diff artifact generation
2. Enable read-only review surfaces
3. Enable PR preparation and remote mutation handoff

## Rollback Or Fallback

- Disable remote PR preparation and keep local diff artifact generation if hosting integration regresses.

## Risks And Blockers

- Attribution quality may degrade unexpectedly after recovery or manual git changes
- Host integration variability may delay end-to-end PR flows

## Design Decisions

- **D-009-1 — The nine `GitHostingAdapter` param/result shapes are host-agnostic contract types, defined in `api-payload-contracts.md`.** [Spec-009 §GitHostingAdapter Interface](../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface) names `ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, and `CommentResult`. All nine use generic ChangeRequest terminology — callers never reference GitHub-specific concepts ([Spec-009 §Multi-Host Path (V2)](../specs/009-gitflow-pr-and-diff-attribution.md#multi-host-path-v2)) — and each field is mapped to the V1 `gh` CLI contract inline. `createChangeRequest` runs `gh pr create` and then `gh pr view <created-url> --json number,url`: `gh pr create` has no `--json` flag and prints only the new PR's URL, and a bare `gh pr view` would resolve the current branch's request rather than the one just created on an arbitrary `headBranch`.
- **D-009-2 — `diff_artifacts.attribution_mode` is `run_attributed` / `workspace_fallback`.** The [Spec-009 §Default Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#default-behavior) / [Spec-009 §Fallback Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#fallback-behavior) provenance-quality vocabulary holds in both the wire contract (`attributionMode: "run_attributed" | "workspace_fallback"`) and the schema CHECK. The value set names the provenance-quality axis — does this diff correlate to a run? — rather than the attribution mechanism, which is the axis the acceptance criterion is stated on.
- **D-009-3 — Plan-009's daemon services live in `runtime-daemon/src/gitflow/`, not `runtime-daemon/src/git/`.** `src/git/` is Plan-008-owned (worktree services; cross-plan-dependencies.md, Plan-008 CP-008-7) and Plan-009 consumes it through contracts and services, never by editing it. `branch-context-service.ts` and `pr-preparation-service.ts` are Plan-009's own, and they sit beside the `gitflow.ts` contract and the `gitflowClient.ts` SDK in §Target Areas; cross-plan-dependencies.md carries the ownership row.
- **D-009-4 — `diff_artifacts` persists `workspace_id` for the `workspace_fallback` arm.** [Spec-009 §Required Behavior](../specs/009-gitflow-pr-and-diff-attribution.md#required-behavior)'s "clearly labeled workspace-level diff artifact" has to be durable: a `workspace_fallback` row must record _which_ workspace produced it, and the `artifact_manifest_id` FK reaches only the session while `run_id` is null by construction on that arm. The column is a nullable `workspace_id TEXT REFERENCES workspaces(id)` — an FK because `workspaces` is table-backed, unlike the event-sourced `run_id`/`session_id` columns that carry no FK (the convention `run_execution_contexts` sets in local-sqlite-schema.md) — guarded by the symmetric biconditional `CHECK((run_attributed AND run_id IS NOT NULL AND workspace_id IS NULL) OR (workspace_fallback AND run_id IS NULL AND workspace_id IS NOT NULL))` mirroring the wire union, plus a partial index `idx_diff_artifacts_workspace`. `run_attributed` persists no `workspace_id`; its workspace is reachable through the run's `run_execution_contexts.workspace_id`. Spec-009's §Data Model extension-column enumeration ([Spec-009 §DiffArtifact and General Artifact Relationship](../specs/009-gitflow-pr-and-diff-attribution.md#diffartifact-and-general-artifact-relationship)) lists only `attribution_mode`/`base_ref`/`head_ref`, omitting resolver columns like `run_id`, so `workspace_id` needs no Spec entry either.
- **D-009-5 — The four Plan-009 wire operations take `gitflow.*` `dotted-camelCase` JSON-RPC method names, registered in the canonical `api-payload-contracts.md` method table.** The `METHOD_NAME_FORMAT` registry (api-payload-contracts.md §Plan-006-Partial — Local IPC Daemon Control) is `dotted-camelCase` and **rejects** PascalCase strings, and every sibling wire surface (`run.*`, `repo.*`, `approval.*`, `user.*`) enumerates its methods in a canonical table there. The four are `gitflow.branchContextRead` (`query`) and `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute` (`mutation`), mapped to the `BranchContextRead` / `DiffArtifactCreate` / `PRPrepare` / `GitActionExecute` request/response types. The `GitHostingAdapter` and its nine supporting types stay daemon-internal and are not wire methods (D-009-1).

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
