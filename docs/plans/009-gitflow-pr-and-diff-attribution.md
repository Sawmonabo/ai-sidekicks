# Plan-009: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `009` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` (Tier-6 readiness audit 2026-06-15) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-009: Gitflow PR And Diff Attribution](../specs/009-gitflow-pr-and-diff-attribution.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-008](./008-worktree-lifecycle-and-execution-modes.md) (worktree infrastructure), [Plan-012](./012-artifacts-files-and-attachments.md) (artifact manifests) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |
| **References** | [Updated Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md) (Agent Trace attribution, GitHostingAdapter) |

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
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-6 audit (2026-06-15): 7 findings adjudicated via A-009-1..4; D-009-1..3 ratified (the nine `GitHostingAdapter` supporting types, the `attribution_mode` value set, and the `src/git/` → `src/gitflow/` daemon-path correction). §Invariants I-009-1..3, §Cross-Plan Obligations CP-009-1/2, and the `#### Tasks` block record EXISTING relationships; D-009-3 relocates Plan-009's own services out of Plan-008-owned `src/git/` into `src/gitflow/` (a path correction, not a new file) — no new contract surface, so Plan-009 stays `approved`. Companion amendments: api-payload-contracts.md (nine `GitHostingAdapter` types + `attributionMode` enum), local-sqlite-schema.md (`diff_artifacts.attribution_mode` CHECK), cross-plan-dependencies.md (`src/gitflow/` ownership row).

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

## Invariants

- **I-009-1** — A diff artifact emitted under the workspace-fallback path is labeled as such and is never presented as run-attributed (`Spec-009 §Required Behavior`, `Spec-009 §Fallback Behavior`, `Spec-009 §Pitfalls To Avoid`).
- **I-009-2** — PR preparation derives base and head exclusively from the recorded branch context, never from transient client/tab state (`Spec-009 §Required Behavior`, `Spec-009 §Pitfalls To Avoid`).
- **I-009-3** — No remote git mutation occurs without a prior durable, reviewable preparation record (`Spec-009 §Required Behavior`, `Spec-009 §State And Data Implications`, `Spec-009 §Pitfalls To Avoid`).

## Cross-Plan Obligations

- **CP-009-1 (consumes)** — Imports `BranchContextId` and reads/extends the `branch_contexts` row owned by Plan-008 (Plan-008 CP-008-6). Plan-009 extends via ALTER + service access, never by editing Plan-008's git/ module.
- **CP-009-2 (consumes)** — Uses `artifact_manifests` + the OCI envelope and the `artifacts/` module owned by Plan-012 ([Plan-012 §Target Areas](./012-artifacts-files-and-attachments.md#target-areas); `Spec-012 §State And Data Implications`). DiffArtifact rides as artifactType `"diff"` under that envelope.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- The audit-ratified `#### Tasks` rows live under §Implementation Phase Sequence below, grouped per phase (row id `T11.N` is the audit block's task N — ids minted 2026-08-15 by the Tier-6 phases backfill; row content unchanged).

## Implementation Phase Sequence

Plan-009 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable. Each phase carries its audit-ratified Tasks rows verbatim; the ordering is the one §Rollout Order and §Parallelization Notes already ratify.

### Phase 1 — Branch-Context Persistence

**Precondition:** Tier-6 plan-readiness audit complete (PR #160). Audit task 1; §Rollout Order step 1's branch-context half — the schema §Parallelization Notes gates both parallel service legs on.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 160, baseline_tag: "plan-readiness-audit-tier-7-complete" }
```

#### Tasks

- **T11.1** — Implement branch-context persistence tied to writable execution modes and runs.
  - **Spec coverage:** Spec-009 line 40 (every writable run executes against an explicit branch context), line 41 (track base/head/worktree association), line 64 (`BranchContextRead` exposes base/head/upstream/worktree), AC line 173.
  - **Verifies invariant:** none (no I-009 invariant governs persistence directly — A-009-2 adjudicates Task 1 as persistence backfill, not gated by an I-009 invariant).
  - **Consumes:**
    - `BranchContextId` ← Plan-008 provider (Plan-008 CP-008-6) — minted by `repo.executionRootPrepare`; SHAPE verified present.
    - `branch_contexts` row (ALTER/extend) ← Plan-008 provider ([`branch_contexts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009)) — at-most-one association CHECK + (worktree_id, workspace_id) partial-unique index present.
    - `WorktreeId`, `WorkspaceId`, `EphemeralCloneId` branded types ← Plan-008 provider (api-payload-contracts BranchContextReadResponse fields) — present.

### Phase 2 — Diff Artifact Generation

**Precondition:** Phase 1 merged (branch-context schema exists — §Parallelization Notes); **Plan-012 Phase 2 merged** — the `artifact_manifests` table + OCI envelope this plan's CP-009-2 consumes (DiffArtifact rides as `artifactType: "diff"`). Audit task 2; §Rollout Order step 1's diff-artifact half, parallel to Phase 3 per §Parallelization Notes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 160, baseline_tag: "plan-readiness-audit-tier-7-complete" }
  - { type: plan_phase, plan: 009, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 012, phase: 2 }
```

#### Tasks

- **T11.2** — Build diff artifact generation with explicit attribution mode. Use Agent Trace standard and git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for commit-level and line-level provenance. DiffArtifact is a specialized artifact (`artifactType: "diff"`) using the OCI manifest envelope defined in Spec-012.
  - **Attribution-mode value set (D-009-2 — resolved):** the `diff_artifacts.attribution_mode` value set is canonicalized to `run_attributed` / `workspace_fallback` (the `Spec-009 §Default Behavior` / `Spec-009 §Fallback Behavior` provenance-quality vocabulary), superseding the prior wire+schema `agent_trace`/`git_diff` pair that conflated provenance quality with the attribution mechanism. The enum/CHECK edge is now executable: `attributionMode: "run_attributed" | "workspace_fallback"` (api-payload-contracts.md) and `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))` (local-sqlite-schema.md). This reconciled an existing contract, not a new contract surface — the plan stays `approved`.
  - **Spec coverage:** Spec-009 line 42 (diff provenance to producing run), line 43 (`artifactType: "diff"` in the Spec-012 envelope), line 44 (labeled workspace-level fallback), line 45 (Agent Trace + git trailers), line 52 (default attribution mode `run_attributed`), line 58 (fallback emits `workspace_fallback` with explicit labeling), AC line 174.
  - **Verifies invariant:** I-009-1 — workspace-fallback never labeled run-attributed.
  - **Consumes:**
    - `artifact_manifests` + OCI envelope, `artifactType: "diff"` ← Plan-012 provider ([`artifact_manifests`](../architecture/schemas/local-sqlite-schema.md#artifact-tables-plan-012); `Spec-012 §Interfaces And Contracts`, return-cite `Spec-012 §State And Data Implications`) — SHAPE verified: `"diff"` admitted by the artifactType discriminator.
    - `diff_artifacts` table (CREATE, Plan-009-owned) — fully specified ([`diff_artifacts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009): FK to artifact_manifests, `run_id` (nullable — present for `run_attributed`, null for `workspace_fallback`) + `workspace_id` (nullable mirror, `REFERENCES workspaces(id)` — present for `workspace_fallback`, null for `run_attributed`; the durable workspace-level provenance `Spec-009 §Required Behavior` mandates, D-009-4), both guarded by the symmetric biconditional `CHECK((attribution_mode = 'run_attributed' AND run_id IS NOT NULL AND workspace_id IS NULL) OR (attribution_mode = 'workspace_fallback' AND run_id IS NULL AND workspace_id IS NOT NULL))` per `Spec-009 §Required Behavior` / `Spec-009 §Fallback Behavior`, attribution_mode, base_ref, head_ref).
    - `attributionMode` enum ← **RESOLVED (D-009-2)**: canonicalized to the Spec vocabulary `run_attributed` / `workspace_fallback` in both contract (api-payload-contracts.md `attributionMode: "run_attributed" | "workspace_fallback"`) and schema (local-sqlite-schema.md `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))`), matching the AC-174 Spec vocabulary. The prior `agent_trace`/`git_diff` pair is dropped.

### Phase 3 — PR Preparation And Remote Mutation Handoff

**Precondition:** Phase 1 merged (PR preparation derives base and head exclusively from the recorded branch context — I-009-2). Audit task 3; parallel to Phase 2 per §Parallelization Notes ("can progress in parallel once branch-context schema exists"); §Rollout Order step 3 sequences remote-mutation enablement after step 2's read-only review surfaces.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 160, baseline_tag: "plan-readiness-audit-tier-7-complete" }
  - { type: plan_phase, plan: 009, phase: 1, status: merged }
```

#### Tasks

- **T11.3** — Build reviewable PR preparation records and remote mutation handoff. Implement the `GitHostingAdapter` interface with `gh` CLI as the V1 backend; use normalized `createChangeRequest` terminology and auto-detect provider from the git remote URL.
  - **Spec coverage:** Spec-009 line 46 (PR prep uses recorded base/head, not client tab), line 47 (commit/push/PR reviewable before execution), line 51 (default PR target = recorded base), line 66 (`PRPrepare` reviewable proposal before remote mutation), line 67 (`GitActionExecute` preserves causation), line 68 + §Git Hosting Adapter lines 118-152 (GitHostingAdapter / gh / createChangeRequest / auto-detect), AC line 175.
  - **Verifies invariant:** I-009-2 + I-009-3 — base/head from recorded context, durable reviewable record before remote mutation.
  - **Consumes:**
    - `pr_preparations` table (CREATE, Plan-009-owned) — fully specified ([`pr_preparations`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-007-plan-008-plan-009): branch_context_id FK, state CHECK, proposal_blob, target_branch).
    - `RepoMountId`, `RunId`, `UserId` branded types ← upstream providers (GitActionExecute fields) — present.
    - `GitHostingAdapter` param/result types (`ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, `CommentResult`) ← **RESOLVED (D-009-1)**: all nine host-agnostic shapes are now defined in `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Gitflow PR And Diff Attribution` (GitHostingAdapter supporting-types block), each using generic ChangeRequest terminology with the `gh`-CLI field mapping noted inline — SHAPE present.
    - wire method names `gitflow.prPrepare` / `gitflow.gitActionExecute` ← **RESOLVED (A-009-1 + D-009-5)**: the request/response shapes are defined in api-payload-contracts.md (`PRPrepareRequest`/`PRPrepareResponse`, `GitActionExecuteRequest`/`GitActionExecuteResponse`), and the four `gitflow.*` wire method-name strings are now registered in the canonical method table there (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`) — `dotted-camelCase` per the `METHOD_NAME_FORMAT` registry, which **rejects** the PascalCase type symbols (`PRPrepare`, `GitActionExecute`) as method strings (D-009-5 supersedes A-009-1's earlier 'standing PascalCase convention' adjudication).

### Phase 4 — Desktop Review Surfaces

**Precondition:** Phases 2 and 3 merged — §Parallelization Notes holds the review UI on the attribution-mode and artifact-payload contracts (T11.2), and the PR-preparation surface renders T11.3's records. Audit task 4; delivers §Rollout Order step 2's read-only review surfaces and step 3's PR-preparation review surface.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 160, baseline_tag: "plan-readiness-audit-tier-7-complete" }
  - { type: plan_phase, plan: 009, phase: 2, status: merged }
  - { type: plan_phase, plan: 009, phase: 3, status: merged }
```

#### Tasks

- **T11.4** — Add desktop diff and PR preparation review surfaces.
  - **Spec coverage:** Spec-009 line 47 (reviewable before execution), line 44 (explicit fallback labeling, never implied run attribution), line 161 (attribution quality is a first-class field, not an inferred UI decoration), AC line 174 (modes distinguished) + AC line 175 (reviewable proposal).
  - **Verifies invariant:** I-009-1 — UI surfaces the fallback label honestly.
  - **Consumes:**
    - renderer path `apps/desktop/src/renderer/src/diff-review/` ← Plan-009-owned ([§Target Areas](#target-areas)) — present/pinned.
    - `gitflowClient` SDK ← Plan-009-owned (`packages/client-sdk/src/gitflowClient.ts`, §Target Areas) — to be authored by this plan; depends on the four `gitflow.*` wire methods (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`), RESOLVED via A-009-1 + D-009-5 — the four method names are registered in the canonical method table in api-payload-contracts.md (`dotted-camelCase` per `METHOD_NAME_FORMAT`).
    - attribution-mode + artifact-payload contracts ← consumes the same enum/shapes as Step 2 — RESOLVED via D-009-2 (the `run_attributed`/`workspace_fallback` mode labels are fixed) for the mode-label rendering.

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

## Ratified Design Decisions (Tier-6 audit)

- **D-009-1 — The nine `GitHostingAdapter` param/result shapes are host-agnostic contract types, now defined in `api-payload-contracts.md`.** The `Spec-009 §GitHostingAdapter Interface` named `ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, and `CommentResult` but left them undefined. The audit authored all nine using generic ChangeRequest terminology (callers never reference GitHub-specific concepts, `Spec-009 §Multi-Host Path (V2)`), each field mapped to the V1 `gh` CLI contract inline (`Spec-009 §GitHostingAdapter Interface`). This defines previously-named-but-undefined types — it does not introduce a new contract surface.
- **D-009-2 — `diff_artifacts.attribution_mode` canonicalizes to `run_attributed` / `workspace_fallback`.** The `Spec-009 §Default Behavior` / `Spec-009 §Fallback Behavior` provenance-quality vocabulary is adopted in both the wire contract (`attributionMode: "run_attributed" | "workspace_fallback"`) and the schema CHECK, superseding the prior `agent_trace`/`git_diff` pair that conflated the provenance-quality axis (does this diff correlate to a run?) with the attribution mechanism. AC-174 is stated in this vocabulary, so the contract now matches the acceptance criterion. Reconcile of an existing contract, not a new surface.
- **D-009-3 — Plan-009's daemon services move from `runtime-daemon/src/git/` to `runtime-daemon/src/gitflow/`.** `src/git/` is Plan-008-owned (worktree services; cross-plan-dependencies.md, Plan-008 CP-008-7) and Plan-009 must consume it through contracts/services, never edit it directly. `branch-context-service.ts` and `pr-preparation-service.ts` were always Plan-009's; listing them under `src/git/` mis-cited Plan-009-owned files inside Plan-008's directory. Retargeting to `src/gitflow/` — consistent with the `gitflow.ts` contract and `gitflowClient.ts` SDK already in §Target Areas — is a path correction of an ownership-boundary violation, recorded by a new cross-plan-dependencies.md ownership row. Not a new contract surface.
- **D-009-4 — `diff_artifacts` persists `workspace_id` for the `workspace_fallback` arm.** The round-11 reshape (D-009-2) carried `workspaceId` on the wire's `workspace_fallback` arm but dropped it at rest, justified by an `api-payload-contracts.md` comment that the workspace was a "mint-time resolver" reached transiently. That left `Spec-009 §Required Behavior`'s "clearly labeled workspace-level diff artifact" undurable: a `workspace_fallback` row recorded its mode but not _which_ workspace produced it (the `artifact_manifest_id` FK reaches only the session, and `run_id` is null by construction for the fallback arm). The audit adds a nullable `workspace_id TEXT REFERENCES workspaces(id)` column — FK because `workspaces` is table-backed, unlike the event-sourced `run_id`/`session_id` columns that carry no FK (local-sqlite-schema.md `run_execution_contexts` establishes this convention) — guarded by a symmetric biconditional `CHECK((run_attributed AND run_id IS NOT NULL AND workspace_id IS NULL) OR (workspace_fallback AND run_id IS NULL AND workspace_id IS NOT NULL))` mirroring the wire union, plus a partial index `idx_diff_artifacts_workspace`. `run_attributed` persists no `workspace_id` (its workspace is reachable via the run's `run_execution_contexts.workspace_id`). This reverses a round-11 comment-level decision (no numbered decision was attached). Spec-009 is untouched: its §Data Model extension-column enumeration (`Spec-009 §DiffArtifact and General Artifact Relationship`) already lists only `attribution_mode`/`base_ref`/`head_ref`, omitting resolver columns like `run_id`, so `workspace_id` (also a resolver) needs no Spec edit. Schema-and-contract reconcile of an existing surface, not a new contract surface — Plan-009 stays `approved`.
- **D-009-5 — The four Plan-009 wire operations are assigned `gitflow.*` `dotted-camelCase` JSON-RPC method names, registered in a canonical `api-payload-contracts.md` method table.** A-009-1 had deferred method naming to a "standing PascalCase JSON-RPC convention" and concluded no method-name registry was needed — but no such convention exists: the ratified `METHOD_NAME_FORMAT` (api-payload-contracts.md §Tier 1 (cont.): Plan-006) is `dotted-camelCase` and **rejects** PascalCase strings, and every sibling wire surface (`run.*`, `repo.*`, `approval.*`, `user.*`) enumerates its methods in a canonical table there. The audit registers the four `gitflow.*` methods — `gitflow.branchContextRead` (`query`); `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute` (`mutation`) — mapped to the existing `BranchContextRead` / `DiffArtifactCreate` / `PRPrepare` / `GitActionExecute` request/response types; the `GitHostingAdapter` and its nine supporting types stay daemon-internal (not wire methods, D-009-1). Registers existing operations under the canonical naming contract rather than adding a new operation, so Plan-009 stays `approved`. (Codex round-19 finding KuB_5.)

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- 2026-06-15 — Tier-6 plan-readiness audit: 7 findings adjudicated via A-009-1..4; D-009-1..3 ratified. Decisions: D-009-1 authored the nine `GitHostingAdapter` supporting types (api-payload-contracts.md); D-009-2 canonicalized `attribution_mode` to `run_attributed`/`workspace_fallback` across contract + schema, dropping the `agent_trace`/`git_diff` pair; D-009-3 retargeted Plan-009's daemon services out of Plan-008-owned `src/git/` into `src/gitflow/` (plus a cross-plan-dependencies.md ownership row). Adjudications: A-009-1 — `PRPrepare`/`GitActionExecute` method names follow the standing JSON-RPC naming convention (request/response shapes already defined in api-payload-contracts.md), so no separate method-name registry is required [**superseded 2026-06-19 by D-009-5** — the standing convention is `dotted-camelCase`, not PascalCase; `METHOD_NAME_FORMAT` rejects PascalCase, so the four `gitflow.*` wire names are now registered in a canonical method table in api-payload-contracts.md; see the 2026-06-19 Notes entry]; A-009-2 — Task 1 persistence is backfill not governed by an I-009 invariant; A-009-3 — §Cross-Plan Obligations CP-009-1/2 record EXISTING consume relationships (Plan-008 `branch_contexts`, Plan-012 artifacts envelope); A-009-4 — `#### Tasks` gitflow.ts edge sequencing recorded. Every item records an existing relationship or corrects a mis-cited path — no new contract surface — so Plan-009 stays `approved`. No upstream-tier or sealed-plan amendments.
- 2026-06-17 — Codex review round 9 (PR finalization): one finding adjudicated valid against the `gh` CLI primary source and fixed at the requirement level. The D-009-1 `createChangeRequest` contract mapped `gh pr create` + a bare `gh pr view --json number,url`, but `gh pr create` exposes no `--json` flag — it prints only the new PR URL to stdout — and a bare `gh pr view` resolves the CURRENT branch's PR, not the one just created on an arbitrary `headBranch`. Corrected the `Spec-009 §Git Hosting Adapter` table row + §Interfaces prose (`Spec-009 §GitHostingAdapter Interface`) and the `ChangeRequestParams` / `ChangeRequestResult` contract comments (api-payload-contracts.md) to the `gh pr create` → `gh pr view <created-url> --json number,url` sequence, with the create-stdout URL passed explicitly to the read. Verified against `gh pr create --help` + `gh pr view --help`. Compliance fix to the already-ratified D-009-1 contract — no new D-number; the Spec-009 correction is content-only and Spec-009 stays `approved`. No upstream-tier or sealed-plan amendments.
- 2026-06-18 — Codex review round 18 (PR finalization): finding KscWH adjudicated valid and fixed by ratifying **D-009-4**. The round-11 reshape (D-009-2) carried `workspace_fallback.workspaceId` on the wire but dropped it at rest, so the workspace-level provenance `Spec-009 §Required Behavior` mandates was not durable. Added a nullable `workspace_id TEXT REFERENCES workspaces(id)` column to `diff_artifacts` (FK because `workspaces` is table-backed, unlike the event-sourced `run_id`/`session_id`), a symmetric biconditional CHECK + partial index mirroring the wire union (local-sqlite-schema.md), and updated the `DiffArtifactCreateRequest` at-rest-mirror comment (api-payload-contracts.md). Spec-009 untouched — its extension-column enumeration (`Spec-009 §DiffArtifact and General Artifact Relationship`) already omits resolver columns. Schema-and-contract reconcile, not a new surface — Plan-009 stays `approved`. No upstream-tier or sealed-spec amendments.
- 2026-06-19 — Codex review round 19 (PR finalization): finding KuB_5 adjudicated valid and fixed by ratifying **D-009-5**. A-009-1's method-name sub-conclusion was wrong — it appealed to a "standing PascalCase JSON-RPC convention" that does not exist (the ratified `METHOD_NAME_FORMAT` is `dotted-camelCase` and rejects PascalCase), and asserted no method-name registry was needed while every sibling plan enumerates its wire methods in a canonical `api-payload-contracts.md` table. Registered the four `gitflow.*` methods (`gitflow.branchContextRead` `query`; `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute` `mutation`) in a new method table there, updated the Task 3 / Task 4 consume-lines (now the T11.3 / T11.4 `Consumes:` rows under §Implementation Phase Sequence), and marked the superseded A-009-1 clause (the 2026-06-15 Notes entry above). `GitHostingAdapter` + its nine supporting types remain daemon-internal (D-009-1). Registers existing operations under the canonical naming contract — no new operation, no new contract surface — so Plan-009 stays `approved`. The api-payload table insertion shifted five Plan-013 inbound line-cites (realigned in the same commit). No upstream-tier or sealed-spec amendments.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
