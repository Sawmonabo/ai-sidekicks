# Plan-011: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `011` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` (Tier-7 readiness audit 2026-06-15) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-011: Gitflow PR And Diff Attribution](../specs/011-gitflow-pr-and-diff-attribution.md) |
| **Required ADRs** | [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (worktree infrastructure), [Plan-014](./014-artifacts-files-and-attachments.md) (artifact manifests) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md) (Agent Trace attribution, GitHostingAdapter) |

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
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-7 audit (2026-06-15): 7 findings adjudicated via A-011-1..4; D-011-1..3 ratified (the nine `GitHostingAdapter` supporting types, the `attribution_mode` value set, and the `src/git/` → `src/gitflow/` daemon-path correction). §Invariants I-011-1..3, §Cross-Plan Obligations CP-011-1/2, and the `#### Tasks` block record EXISTING relationships; D-011-3 relocates Plan-011's own services out of Plan-010-owned `src/git/` into `src/gitflow/` (a path correction, not a new file) — no new contract surface, so Plan-011 stays `approved`. Companion amendments: api-payload-contracts.md (nine `GitHostingAdapter` types + `attributionMode` enum), local-sqlite-schema.md (`diff_artifacts.attribution_mode` CHECK), cross-plan-dependencies.md §2 (`src/gitflow/` ownership row).

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
- Extend `branch_contexts` (owner: Plan-010 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `branch_contexts` — Plan-011 ALTER/USE).
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add branch-context read, diff artifact read, and PR prepare APIs to the client SDK.

## Invariants

- **I-011-1** — A diff artifact emitted under the workspace-fallback path is labeled as such and is never presented as run-attributed (`Spec-011 §Required Behavior`, `Spec-011 §Fallback Behavior`, `Spec-011 §Pitfalls To Avoid`).
- **I-011-2** — PR preparation derives base and head exclusively from the recorded branch context, never from transient client/tab state (`Spec-011 §Required Behavior`, `Spec-011 §Pitfalls To Avoid`).
- **I-011-3** — No remote git mutation occurs without a prior durable, reviewable preparation record (`Spec-011 §Required Behavior`, `Spec-011 §State And Data Implications`, `Spec-011 §Pitfalls To Avoid`).

## Cross-Plan Obligations

- **CP-011-1 (consumes)** — Imports `BranchContextId` and reads/extends the `branch_contexts` row owned by Plan-010 (cross-plan-dependencies §1; Plan-010 CP-010-6). Plan-011 extends via ALTER + service access, never by editing Plan-010's git/ module.
- **CP-011-2 (consumes)** — Uses `artifact_manifests` + the OCI envelope and the `artifacts/` module owned by Plan-014 (cross-plan-dependencies §2 line 88; `Spec-014 §State And Data Implications`). DiffArtifact rides as artifactType `"diff"` under that envelope.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

#### Tasks

1. Implement branch-context persistence tied to writable execution modes and runs.
   - **Spec coverage:** Spec-011 line 40 (every writable run executes against an explicit branch context); line 41 (track base/head/worktree association); line 64 (`BranchContextRead` exposes base/head/upstream/worktree); AC line 173.
   - **Verifies invariant:** — (no I-011 invariant governs persistence directly — A-011-2 adjudicates Task 1 as persistence backfill, not gated by an I-011 invariant).
   - **Consumes:**
     - `BranchContextId` ← Plan-010 provider (cross-plan-dependencies §1 line 22; Plan-010 CP-010-6) — minted by `repo.executionRootPrepare`; SHAPE verified present.
     - `branch_contexts` row (ALTER/extend) ← Plan-010 provider ([`branch_contexts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-009-plan-010-plan-011); §1 line 22) — at-most-one association CHECK + (worktree_id, workspace_id) partial-unique index present.
     - `WorktreeId`, `WorkspaceId`, `EphemeralCloneId` branded types ← Plan-010 provider (api-payload-contracts BranchContextReadResponse fields) — present.

2. Build diff artifact generation with explicit attribution mode. Use Agent Trace standard and git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for commit-level and line-level provenance. DiffArtifact is a specialized artifact (`artifactType: "diff"`) using the OCI manifest envelope defined in Spec-014.
   - **Attribution-mode value set (D-011-2 — resolved):** the `diff_artifacts.attribution_mode` value set is canonicalized to `run_attributed` / `workspace_fallback` (the `Spec-011 §Default Behavior` / `Spec-011 §Fallback Behavior` provenance-quality vocabulary), superseding the prior wire+schema `agent_trace`/`git_diff` pair that conflated provenance quality with the attribution mechanism. The enum/CHECK edge is now executable: `attributionMode: "run_attributed" | "workspace_fallback"` (api-payload-contracts.md) and `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))` (local-sqlite-schema.md). This reconciled an existing contract, not a new contract surface — the plan stays `approved`.
   - **Spec coverage:** Spec-011 line 42 (diff provenance to producing run); line 43 (`artifactType: "diff"` in the Spec-014 envelope); line 44 (labeled workspace-level fallback); line 45 (Agent Trace + git trailers); line 52 / line 58 (the two attribution modes); AC line 174.
   - **Verifies invariant:** I-011-1 — workspace-fallback never labeled run-attributed.
   - **Consumes:**
     - `artifact_manifests` + OCI envelope, `artifactType: "diff"` ← Plan-014 provider ([`artifact_manifests`](../architecture/schemas/local-sqlite-schema.md#artifact-tables-plan-014); `Spec-014 §Interfaces And Contracts`, return-cite `Spec-014 §State And Data Implications`) — SHAPE verified: `"diff"` admitted by the artifactType discriminator.
     - `diff_artifacts` table (CREATE, Plan-011-owned) — fully specified ([`diff_artifacts`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-009-plan-010-plan-011): FK to artifact_manifests, `run_id` (nullable — present for `run_attributed`, null for `workspace_fallback`) + `workspace_id` (nullable mirror, `REFERENCES workspaces(id)` — present for `workspace_fallback`, null for `run_attributed`; the durable workspace-level provenance `Spec-011 §Required Behavior` mandates, D-011-4), both guarded by the symmetric biconditional `CHECK((attribution_mode = 'run_attributed' AND run_id IS NOT NULL AND workspace_id IS NULL) OR (attribution_mode = 'workspace_fallback' AND run_id IS NULL AND workspace_id IS NOT NULL))` per `Spec-011 §Required Behavior` / `Spec-011 §Fallback Behavior`, attribution_mode, base_ref, head_ref).
     - `attributionMode` enum ← **RESOLVED (D-011-2)**: canonicalized to the Spec vocabulary `run_attributed` / `workspace_fallback` in both contract (api-payload-contracts.md `attributionMode: "run_attributed" | "workspace_fallback"`) and schema (local-sqlite-schema.md `CHECK(attribution_mode IN ('run_attributed', 'workspace_fallback'))`), matching the AC-174 Spec vocabulary. The prior `agent_trace`/`git_diff` pair is dropped.

3. Build reviewable PR preparation records and remote mutation handoff. Implement the `GitHostingAdapter` interface with `gh` CLI as the V1 backend; use normalized `createChangeRequest` terminology and auto-detect provider from the git remote URL.
   - **Spec coverage:** Spec-011 line 46 (PR prep uses recorded base/head, not client tab); line 47 (commit/push/PR reviewable before execution); line 51 (default PR target = recorded base); line 66 (`PRPrepare` reviewable proposal before remote mutation); line 67 (`GitActionExecute` preserves causation); line 68 + §Git Hosting Adapter lines 118-152 (GitHostingAdapter / gh / createChangeRequest / auto-detect); AC line 175.
   - **Verifies invariant:** I-011-2 + I-011-3 — base/head from recorded context; durable reviewable record before remote mutation.
   - **Consumes:**
     - `pr_preparations` table (CREATE, Plan-011-owned) — fully specified ([`pr_preparations`](../architecture/schemas/local-sqlite-schema.md#workspace-and-git-tables-plan-009-plan-010-plan-011): branch_context_id FK, state CHECK, proposal_blob, target_branch).
     - `RepoMountId`, `RunId`, `ParticipantId` branded types ← upstream providers (GitActionExecute fields) — present.
     - `GitHostingAdapter` param/result types (`ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, `CommentResult`) ← **RESOLVED (D-011-1)**: all nine host-agnostic shapes are now defined in `docs/architecture/contracts/api-payload-contracts.md §Plan-011 — Gitflow PR And Diff Attribution` (GitHostingAdapter supporting-types block), each using generic ChangeRequest terminology with the `gh`-CLI field mapping noted inline — SHAPE present.
     - wire method names `gitflow.prPrepare` / `gitflow.gitActionExecute` ← **RESOLVED (A-011-1 + D-011-5)**: the request/response shapes are defined in api-payload-contracts.md (`PRPrepareRequest`/`PRPrepareResponse`, `GitActionExecuteRequest`/`GitActionExecuteResponse`), and the four `gitflow.*` wire method-name strings are now registered in the canonical method table there (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`) — `dotted-camelCase` per the `METHOD_NAME_FORMAT` registry, which **rejects** the PascalCase type symbols (`PRPrepare`, `GitActionExecute`) as method strings (D-011-5 supersedes A-011-1's earlier 'standing PascalCase convention' adjudication).

4. Add desktop diff and PR preparation review surfaces.
   - **Spec coverage:** Spec-011 line 47 (reviewable before execution); line 44 (explicit fallback labeling shown in UI); line 161 (attribution quality is a first-class field, not a UI decoration); AC line 174 (modes distinguished) + AC line 175 (reviewable proposal).
   - **Verifies invariant:** I-011-1 — UI surfaces the fallback label honestly.
   - **Consumes:**
     - renderer path `apps/desktop/src/renderer/src/diff-review/` ← Plan-011-owned (cross-plan-dependencies §2 line 100) — present/pinned.
     - `gitflowClient` SDK ← Plan-011-owned (`packages/client-sdk/src/gitflowClient.ts`, §Target Areas) — to be authored by this plan; depends on the four `gitflow.*` wire methods (`gitflow.branchContextRead` / `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute`), RESOLVED via A-011-1 + D-011-5 — the four method names are registered in the canonical method table in api-payload-contracts.md (`dotted-camelCase` per `METHOD_NAME_FORMAT`).
     - attribution-mode + artifact-payload contracts ← consumes the same enum/shapes as Step 2 — RESOLVED via D-011-2 (the `run_attributed`/`workspace_fallback` mode labels are fixed) for the mode-label rendering.

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

## Ratified Design Decisions (Tier-7 audit)

- **D-011-1 — The nine `GitHostingAdapter` param/result shapes are host-agnostic contract types, now defined in `api-payload-contracts.md`.** The `Spec-011 §GitHostingAdapter Interface` named `ChangeRequestParams`, `ChangeRequestResult`, `UpdateChangeRequestParams`, `ListChangeRequestsParams`, `ChangeRequestSummary`, `GetChangeRequestStatusParams`, `ChangeRequestStatus`, `AddCommentParams`, and `CommentResult` but left them undefined. The audit authored all nine using generic ChangeRequest terminology (callers never reference GitHub-specific concepts, `Spec-011 §Multi-Host Path (V2)`), each field mapped to the V1 `gh` CLI contract inline (`Spec-011 §GitHostingAdapter Interface`). This defines previously-named-but-undefined types — it does not introduce a new contract surface.
- **D-011-2 — `diff_artifacts.attribution_mode` canonicalizes to `run_attributed` / `workspace_fallback`.** The `Spec-011 §Default Behavior` / `Spec-011 §Fallback Behavior` provenance-quality vocabulary is adopted in both the wire contract (`attributionMode: "run_attributed" | "workspace_fallback"`) and the schema CHECK, superseding the prior `agent_trace`/`git_diff` pair that conflated the provenance-quality axis (does this diff correlate to a run?) with the attribution mechanism. AC-174 is stated in this vocabulary, so the contract now matches the acceptance criterion. Reconcile of an existing contract, not a new surface.
- **D-011-3 — Plan-011's daemon services move from `runtime-daemon/src/git/` to `runtime-daemon/src/gitflow/`.** `src/git/` is Plan-010-owned (worktree services; cross-plan-dependencies.md §2, Plan-010 CP-010-7) and Plan-011 must consume it through contracts/services, never edit it directly. `branch-context-service.ts` and `pr-preparation-service.ts` were always Plan-011's; listing them under `src/git/` mis-cited Plan-011-owned files inside Plan-010's directory. Retargeting to `src/gitflow/` — consistent with the `gitflow.ts` contract and `gitflowClient.ts` SDK already in §Target Areas — is a path correction of an ownership-boundary violation, recorded by a new cross-plan-dependencies.md §2 ownership row. Not a new contract surface.
- **D-011-4 — `diff_artifacts` persists `workspace_id` for the `workspace_fallback` arm.** The round-11 reshape (D-011-2) carried `workspaceId` on the wire's `workspace_fallback` arm but dropped it at rest, justified by an `api-payload-contracts.md` comment that the workspace was a "mint-time resolver" reached transiently. That left `Spec-011 §Required Behavior`'s "clearly labeled workspace-level diff artifact" undurable: a `workspace_fallback` row recorded its mode but not _which_ workspace produced it (the `artifact_manifest_id` FK reaches only the session, and `run_id` is null by construction for the fallback arm). The audit adds a nullable `workspace_id TEXT REFERENCES workspaces(id)` column — FK because `workspaces` is table-backed, unlike the event-sourced `run_id`/`session_id` columns that carry no FK (local-sqlite-schema.md `run_execution_contexts` establishes this convention) — guarded by a symmetric biconditional `CHECK((run_attributed AND run_id IS NOT NULL AND workspace_id IS NULL) OR (workspace_fallback AND run_id IS NULL AND workspace_id IS NOT NULL))` mirroring the wire union, plus a partial index `idx_diff_artifacts_workspace`. `run_attributed` persists no `workspace_id` (its workspace is reachable via the run's `run_execution_contexts.workspace_id`). This reverses a round-11 comment-level decision (no numbered decision was attached). Spec-011 is untouched: its §Data Model extension-column enumeration (`Spec-011 §DiffArtifact and General Artifact Relationship`) already lists only `attribution_mode`/`base_ref`/`head_ref`, omitting resolver columns like `run_id`, so `workspace_id` (also a resolver) needs no Spec edit. Schema-and-contract reconcile of an existing surface, not a new contract surface — Plan-011 stays `approved`.
- **D-011-5 — The four Plan-011 wire operations are assigned `gitflow.*` `dotted-camelCase` JSON-RPC method names, registered in a canonical `api-payload-contracts.md` method table.** A-011-1 had deferred method naming to a "standing PascalCase JSON-RPC convention" and concluded no method-name registry was needed — but no such convention exists: the ratified `METHOD_NAME_FORMAT` (api-payload-contracts.md §Tier 1 (cont.): Plan-007) is `dotted-camelCase` and **rejects** PascalCase strings, and every sibling wire surface (`run.*`, `repo.*`, `approval.*`, `participant.*`) enumerates its methods in a canonical table there. The audit registers the four `gitflow.*` methods — `gitflow.branchContextRead` (`query`); `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute` (`mutation`) — mapped to the existing `BranchContextRead` / `DiffArtifactCreate` / `PRPrepare` / `GitActionExecute` request/response types; the `GitHostingAdapter` and its nine supporting types stay daemon-internal (not wire methods, D-011-1). Registers existing operations under the canonical naming contract rather than adding a new operation, so Plan-011 stays `approved`. (Codex round-19 finding KuB_5.)

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

- 2026-06-15 — Tier-7 plan-readiness audit (NS-19): 7 findings adjudicated via A-011-1..4; D-011-1..3 ratified. Decisions: D-011-1 authored the nine `GitHostingAdapter` supporting types (api-payload-contracts.md); D-011-2 canonicalized `attribution_mode` to `run_attributed`/`workspace_fallback` across contract + schema, dropping the `agent_trace`/`git_diff` pair; D-011-3 retargeted Plan-011's daemon services out of Plan-010-owned `src/git/` into `src/gitflow/` (plus a cross-plan-dependencies.md §2 ownership row). Adjudications: A-011-1 — `PRPrepare`/`GitActionExecute` method names follow the standing JSON-RPC naming convention (request/response shapes already defined in api-payload-contracts.md), so no separate method-name registry is required [**superseded 2026-06-19 by D-011-5** — the standing convention is `dotted-camelCase`, not PascalCase; `METHOD_NAME_FORMAT` rejects PascalCase, so the four `gitflow.*` wire names are now registered in a canonical method table in api-payload-contracts.md; see the 2026-06-19 Notes entry]; A-011-2 — Task 1 persistence is backfill not governed by an I-011 invariant; A-011-3 — §Cross-Plan Obligations CP-011-1/2 record EXISTING consume relationships (Plan-010 `branch_contexts`, Plan-014 artifacts envelope); A-011-4 — `#### Tasks` gitflow.ts edge sequencing recorded. Every item records an existing relationship or corrects a mis-cited path — no new contract surface — so Plan-011 stays `approved`. No upstream-tier or sealed-plan amendments.
- 2026-06-17 — Codex review round 9 (NS-19 PR finalization): one finding adjudicated valid against the `gh` CLI primary source and fixed at the requirement level. The D-011-1 `createChangeRequest` contract mapped `gh pr create` + a bare `gh pr view --json number,url`, but `gh pr create` exposes no `--json` flag — it prints only the new PR URL to stdout — and a bare `gh pr view` resolves the CURRENT branch's PR, not the one just created on an arbitrary `headBranch`. Corrected the `Spec-011 §Git Hosting Adapter` table row + §Interfaces prose (`Spec-011 §GitHostingAdapter Interface`) and the `ChangeRequestParams` / `ChangeRequestResult` contract comments (api-payload-contracts.md) to the `gh pr create` → `gh pr view <created-url> --json number,url` sequence, with the create-stdout URL passed explicitly to the read. Verified against `gh pr create --help` + `gh pr view --help`. Compliance fix to the already-ratified D-011-1 contract — no new D-number; the Spec-011 correction is content-only and Spec-011 stays `approved`. No upstream-tier or sealed-plan amendments.
- 2026-06-18 — Codex review round 18 (NS-19 PR finalization): finding KscWH adjudicated valid and fixed by ratifying **D-011-4**. The round-11 reshape (D-011-2) carried `workspace_fallback.workspaceId` on the wire but dropped it at rest, so the workspace-level provenance `Spec-011 §Required Behavior` mandates was not durable. Added a nullable `workspace_id TEXT REFERENCES workspaces(id)` column to `diff_artifacts` (FK because `workspaces` is table-backed, unlike the event-sourced `run_id`/`session_id`), a symmetric biconditional CHECK + partial index mirroring the wire union (local-sqlite-schema.md), and updated the `DiffArtifactCreateRequest` at-rest-mirror comment (api-payload-contracts.md). Spec-011 untouched — its extension-column enumeration (`Spec-011 §DiffArtifact and General Artifact Relationship`) already omits resolver columns. Schema-and-contract reconcile, not a new surface — Plan-011 stays `approved`. No upstream-tier or sealed-spec amendments.
- 2026-06-19 — Codex review round 19 (NS-19 PR finalization): finding KuB_5 adjudicated valid and fixed by ratifying **D-011-5**. A-011-1's method-name sub-conclusion was wrong — it appealed to a "standing PascalCase JSON-RPC convention" that does not exist (the ratified `METHOD_NAME_FORMAT` is `dotted-camelCase` and rejects PascalCase), and asserted no method-name registry was needed while every sibling plan enumerates its wire methods in a canonical `api-payload-contracts.md` table. Registered the four `gitflow.*` methods (`gitflow.branchContextRead` `query`; `gitflow.diffArtifactCreate` / `gitflow.prPrepare` / `gitflow.gitActionExecute` `mutation`) in a new method table there, updated the Task 3 / Task 4 consume-lines (:99, :106), and marked the superseded A-011-1 clause (:159). `GitHostingAdapter` + its nine supporting types remain daemon-internal (D-011-1). Registers existing operations under the canonical naming contract — no new operation, no new contract surface — so Plan-011 stays `approved`. The api-payload table insertion shifted five Plan-015 inbound line-cites (realigned in the same commit). No upstream-tier or sealed-spec amendments.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
