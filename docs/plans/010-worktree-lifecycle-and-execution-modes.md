# Plan-010: Worktree Lifecycle And Execution Modes

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `010` |
| **Slug** | `worktree-lifecycle-and-execution-modes` |
| **Date** | `2026-04-14` (Tier-6 readiness audit 2026-06-10) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-010: Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-006](../decisions/006-worktree-first-execution-mode.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-009](./009-repo-attachment-and-workspace-binding.md) (workspace infrastructure — canonical repo/workspace contract types per CP-009-1, reprovision primitives per CP-009-2, `assertWritable` per CP-009-3, `markBusy`/`releaseBusy` per CP-009-7, `repo_mounts`/`workspaces` tables), [Plan-001](./001-shared-session-core.md) (daemon SQLite substrate — migration-runner guarded-block seam + `openDatabase`, shipped Tier 1; `SessionIdSchema`), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4 — Plan-010 registers the 5 `worktree.*` event types and consumes `EventLogService.append` + the T1.2 type registry; build-order precondition for Phases 1–2), [Plan-007](./007-local-ipc-and-daemon-control.md)-partial (Tier 1 — `MethodRegistry` + SDK `JsonRpcClient`; Phase-3 registration gated on BL-142 + BL-143), [Plan-004](./004-queue-steer-pause-resume.md) (Tier 5 — `RunSetupGate` seam per Plan-004 T3.10 / CP-004-8 + `QueueItemCreateRequest.workspaceId?`), [Plan-023](./023-desktop-shell-and-renderer.md)-partial (Tier 1 — renderer substrate + `window.sidekicks` bridge stub; live IPC at Tier 8) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the four-mode repo execution contract with worktree-first writable defaults plus the lifecycle management around worktree preparation, reuse, retirement, and ephemeral clone preparation.

## Scope

This plan covers execution mode selection, read-only and branch gating, worktree creation, ephemeral clone preparation, reuse validation, lifecycle projection, run-setup execution-root binding, and fallback handling.

## Non-Goals

- PR preparation
- Diff attribution logic
- Non-repo directory execution semantics
- Automatic repository setup-script execution during execution-root preparation

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-6 audit (2026-06-10), this revision: 67 findings adjudicated; four-phase `#### Tasks` structure, §Invariants, §Cross-Plan Obligations, and §Ratified Design Decisions authored; reciprocal amendments in Plan-004/Plan-009/Spec-009/Spec-010 landed in the same audit PR.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/worktree.ts` (D-010-1 — renamed from the pre-audit `execution-mode.ts`; the file's dominant noun is the worktree/clone lifecycle domain)
- `packages/contracts/src/index.ts` + `packages/contracts/src/event.ts` (EXTEND — barrel + event-union registration)
- `packages/runtime-daemon/src/migrations/` (new guarded-block migration, 4 tables)
- `packages/runtime-daemon/src/git/` (Plan-010-owned directory per cross-plan §2: `worktree-event-emitter.ts`, `worktree-service.ts`, `ephemeral-clone-service.ts`, `worktree-projector.ts`, `worktree-errors.ts` + `__tests__/`)
- `packages/runtime-daemon/src/workspace/execution-root-service.ts` + `packages/runtime-daemon/src/workspace/execution-mode-service.ts` (the exactly-two Plan-010 files in Plan-009-owned `workspace/` per cross-plan §2)
- `packages/runtime-daemon/src/ipc/handlers/` (7 `repo.*` binder files + `index.ts` EXTEND)
- `packages/client-sdk/src/worktreeClient.ts` + `packages/client-sdk/src/index.ts` + `packages/client-sdk/test/worktreeClient.integration.test.ts`
- `apps/desktop/src/renderer/src/execution-mode-picker/` (`ExecutionModePicker.tsx`, `ModeSwitchOptions.tsx`, `WorktreeStatusView.tsx`, `WorktreeReuseCheckView.tsx`, `index.ts`, `__tests__/`)

## Data And Storage Changes

- Add local `worktrees`, `ephemeral_clones`, `branch_contexts`, and `run_execution_contexts` tables (D-010-5).
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions — the audited DDL there is the verbatim migration content.

## API And Transport Changes

- Seven `repo.*` JSON-RPC methods (D-010-3): `repo.executionModeSelect`, `repo.executionRootPrepare`, `repo.worktreeReuseCheck`, `repo.ephemeralClonePrepare`, `repo.ephemeralCloneDispose`, `repo.worktreeRetire`, `repo.worktreeStatusRead` — wire contract in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-010 + §Repo Method-Name Registry (Tier 6).
- Error vocabulary in [Error Contracts](../architecture/contracts/error-contracts.md) §Worktree + §Ephemeral Clone + §Workspace extension rows (D-010-4).

## Invariants

| ID | Invariant | Tasks |
| --- | --- | --- |
| **I-010-1** | Single-definition imports: `worktree.ts` imports `ExecutionMode`, `WorkspaceState`, `RepoMountState`, branded `RepoMountId`/`WorkspaceId`, and `RepoWorkspaceLifecyclePayloadSchema` from Plan-009's `repo.ts`; it never redefines them (CP-010-1). | T1.1 |
| **I-010-2** | Contract↔DDL lockstep: `WorktreeState`, `EphemeralCloneState`, and the cleanup-policy literal union are byte-identical between `worktree.ts` and the migration `CHECK` constraints — pinned by a conformance test. | T1.3, T1.4 |
| **I-010-3** | Provenance: every worktree row persists `created_by_session_id` (and `created_by_run_id` when run-created); retirement never erases provenance. | T1.3, T2.2 |
| **I-010-4** | Active-branch uniqueness: at most one live worktree (state NOT IN `retired`,`failed`) per (repo mount, branch) — the partial-unique index is the race arbiter; services treat its violation as the typed collision/retry signal, never a crash. | T1.3, T2.2 |
| **I-010-5** | Branch-context representability: every writable-mode run's branch context is persistable — worktree rows reference the worktree, clone rows the clone, branch-mode rows neither; the at-most-one CHECK holds. | T1.3, T2.4 |
| **I-010-6** | The main checkout is never mutated: no Plan-010 code path checks out, creates, switches, or merges branches inside the mount's main checkout; `branch` mode binds and verifies only (D-010-9). | T2.2, T2.4, T2.6 |
| **I-010-7** | No silent mode substitution: requested-mode unavailability is a typed refusal (`workspace.mode_unsupported` at select; `worktree.create_failed`/`clone.prepare_failed` at prepare) — never a substituted mode, never a fallback root. | T3.1, T2.4, T2.6 |
| **I-010-8** | Explicit reuse only: a worktree binds as a reuse target only via `reuseWorktreeId`; a dirty candidate additionally requires `acknowledgeDirtyCandidate`; an incompatible candidate never binds; no code path reuses implicitly (D-010-15). | T2.2, T2.4 |
| **I-010-9** | Recorded-then-cleaned: retire/dispose record the state transition and emit before any disk mutation; disk cleanup is asynchronous, idempotent, and stamped via `cleaned_at`. | T2.2, T2.3 |
| **I-010-10** | No repository-controlled code executes during provisioning: every git invocation neutralizes hooks (empty `core.hooksPath` via argv) and no setup script runs (D-010-10). | T2.2, T2.3, T2.6 |
| **I-010-11** | Workspace writes ride Plan-009 primitives exclusively (`beginReprovision`/`completeReprovision`/`failReprovision`/`markBusy`/`releaseBusy`/`assertWritable`); zero raw UPDATEs on the `workspaces` table from Plan-010 code (CP-010-2/3/4). | T2.4, T3.1, T3.2 |
| **I-010-12** | A `stale` workspace never receives an execution root: `assertWritable` precedes every writable-mode prepare. | T2.4, T3.2 |
| **I-010-13** | Exactly-once events: each worktree transition emits its D-010-12-mapped event exactly once, transactionally with the row write; `failed` deliberately emits none (pinned by a regression test); clone transitions emit none (D-010-11). | T2.1, T2.2 |
| **I-010-14** | Run gate: no repo-bound run reaches `running` without a resolved execution root, a `run_execution_contexts` row, and a busy-marked workspace; gate refusal parks the run in `starting` (D-010-16). | T3.2 |
| **I-010-15** | Daemon-side validation: every `repo.*` method validates its request schema and resolves every verdict daemon-side; SDK and renderer never compute cleanliness, compatibility, naming, or roots. | T3.3, T3.4, T3.6 |
| **I-010-16** | SDK marshals, never derives: `worktreeClient` methods are schema-validated pass-throughs; no retry-with-substitution, no client-side defaulting. | T3.5, T3.7 |
| **I-010-17** | One explicit user action → one mutation: the picker fires exactly one `repo.executionModeSelect` per switch and never client-sequences a prepare after it; reuse/retire affordances are click-explicit with no auto-proceed (D-010-14). | T4.1, T4.3 |
| **I-010-18** | The picker renders the daemon's mode set verbatim: options come from `repo.executionModeCapabilitiesRead` (`availableModes` + `restrictions`); no synthesized or hidden modes. | T4.1, T4.4 |
| **I-010-19** | Never-hide rows: status views render every row the status read returns — including `failed` and `retired` — with their states labeled (admit-not-eject posture). | T4.2, T4.4 |
| **I-010-20** | Views render daemon verdicts verbatim and derive nothing (no client-side expiry math, cleanliness inference, or root computation). | T4.1, T4.2, T4.3, T4.4 |

## Cross-Plan Obligations

- **CP-010-1 — Import Plan-009's canonical repo/workspace contract types (reciprocal of Plan-009 CP-009-1).** `worktree.ts` imports `ExecutionMode`, `WorkspaceState`, `RepoMountState`, branded `RepoMountId`/`WorkspaceId`, and `RepoWorkspaceLifecyclePayloadSchema` from `packages/contracts/src/repo.ts` — never redefines. **Direction:** Consume from [Plan-009](./009-repo-attachment-and-workspace-binding.md). **Tasks:** T1.1.
- **CP-010-2 — Workspace reprovision transitions ride Plan-009 primitives (reciprocal of CP-009-2).** `execution-root-service.ts` / `execution-mode-service.ts` drive `ready -> provisioning -> ready` exclusively through `beginReprovision` / `completeReprovision` / `failReprovision`. **Direction:** Consume from Plan-009. **Tasks:** T2.4, T3.1.
- **CP-010-3 — `assertWritable` precedes every writable-mode root prepare (reciprocal of CP-009-3).** Typed `workspace.stale` refusal per error-contracts.md §Workspace. **Direction:** Consume from Plan-009. **Tasks:** T2.4, T3.2.
- **CP-010-4 — Busy bracket via `markBusy`/`releaseBusy` (reciprocal of CP-009-7).** The run-setup gate brackets every repo-bound run's root hold; one holding run at a time in V1; a concurrent hold refuses `workspace.busy`. **Direction:** Consume from Plan-009. **Tasks:** T3.2.
- **CP-010-5 — Worktree event registration with Plan-006.** Phase 1 registers the 5 `worktree.*` types — `worktree.created` (Spec-006 line 253), `worktree.ready` (Spec-006 line 254), `worktree.dirty` (Spec-006 line 255), `worktree.merged` (Spec-006 line 256), `worktree.retired` (Spec-006 line 257) — into the Plan-006-owned `SessionEventSchema` union as an additive-MINOR EXTEND, reusing Plan-009's `RepoWorkspaceLifecyclePayloadSchema` (it already carries `worktreeId?`); type names + `session_lifecycle` category mapping ship in Plan-006 T1.2. Phase 2 consumes `EventLogService.append` as the sole append path. The registry count stays closed at 125 — no `worktree.failed`, no clone events (D-010-11). **Direction:** Extend [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (additive). **Tasks:** T1.1, T2.1.
- **CP-010-6 — `branch_contexts` + `BranchContextId` provided forward to Plan-011.** Plan-010 creates the polymorphic carrier table and brand; Plan-011 extends it for PR/diff attribution (cross-plan §1 row). **Direction:** Provide to [Plan-011](./011-gitflow-pr-and-diff-attribution.md). **Tasks:** T1.1, T1.3, T2.4.
- **CP-010-7 — `packages/runtime-daemon/src/git/` directory creation.** Plan-010 creates and owns the subdirectory (cross-plan §2 git/ row); adjacent plans consume through contracts/services, never by adding files here. **Direction:** Create. **Tasks:** T2.1.
- **CP-010-8 — Seven `repo.*` methods registered under Plan-007's `MethodRegistry`.** Same namespace as Plan-009's six (one-namespace-per-domain-aggregate, D-010-3); registration gated on BL-142 (registry regex conformance) and wire-observable typed errors on BL-143 (`DaemonDomainError` projection). Plan-007 owns the registry surface, not these handlers. **Direction:** Register with [Plan-007](./007-local-ipc-and-daemon-control.md). **Tasks:** T3.3, T3.4, T3.6.
- **CP-010-9 — `RunSetupGate` registration (reciprocal of Plan-004 CP-004-8).** Plan-010's execution-root gate registers on the Plan-004 T3.10 seam (`assertRunReady` + `onRunTerminal`), consuming the `QueueItemCreateRequest.workspaceId?` run-binding carrier. **Direction:** Consume from [Plan-004](./004-queue-steer-pause-resume.md). **Tasks:** T3.2.
- **CP-010-10 — Plan-023 owns the `window.sidekicks` preload bridge the Phase 4 views project over.** Views are thin bridge projections (exported + barreled, not App-shell-mounted); live IPC dispatch lands at Plan-023 Tier 8 — until then bridge methods throw `NotImplementedAtTier1Error` and rejected/error branches are the production-observable paths (same posture as Plan-009 CP-009-6). **Direction:** Honor [Plan-023](./023-desktop-shell-and-renderer.md). **Tasks:** T4.1–T4.4.
- **CP-010-11 — Renderer boundary with Plan-009.** Bind-time intended-mode selection lives in Plan-009's `repo-attach/` views; run-time mode switching of an existing workspace lives here in `execution-mode-picker/` (cross-plan §2 renderer row). `ModeSwitchOptions` is this plan's own presentational component — no import from `../repo-attach/` (D-010-18). **Direction:** Honor Plan-009 boundary. **Tasks:** T4.1.
- **CP-010-11 — Worktree envelope roots + per-run execution binding for approval path-scope matching (Tier-6 Plan-012 walk).** `worktrees.fs_root` and the `run_execution_contexts` per-run binding (`run_id -> execution_root`, D-010-5) are what Plan-012's remembered-scope matcher resolves to evaluate path-category prefix containment for a repo-bound run; unknown provenance falls back to strict per-request approval (Spec-012:78). Plan-012 reads the binding + root only — never writes Plan-010-owned rows. Within-tier ordering: Plan-012 builds after Plan-010 (this binding is a precondition). **Direction:** Provide to [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (reciprocal CP-012-9). **Tasks:** T1.3 (tables), T3.2 (the gate writes the `run_execution_contexts` row).

## Ratified Design Decisions (Tier-6 audit, 2026-06-10)

- **D-010-1 — Contract file is `packages/contracts/src/worktree.ts`** (renamed from the pre-audit `execution-mode.ts`): the file's dominant content is the worktree/clone lifecycle domain; one-file-per-domain per cross-plan §2 contracts row.
- **D-010-2 — Consolidated wire block.** Seven request/response pairs + `EphemeralCloneId`/`BranchContextId` brands + `EphemeralCloneState` enum ratified in api-payload-contracts.md §Plan-010 (brands/enums declared in-block for cite stability). Clone-prepare responses report effective `cleanupPolicy` + `expiresAt`; select responses carry `executionRoot` only when resolved synchronously.
- **D-010-3 — Method namespace is `repo.*`, seven methods** (`repo.executionModeSelect`, `repo.executionRootPrepare`, `repo.worktreeReuseCheck`, `repo.ephemeralClonePrepare`, `repo.ephemeralCloneDispose`, `repo.worktreeRetire`, `repo.worktreeStatusRead`). A `worktree.*` method root was considered and rejected: the Tier-1 ratified namespace-root enumeration admits `repo` and no `worktree` root; mounts/workspaces/worktrees/clones are one repo aggregate; sibling symmetry with `repo.executionModeCapabilitiesRead`. Imperative method strings stay disjoint-by-form from the past-participle Spec-006 event names.
- **D-010-4 — Error vocabulary.** §Worktree: `worktree.not_found` 404, `worktree.create_failed` 500, `worktree.branch_collision` 409, `worktree.reuse_conflict` 409, `worktree.retire_conflict` 409. §Ephemeral Clone: `clone.not_found` 404, `clone.prepare_failed` 500. §Workspace extension rows: `workspace.branch_mismatch` 409, `workspace.busy` 409, `workspace.execution_root_unresolved` 409. Deliberately NO `worktree.unsupported`: select-time capability refusal is `workspace.mode_unsupported` (D-009-5); prepare-time dynamic unavailability IS `worktree.create_failed` (500, matching `workspace.provisioning_failed`'s class).
- **D-010-5 — Persistence model (4 tables; DDL verbatim in local-sqlite-schema.md).** `worktrees` carries `created_by_session_id` NOT NULL + `created_by_run_id` nullable (provenance; session/run ids event-sourced, no FK) + `cleaned_at` + the partial-unique `idx_worktrees_active_branch ON (repo_mount_id, branch_name) WHERE state NOT IN ('retired','failed')` — git-faithful: a `merged` checkout still holds its branch; `failed` creations never materialized one. `ephemeral_clones` carries `expires_at` NOT NULL, `updated_at`, `cleaned_at`, CHECKed `cleanup_policy`, and the sweep index `(state, expires_at)`; no `created_by_run_id` (the run edge lives in `run_execution_contexts`). `branch_contexts` is workspace-anchored (`workspace_id` NOT NULL) with nullable `worktree_id`/`ephemeral_clone_id` + an at-most-one CHECK. `run_execution_contexts` (NEW) is the per-run execution binding: `run_id` PK (event-sourced, no FK), `session_id`, `workspace_id`, `execution_mode`, `execution_root`, optional `worktree_id`/`ephemeral_clone_id`/`branch_context_id`, `created_at`, `released_at`.
- **D-010-6 — Execution-root placement + trust envelope.** Daemon-provisioned roots live at `<executionRootsDir>/<repoMountId>/{worktrees|clones}/<id>`, never inside the attached checkout; they are in-envelope by construction (Spec-009 §Local Trust Envelope daemon-provisioned-roots clause). The mount's canonical root hosts the `git -C <canonicalRoot> worktree add <rootPath> …`-shaped invocations only.
- **D-010-7 — Collision policy is provenance-split.** Caller-supplied `branchName` colliding with a live checkout → typed `worktree.branch_collision` refusal (user intent never adapted). Daemon-derived default name colliding → first-free ordinal suffix (`-2`, `-3`, …), persisted + reported verbatim. Service parameter `onCollision: 'refuse' | 'suffix'`: wire prepares always pass `refuse`; the run-setup gate's derived-name path passes `suffix`. The partial-unique index arbitrates races (insert-retry loop). Collision never implies implicit reuse.
- **D-010-8 — Base-ref policy.** Worktree base defaults to the mount's current HEAD branch; `baseRef?` overrides explicitly; a detached-HEAD mount with no explicit base ref → typed refusal (`worktree.create_failed` with detail), never a guess.
- **D-010-9 — `branch` mode is bind-only.** Prepare verifies the main checkout's current branch equals the requested branch context and refuses `workspace.branch_mismatch` otherwise; the daemon never runs `git checkout`/`switch`/`branch` in the main checkout.
- **D-010-10 — Hook neutralization.** Every provisioning git invocation runs via `execFile` argv-only (no shell) with `-c core.hooksPath=<empty dir>`; acceptance fixtures install sentinel `post-checkout`/`post-merge` hooks in a hostile fixture repo and assert the sentinel never fires.
- **D-010-11 — No new event types.** The Spec-006 registry stays closed at 125: no `worktree.failed` event, no ephemeral-clone events. Rationale: worktree rows are table-sourced (not event-replayed); the failure incident is already evented as `workspace.stale` with `metadata.lastError` (single-incident-single-event); failed rows stay queryable via `repo.worktreeStatusRead`; reopening Plan-006's Tier-4-ratified registry needs more than symmetry. The deliberate carve-out is pinned by a T2.1 regression test.
- **D-010-12 — Event-transition mapping.** Row creation → `worktree.created`; `creating -> ready` → `worktree.ready`; `-> dirty` → `worktree.dirty`; `-> merged` → `worktree.merged`; `-> retired` → `worktree.retired`; `-> failed` → none (the coupled `failReprovision` emits `workspace.stale`). Emission is transactional with the row write; the payload is Plan-009's `RepoWorkspaceLifecyclePayloadSchema` (`worktreeId` populated).
- **D-010-13 — Cleanup sweep.** One daemon tick drives: (a) TTL-expired clones (`expires_at` past, state in `creating`/`ready`); (b) clones whose owning workspace is `archived` (detach cascade); (c) worktrees whose mount is `detached` (non-terminal states → retired, events emitted, metadata preserved); (d) disk removal for retired-but-uncleaned rows, idempotent, stamping `cleaned_at`. Retiring the clone backing a live (non-archived) clone-mode workspace's current root returns that workspace to `provisioning` via Plan-009 primitives — `stale` is reserved for fault paths (Spec-009 §Ephemeral Clone Lifecycle).
- **D-010-14 — Select records; prepare materializes.** `repo.executionModeSelect` records the canonical mode and transitions the workspace (`beginReprovision` for writable targets; synchronous complete for `read-only`); per-task root materialization happens at `repo.executionRootPrepare` or the run-setup gate — architecturally forced, since worktree/clone roots are per-task and a select carries no task context. The picker fires exactly one select mutation per switch; selecting on a `stale` workspace is the repair path.
- **D-010-15 — Explicit reuse + dirty acknowledgement.** `reuseWorktreeId` names the candidate; `acknowledgeDirtyCandidate: true` is the separate consent that binds a DIRTY candidate (TOCTOU-sound: a candidate that turned dirty after the check refuses `worktree.reuse_conflict` when the ack is absent). An incompatible candidate never binds regardless of acknowledgement. Explicit reuse preserves the candidate's existing branch-context row.
- **D-010-16 — Run-setup binding.** Plan-010's gate (registered on the Plan-004 T3.10 seam per CP-010-9) implements `assertRunReady`: resolve the queue item's `workspaceId` → `assertWritable` (writable modes) → materialize/bind the root (derived branch name per the slug rule, `onCollision: 'suffix'`) → `markBusy` → write the `run_execution_contexts` row. `onRunTerminal` releases in reverse: `releaseBusy`, stamp `released_at`, fire `on_run_complete` clone retirement (with the D-010-13 workspace disposition). Refusal parks the run in `starting` (`workspace.execution_root_unresolved` wrapping the underlying typed cause); a run on a busy workspace refuses `workspace.busy` (one-holding-run V1 rule).
- **D-010-17 — Status read + stale-diagnostic surface.** `repo.worktreeStatusRead` returns the session's worktree + clone rows with provenance (D-010-2 shape). The owning-workspace stale diagnostic rides Plan-009's `WorkspaceListResponse.lastError?` (additive, ratified into the §Plan-009 block + Plan-009 T1.3 at this audit). No invented wire names: Phase 4 views consume exactly the ratified contract names.
- **D-010-18 — `ModeSwitchOptions` is an own presentational component** (props-only: `availableModes`, `restrictions`, current mode, disabled state) composed by `ExecutionModePicker`; no import from `../repo-attach/` (CP-010-11 boundary).

## Implementation Phase Sequence

Contracts: see [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) §Plan-010 for the typed schemas every phase consumes verbatim.

### Phase 1 — Contracts + persistence

**Goal.** The `worktree.ts` contract domain (seven wire pairs, brands, enums, event registration) and the four-table migration, with contract↔DDL conformance pinned.

**Preconditions.**

- [ ] Plan-009 Phase 1 merged (`packages/contracts/src/repo.ts` — the import origin per CP-010-1)
- [ ] Plan-006 Phase 1 merged (`SessionEventSchema` union seam + `SESSION_EVENT_CATEGORY_BY_TYPE` registry — Tier 4)
- [x] D-010-2 wire shapes ratified — api-payload-contracts.md §Plan-010 (Tier-6 audit)
- [x] D-010-5 DDL ratified — local-sqlite-schema.md (Tier-6 audit)
- [x] D-010-11 event-set adjudicated — five types, registry closed (fixes T1.1's registration count)

#### Tasks

- **T1.1 — `worktree.ts` contract core + event registration.**
  - **Files:** `packages/contracts/src/worktree.ts` (CREATE), `packages/contracts/src/index.ts` (EXTEND — `export * from "./worktree.js";`), `packages/contracts/src/event.ts` (EXTEND — additive registration of the 5 `worktree.*` types into `SessionEventSchema` per CP-010-5)
  - Define and export: `WorktreeId` + `EphemeralCloneId` + `BranchContextId` branded UUID schemas via `brandedUuidIdSchema`; `WorktreeStateSchema` over the six states; `EphemeralCloneStateSchema` over `"creating" | "ready" | "retired" | "failed"`; `CleanupPolicySchema` over `"on_run_complete" | "manual"`. Import — never redefine — `ExecutionMode`, `WorkspaceState`, branded `RepoMountId`/`WorkspaceId`, and `RepoWorkspaceLifecyclePayloadSchema` from `./repo.js` (I-010-1); the worktree events reuse that payload schema (its `worktreeId?` field carries the subject).
  - **Tests:** parse-accept/reject per enum; brand inequality (a `WorktreeId` does not accept a raw string without parse); union registration — each of the 5 event types parses through `SessionEventSchema` with a `worktreeId`-bearing payload; a `worktree.failed` literal is REJECTED by the union (D-010-11 pin).
  - **Spec coverage:** Spec-010 line 48 (six worktree lifecycle states), Spec-010 line 115 (contract distinguishes the four canonical modes — via the imported `ExecutionMode`), Spec-010 line 131 (no-new-event-types carve-out)
  - **Verifies invariant:** I-010-1, I-010-13 (registration half)
  - **Consumes:** `brandedUuidIdSchema` ← `packages/contracts/src/internal/branded.ts` (shipped Tier 2); `ExecutionMode`/`WorkspaceState`/`RepoMountId`/`WorkspaceId`/`RepoWorkspaceLifecyclePayloadSchema` ← Plan-009 Phase 1 T1.1 (CP-010-1); `SessionEventSchema` union seam + category registry ← Plan-006 Phase 1 T1.2 (CP-010-5, additive-MINOR EXTEND)
- **T1.2 — Seven wire request/response pairs.**
  - **Files:** `packages/contracts/src/worktree.ts` (EXTEND)
  - Zod schemas + inferred types implementing api-payload-contracts.md §Plan-010 verbatim: `ExecutionModeSelectRequest/Response`; `ExecutionRootPrepareRequest/Response` (incl. `baseRef?`, `reuseWorktreeId?`, `acknowledgeDirtyCandidate?` — D-010-8/D-010-15; no wire `runId` — run binding is gate-supplied service-side); `WorktreeReuseCheckRequest/Response` (singular candidate; `reason?` populated when not clean or not compatible); `EphemeralClonePrepareRequest/Response` (no TTL on the wire — D-010-2; response reports effective `cleanupPolicy` + `expiresAt`); `EphemeralCloneDisposeRequest/Response`; `WorktreeRetireRequest/Response` (`Extract`-typed `retired`); `WorktreeStatusReadRequest/Response` (provenance-bearing arrays).
  - **Tests:** parse-accept one fixture per shape; parse-reject an out-of-taxonomy `executionMode` on select; parse-reject a clone-prepare carrying a TTL-like extra key under strict parsing; assert select-response `executionRoot` optionality and clone-prepare-response `state` narrowing (`creating`/`ready` only); assert status-read worktree items require `createdBySessionId`.
  - **Spec coverage:** Spec-010 line 73 (select records the canonical mode), Spec-010 line 74 (prepare creates-or-binds the root; explicit reuse rides it), Spec-010 line 75 (reuse check reports branch, cleanliness, compatibility), Spec-010 line 76 (clone prepare reports root, lifecycle, cleanup policy), Spec-010 line 77 (explicit dispose interface), Spec-010 line 78 (retire records even with async deletion), Spec-010 line 79 (status read exposes records incl. provenance)
  - **Verifies invariant:** I-010-2 (contract half)
  - **Consumes:** branded ids + enums ← T1.1; `SessionIdSchema` ← Plan-001 (shipped); `RunId` ← Plan-004 Phase 1 `packages/contracts/src/runControl.ts` (type import for the status-read provenance field)
- **T1.3 — Four-table migration.**
  - **Files:** `packages/runtime-daemon/src/migrations/` next-ordinal migration file (CREATE), `packages/runtime-daemon/src/session/migration-runner.ts` (EXTEND — guarded-block seam)
  - Verbatim-SQL migration (Plan-009 migration-file convention) creating `worktrees`, `ephemeral_clones`, `branch_contexts`, `run_execution_contexts` + all indexes exactly as ratified in local-sqlite-schema.md (D-010-5), incl. the partial-unique `idx_worktrees_active_branch` and the clone sweep index `(state, expires_at)`.
  - **Tests:** migration applies on a fresh db and is idempotent under the runner's guard; the partial-unique index admits two rows on the same (mount, branch) when one is `retired` and rejects two live rows; the `branch_contexts` CHECK rejects a row carrying both `worktree_id` and `ephemeral_clone_id`; the `run_execution_contexts` CHECK likewise.
  - **Spec coverage:** Spec-010 line 85 (worktree records persist branch, mount, state, provenance), Spec-010 line 86 (per-run execution binding persisted), Spec-010 line 87 (branch context persisted polymorphically per writable mode)
  - **Verifies invariant:** I-010-2 (DDL half), I-010-3, I-010-4, I-010-5
  - **Consumes:** migration-runner guarded-block seam + `openDatabase` ← Plan-001 (shipped Tier 1); `repo_mounts`/`workspaces` referenced tables ← Plan-009 Phase 2 T2.1 migration (build order: Plan-009 Phase 2 first within Tier 6)
- **T1.4 — Contract↔DDL conformance tripwire.**
  - **Files:** `packages/runtime-daemon/src/git/__tests__/contract-ddl-conformance.test.ts` (CREATE)
  - Asserts the `WorktreeState`/`EphemeralCloneState`/cleanup-policy literal sets in `worktree.ts` equal the sets parsed out of the migration's CHECK clauses (string-extraction over the migration source — the Plan-009 conformance-test shape).
  - **Tests:** the assertion IS the test; plus a mutation canary (a deliberately-wrong fixture set fails).
  - **Spec coverage:** Spec-010 line 48 (state set lockstep between contract and persistence)
  - **Verifies invariant:** I-010-2
  - **Consumes:** enums ← T1.1; migration source ← T1.3

### Phase 2 — Daemon git services (worktrees, clones, execution roots)

**Goal.** The `git/` service layer: single-seam event emission, worktree create/reuse/retire with the ratified collision + hook-neutralization + base-ref policies, clone prepare/dispose/sweep with TTL bookkeeping, and the workspace-primitive-bracketed execution-root orchestrator.

**Preconditions.**

- [ ] Phase 1 merged
- [ ] Plan-009 Phase 2 merged (`WorkspaceService` primitives incl. `markBusy`/`releaseBusy` per CP-009-7; `repo_mounts`/`workspaces` rows)
- [ ] Plan-006 Phase 3 merged (`EventLogService.append` — sole append path; build-order precondition, same emitter pattern as Plan-009 Phase 2)
- [x] D-010-6/7/8/9/10/12/13 ratified (Tier-6 audit — placement, collision, base-ref, branch-bind-only, hooks, event mapping, sweep)

#### Tasks

- **T2.1 — `git/` directory + `worktree-event-emitter.ts` single emission seam.**
  - **Files:** `packages/runtime-daemon/src/git/worktree-event-emitter.ts` (CREATE), `packages/runtime-daemon/src/git/__tests__/worktree-event-emitter.test.ts` (CREATE)
  - One emission seam (Plan-009 emitter precedent): validates payloads through `RepoWorkspaceLifecyclePayloadSchema.parse()` at the boundary, maps transitions per D-010-12, appends via `EventLogService.append` (never computes integrity bytes). Exposes exactly five emit surfaces — there is no `emitFailed`.
  - **Tests:** each transition emits its mapped type exactly once; the payload carries `worktreeId` + `sessionId`; the `failed` transition path emits NOTHING (D-010-11 regression pin); a malformed payload throws at the seam.
  - **Spec coverage:** Spec-010 line 131 (failed and clone transitions deliberately not separately evented)
  - **Verifies invariant:** I-010-13
  - **Consumes:** `EventLogService.append(envelope)` ← Plan-006 Phase 3 T3.1; 5 type names + category mapping ← Plan-006 Phase 1 T1.2; `RepoWorkspaceLifecyclePayloadSchema` ← Plan-009 Phase 1 (via T1.1 import); union registration ← T1.1
- **T2.2 — `worktree-service.ts` + `worktree-errors.ts`: create / validateReuse / retire / cleanupPass.**
  - **Files:** `packages/runtime-daemon/src/git/worktree-service.ts` (CREATE), `packages/runtime-daemon/src/git/worktree-errors.ts` (CREATE), `packages/runtime-daemon/src/git/__tests__/worktree-service.test.ts` (CREATE)
  - `worktree-errors.ts` holds every Plan-010 typed error class (`worktree.*`, `clone.*`, and the three Plan-010-introduced `workspace.*` codes), each extending the BL-143 `DaemonDomainError` base (constructor-injected code strings from error-contracts.md; no filesystem paths in messages — sanitization discipline). The file lives in Plan-010-owned `git/`, preserving the cross-plan §2 two-file `workspace/` pin; Phase 3 imports these classes.
  - `worktree-service.ts`: `create({repoMountId, branchName, baseRef?, onCollision, sessionId, runId?})` — derive the default name per the Spec-010 line 126 slug rule when absent (exported `deriveWorktreeBranchName` helper — daemon-side only); resolve base per D-010-8 (mount HEAD; detached-HEAD + no `baseRef` → typed refusal); place the root per D-010-6; run `git worktree add` hook-neutralized per D-010-10; collision per D-010-7 (`refuse` → `worktree.branch_collision`; `suffix` → first-free ordinal via index-arbitrated insert-retry); row + `worktree.created`/`worktree.ready` via T2.1; creation failure → row `failed` (no event) + propagate for the caller's `failReprovision`. `validateReuse({reuseWorktreeId, branchName, acknowledgeDirtyCandidate?})` — the candidate must be live, branch-compatible, and clean-or-acknowledged (D-010-15), else `worktree.reuse_conflict`; incompatible never binds. `retire(worktreeId)` — refuse `worktree.retire_conflict` while the root is held busy; else state → `retired` + event (metadata preserved, I-010-9). `cleanupPass()` — detached-mount worktrees → retired (D-010-13c); async disk removal for retired-uncleaned rows stamping `cleaned_at` (D-010-13d, idempotent).
  - **Tests:** slug derivation table-driven (lowercase, collapse, trim, 40-char truncation, `run-<short-8>` fallback); supplied-name collision refuses; derived-name collision suffixes `-2` then `-3` deterministically and reports verbatim; dirty candidate without ack refuses, with ack binds; incompatible candidate refuses despite ack; retire-while-busy refuses; retire emits then cleanup stamps; provenance columns populated and preserved across retire.
  - **Spec coverage:** Spec-010 line 44 (create-or-reuse before execution), Spec-010 line 49 (explicit reuse preserves branch + provenance context), Spec-010 line 53 (naming pattern), Spec-010 line 56 (retirement preserves metadata with async cleanup), Spec-010 line 101 (explicit collision handling), Spec-010 line 126 (slug rule), Spec-010 line 127 (provenance-split collision policy), Spec-010 line 128 (base-ref policy)
  - **Verifies invariant:** I-010-3, I-010-4, I-010-6, I-010-8, I-010-9, I-010-10
  - **Consumes:** emitter ← T2.1; rows ← T1.3; `DaemonDomainError` base ← BL-143 (`packages/runtime-daemon/src/ipc/domain-error.ts` — Plan-007-owned; §Phase-3 Preconditions track it, Phase 2 needs only the class shape); error codes ← D-010-4
- **T2.3 — `ephemeral-clone-service.ts`: prepare / dispose / retireForWorkspace / cleanupTick.**
  - **Files:** `packages/runtime-daemon/src/git/ephemeral-clone-service.ts` (CREATE), `packages/runtime-daemon/src/git/__tests__/ephemeral-clone-service.test.ts` (CREATE)
  - Constructor config `{ttlMs = 86_400_000}` — TTL is daemon config, not wire (Spec-010 line 130). `prepare({workspaceId, branchName?, cleanupPolicy?})`: clone the mount's canonical root to the D-010-6 path (hook-neutralized, D-010-10), create the head branch (derived per the slug rule when absent), row with `expires_at = now + ttlMs`, report effective policy + expiry. `dispose(cloneId)`: explicit-disposal arm → retired (recorded-then-cleaned). `retireForWorkspace(workspaceId, trigger)`: the run-terminal `on_run_complete` path. `cleanupTick()`: D-010-13 (a)(b)(d) + the live-workspace → `provisioning` disposition via injected Plan-009 primitives.
  - **Tests:** prepare reports policy + expiry; a TTL-expired clone retires on tick; an archived-workspace clone retires; a live clone-mode workspace returns to `provisioning` on its root's retirement (never `stale`); dispose is idempotent; disk cleanup stamps `cleaned_at`; preparation failure → `clone.prepare_failed` + caller-visible for `failReprovision`.
  - **Spec coverage:** Spec-010 line 45 (clone provisions before writable execution), Spec-010 line 63 (clone-prep failure blocks in setup), Spec-010 line 68 (sweep retirement disposition incl. workspace return-to-provisioning), Spec-010 line 130 (TTL as daemon config)
  - **Verifies invariant:** I-010-9, I-010-10
  - **Consumes:** emitter — none (clone transitions unevented, D-010-11); rows ← T1.3; `beginReprovision` ← Plan-009 Phase 2 T2.4 (CP-010-2, injected); error classes ← T2.2 `worktree-errors.ts`
- **T2.4 — `workspace/execution-root-service.ts`: mode-dispatched orchestrator, sole `branch_contexts` writer.**
  - **Files:** `packages/runtime-daemon/src/workspace/execution-root-service.ts` (CREATE), `packages/runtime-daemon/src/workspace/__tests__/execution-root-service.test.ts` (CREATE)
  - `prepare({workspaceId, branchName?, baseRef?, reuseWorktreeId?, acknowledgeDirtyCandidate?, runId?, onCollision = 'refuse'})`: `assertWritable` first for writable modes (CP-010-3, I-010-12); dispatch on the workspace's selected mode — `read-only` resolves the bind root; `branch` verifies bind-only per D-010-9 (`workspace.branch_mismatch`); `worktree` delegates to T2.2 (create or explicit-reuse); `ephemeral clone` delegates to T2.3; write/preserve the `branch_contexts` row (sole writer — CP-010-6; explicit reuse preserves the candidate's row per D-010-15); bracket workspace state via CP-010-2 primitives (`beginReprovision` when `ready`; first-bind writable workspaces already sit `provisioning` — no double-begin; `completeReprovision(workspaceId, root)` on success; `failReprovision(workspaceId, detail)` on failure — no silent substitution).
  - **Tests:** mode-dispatch table; a stale workspace refuses before any git call; branch-mode mismatch refuses without mutating the checkout; success completes reprovision with the prepared root; failure fail-reprovisions and the workspace's `lastError` carries the detail; `branch_contexts` polymorphism per mode (worktree row / clone row / neither); no raw `workspaces` UPDATE anywhere in the service source (I-010-11 assertion).
  - **Spec coverage:** Spec-010 line 40 (exactly one canonical mode per run binding), Spec-010 line 43 (branch mode is an explicit writable override on the existing checkout), Spec-010 line 46 (no silent main-checkout fallback), Spec-010 line 62 (worktree-creation failure blocks in setup), Spec-010 line 67 (stale refusal), Spec-010 line 87 (branch context persisted per writable mode), Spec-010 line 129 (branch-mode bind-only verification)
  - **Verifies invariant:** I-010-5, I-010-6, I-010-7, I-010-11, I-010-12
  - **Consumes:** `assertWritable`/`beginReprovision`/`completeReprovision`/`failReprovision` ← Plan-009 Phase 2 T2.4 (CP-010-2/3); worktree ops ← T2.2; clone ops ← T2.3; rows ← T1.3
- **T2.5 — `worktree-projector.ts`: pure status-read projections.**
  - **Files:** `packages/runtime-daemon/src/git/worktree-projector.ts` (CREATE), `packages/runtime-daemon/src/git/__tests__/worktree-projector.test.ts` (CREATE)
  - Pure fold from `worktrees` + `ephemeral_clones` rows (session-scoped via `repo_mounts`) to the `WorktreeStatusReadResponse` shape — no IO beyond injected row reads, no derivation beyond projection (daemon-owned projections per Spec-010 line 88).
  - **Tests:** the projection fixture covers every state incl. `failed`/`retired` (never filtered — I-010-19's daemon half); provenance fields pass through; the `repoMountId` filter narrows.
  - **Spec coverage:** Spec-010 line 79 (status read exposes lifecycle + provenance), Spec-010 line 88 (daemon-owned dirty/merged projections)
  - **Verifies invariant:** I-010-20 (daemon half)
  - **Consumes:** rows ← T1.3; response schema ← T1.2
- **T2.6 — Acceptance suite on real git fixtures.**
  - **Files:** `packages/runtime-daemon/src/git/__tests__/worktree-lifecycle.acceptance.test.ts` (CREATE)
  - Real temp-dir git repos (no mocks): full worktree lifecycle create→dirty→merged→retire; hostile-repo sentinel hooks never fire (D-010-10); derived-name collision suffixes; explicit-reuse dirty/ack matrix; clone prepare→TTL-expire→tick→workspace-provisioning disposition; main-checkout content byte-identical before/after every failure path (I-010-6 ground truth).
  - **Tests:** the suite IS the tests (acceptance tier).
  - **Spec coverage:** Spec-010 line 108 (no hidden main-checkout mutation), Spec-010 line 114 (AC1 — writable run on git defaults to worktree mode at the service layer), Spec-010 line 116 (AC3 — creation failure blocks rather than mutating), Spec-010 line 117 (AC4 — reused worktrees stay linked to branch + prior context)
  - **Verifies invariant:** I-010-6, I-010-7, I-010-8, I-010-10
  - **Consumes:** services ← T2.2, T2.3, T2.4; real-git fixture pattern ← Plan-009 Phase 2 acceptance precedent

### Phase 3 — Mode selection, run-setup gate, IPC namespace + SDK

**Goal.** The selection service, the run-setup execution-root gate on the Plan-004 seam, seven `repo.*` binder files, and the typed `worktreeClient` SDK with registration/dispatch/error round-trip coverage.

**Preconditions.**

- [ ] Phases 1–2 merged
- [ ] Plan-004 Phase 3 merged (run-engine + the T3.10 `RunSetupGate` seam — Tier 5)
- [ ] BL-142 landed — registry regex conformance (camelCase tails: `repo.executionModeSelect`-class strings throw at boot without it)
- [ ] BL-143 landed — `DaemonDomainError` projection branch in `mapJsonRpcError` (T3.8's wire assertions observe anonymous `-32603` without it)
- [x] D-010-3 method strings ratified — api-payload-contracts.md §Repo Method-Name Registry (Tier 6)
- [x] D-010-4 error codes ratified — error-contracts.md (Tier-6 audit)

#### Tasks

- **T3.1 — `workspace/execution-mode-service.ts`: select + capability gate.**
  - **Files:** `packages/runtime-daemon/src/workspace/execution-mode-service.ts` (CREATE), `packages/runtime-daemon/src/workspace/__tests__/execution-mode-service.test.ts` (CREATE)
  - `select({workspaceId, executionMode})` per D-010-14: validate against the D-009-5 capability matrix (`workspace.mode_unsupported` refusal — no silent substitution); record the mode; `read-only` completes synchronously (root = bind root; response carries `executionRoot`); writable targets `beginReprovision` only (response `state: 'provisioning'`, no root); selecting on `stale` is the repair path (begin-from-stale allowed per the Plan-009 primitive contract).
  - **Tests:** per-mode select matrix incl. capability refusal; read-only synchronous completion; writable parks in provisioning with no root; the stale-repair path; no raw `workspaces` UPDATE (I-010-11 assertion).
  - **Spec coverage:** Spec-010 line 47 (no silent substitution at selection), Spec-010 line 61 (unsupported-worktree repos offer alternates distinctly — the capability projection IS the distinct marking), Spec-010 line 73 (selection records and transitions; materialization deferred)
  - **Verifies invariant:** I-010-7, I-010-11
  - **Consumes:** capability matrix projection ← Plan-009 Phase 2 (D-009-5); `beginReprovision`/`completeReprovision` ← Plan-009 (CP-010-2); error classes ← T2.2 `worktree-errors.ts`
- **T3.2 — Run-setup execution-root gate (`RunSetupGate` implementation).**
  - **Files:** `packages/runtime-daemon/src/workspace/execution-mode-service.ts` (EXTEND — the gate lands here; no third `workspace/` file per the cross-plan §2 two-file pin), `packages/runtime-daemon/src/workspace/__tests__/run-setup-gate.test.ts` (CREATE)
  - Implements D-010-16: `assertRunReady(context)` — non-repo runs (no `workspaceId`) pass through; repo-bound runs resolve the workspace, `markBusy` (CP-010-4; `workspace.busy` on a concurrent hold), materialize via T2.4 `prepare` with the gate-derived branch name (slug rule; `onCollision: 'suffix'`) and `runId` (populating `created_by_run_id` + the `run_execution_contexts` row); failure unwinds the busy mark and parks the run (`workspace.execution_root_unresolved` wrapping the typed cause). `onRunTerminal(context)` — `releaseBusy`, stamp `released_at`, `on_run_complete` clone retirement via T2.3 with the D-010-13 disposition. Registers on the Plan-004 T3.10 seam (CP-010-9).
  - **Tests:** non-repo pass-through; happy-path worktree run (root + context row + busy bracket + release on terminal); gate failure parks in `starting` with the typed cause and no busy leak; a concurrent second run on the same workspace refuses `workspace.busy`; the dirty-candidate explicit-reuse fixture surfaces `worktree.reuse_conflict`; an `on_run_complete` clone retires at terminal and the workspace returns to `provisioning`; the derived branch name matches the ratified rule (spy on the prepare call).
  - **Spec coverage:** Spec-010 line 40 (every repo-bound run binds exactly one canonical mode), Spec-010 line 41 (worktree default for repo-bound coding runs — the gate's derived-default path), Spec-010 line 54 (one dedicated worktree per active task), Spec-010 line 64 (blocked-in-setup parks in `starting`, interruptible), Spec-010 line 86 (per-run execution binding persisted), Spec-010 line 89 (busy for the run's duration; one holding run; typed refusal), Spec-010 line 94 (worktree created and bound before provider execution starts)
  - **Verifies invariant:** I-010-11, I-010-12, I-010-14
  - **Consumes:** `RunSetupGate` seam (`assertRunReady` + `onRunTerminal`) ← Plan-004 Phase 3 T3.10 (CP-010-9); `QueueItemCreateRequest.workspaceId?` ← Plan-004 Phase 1 T1.1 (api-payload §Plan-004); `markBusy`/`releaseBusy` ← Plan-009 Phase 2 T2.4 (CP-010-4); root prepare ← T2.4; clone retirement ← T2.3; `RunId` ← Plan-004 Phase 1
- **T3.3 — Mutation binder files (select, prepare, clone-prepare, clone-dispose).**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/repo-execution-mode-select.ts`, `packages/runtime-daemon/src/ipc/handlers/repo-execution-root-prepare.ts`, `packages/runtime-daemon/src/ipc/handlers/repo-ephemeral-clone-prepare.ts`, `packages/runtime-daemon/src/ipc/handlers/repo-ephemeral-clone-dispose.ts` (CREATE ×4), `packages/runtime-daemon/src/ipc/handlers/index.ts` (EXTEND — barrel)
  - One file per method (NS-26 binder convention; `register<X>` + `<X>Deps` deps-closure): each registers its D-010-3 string with `{mutating: true}`, request/response schemas from Phase 1, domain callback into T3.1/T2.4/T2.3.
  - **Tests:** covered by T3.6.
  - **Spec coverage:** Spec-010 line 73 (select wire surface), Spec-010 line 74 (prepare wire surface), Spec-010 line 76 (clone-prepare wire surface), Spec-010 line 77 (dispose wire surface)
  - **Verifies invariant:** I-010-15
  - **Consumes:** `MethodRegistry` + `registry.register` ← Plan-007-partial (shipped Tier 1); schemas ← T1.2; services ← T2.3, T2.4, T3.1; method strings ← D-010-3; camelCase registration ← BL-142 (§Preconditions)
- **T3.4 — Query/lifecycle binder files (reuse-check, retire, status-read).**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/repo-worktree-reuse-check.ts`, `packages/runtime-daemon/src/ipc/handlers/repo-worktree-retire.ts`, `packages/runtime-daemon/src/ipc/handlers/repo-worktree-status-read.ts` (CREATE ×3), `packages/runtime-daemon/src/ipc/handlers/index.ts` (EXTEND)
  - Reuse-check and status-read register `{mutating: false}`; retire registers `{mutating: true}`. Status-read serves T2.5's projection.
  - **Tests:** covered by T3.6.
  - **Spec coverage:** Spec-010 line 75 (reuse-check wire surface), Spec-010 line 78 (retire wire surface), Spec-010 line 79 (status-read wire surface)
  - **Verifies invariant:** I-010-15
  - **Consumes:** as T3.3; projection ← T2.5; reuse validation ← T2.2
- **T3.5 — `worktreeClient.ts` typed SDK.**
  - **Files:** `packages/client-sdk/src/worktreeClient.ts` (CREATE), `packages/client-sdk/src/index.ts` (EXTEND)
  - `createDaemonWorktreeClient(transport)` factory (the Plan-009/NS-33 `createDaemonRepoClient` precedent): seven methods mapping 1:1 to D-010-3 strings, schema-validating requests before send and responses on receipt; no derivation, no retry-with-substitution.
  - **Tests:** covered by T3.7.
  - **Spec coverage:** Spec-010 line 80 (typed request/response schemas are the contract surface)
  - **Verifies invariant:** I-010-16
  - **Consumes:** `JsonRpcClient` transport ← Plan-007-partial SDK substrate (shipped); schemas ← T1.2; strings ← D-010-3
- **T3.6 — Registration + dispatch tests for the seven binders.**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/__tests__/worktree-handlers.test.ts` (CREATE)
  - Per-method: registers under the exact D-010-3 string; a request-schema violation rejects with the substrate validation error BEFORE the domain callback (spy-asserted); the response validates; mutating flags correct (5 true / 2 false); barrel exports complete.
  - **Tests:** the file IS the tests.
  - **Spec coverage:** Spec-010 line 80 (wire surface conforms to the ratified schemas)
  - **Verifies invariant:** I-010-15
  - **Consumes:** binders ← T3.3, T3.4; registry test harness ← Plan-007-partial precedent
- **T3.7 — SDK integration tests.**
  - **Files:** `packages/client-sdk/test/worktreeClient.integration.test.ts` (CREATE)
  - In-process daemon registry + real transport (NS-33 precedent): seven happy-path round-trips with branded-type preservation; a select→prepare worktree flow yields a root and a status-read row carrying provenance.
  - **Tests:** the file IS the tests.
  - **Spec coverage:** Spec-010 line 115 (AC2 — the contract distinguishes all four modes over the wire), Spec-010 line 117 (AC4 — reuse linkage observable via status read)
  - **Verifies invariant:** I-010-16
  - **Consumes:** SDK ← T3.5; binders ← T3.3, T3.4; services ← Phase 2
- **T3.8 — Typed error round-trips for the spec-named failure modes.**
  - **Files:** `packages/runtime-daemon/src/ipc/handlers/__tests__/worktree-handlers.test.ts` (EXTEND), `packages/client-sdk/test/worktreeClient.integration.test.ts` (EXTEND)
  - Wire-asserts the D-010-4 codes end-to-end: `worktree.branch_collision` (supplied-name collision), `worktree.reuse_conflict` (dirty-no-ack), `workspace.branch_mismatch` (branch-mode mismatch), `workspace.busy` (concurrent hold), `workspace.stale` (stale prepare refusal), `workspace.mode_unsupported` (capability refusal), `clone.prepare_failed`. Asserts no path echo in any error message (sanitization).
  - **Tests:** the file extensions ARE the tests.
  - **Spec coverage:** Spec-010 line 47 (substitution refusal is typed and observable), Spec-010 line 65 (dirty/incompatible requires explicit choice — refusal observable), Spec-010 line 67 (stale refusal observable), Spec-010 line 116 (AC3 — creation failure blocks with a typed error, never a mutation)
  - **Verifies invariant:** I-010-7, I-010-8, I-010-15
  - **Consumes:** `mapJsonRpcError` + `DaemonDomainError` projection ← BL-143 (§Preconditions — tracked-not-satisfied until the Plan-007-owned PR lands); error classes ← T2.2 `worktree-errors.ts`; codes ← D-010-4

### Phase 4 — Desktop execution-mode picker + worktree status UI

**Goal.** The `execution-mode-picker/` renderer subtree: explicit one-mutation mode switching, worktree/clone status with provenance, and the explicit reuse probe — all bridge-only projections with mock-bridge test coverage now (Plan-002 P6 harness) and the Tier-8 manual leg dispositioned.

**Preconditions.**

- [ ] Phase 3 merged
- [x] Plan-023-partial renderer substrate + bridge stub shipped (Tier 1); Plan-002 Phase 6 jsdom harness shipped (test-now posture)
- [x] D-010-17 status-read + `lastError` carriers ratified (Tier-6 audit)

#### Tasks

- **T4.1 — `ExecutionModePicker.tsx` + `ModeSwitchOptions.tsx`.**
  - **Files:** `apps/desktop/src/renderer/src/execution-mode-picker/ExecutionModePicker.tsx` (CREATE), `apps/desktop/src/renderer/src/execution-mode-picker/ModeSwitchOptions.tsx` (CREATE)
  - `ModeSwitchOptions` is presentational + bridge-free (D-010-18): renders `availableModes` / `restrictions` / current mode verbatim incl. the space-containing `"ephemeral clone"` token. `ExecutionModePicker` composes it: a capabilities read (`loading | loaded | error`) feeds the options; an explicit click fires exactly ONE `repo.executionModeSelect` (`idle | pending | resolved | rejected`) and renders the response verbatim (`state: 'provisioning'` renders as provisioning — the picker never sequences a prepare, I-010-17/D-010-14); the rejected branch surfaces the typed code verbatim.
  - **Tests:** covered by T4.4.
  - **Spec coverage:** Spec-010 line 73 (one selection mutation per explicit switch), Spec-010 line 47 (unavailable modes render as restrictions, never silently substituted)
  - **Verifies invariant:** I-010-17, I-010-18, I-010-20
  - **Consumes:** `repo.executionModeCapabilitiesRead` ← Plan-009 Phase 3 (D-009-1); `repo.executionModeSelect` ← Phase 3 (D-010-3); `ExecutionModeSelectRequest`/`Response` + `ExecutionMode` ← Phase 1; `window.sidekicks.daemon.call` ← Plan-023-partial (shipped stub; live ← Tier 8 per CP-010-10)
- **T4.2 — `WorktreeStatusView.tsx`.**
  - **Files:** `apps/desktop/src/renderer/src/execution-mode-picker/WorktreeStatusView.tsx` (CREATE)
  - Snapshot-read `repo.worktreeStatusRead` (`loading | loaded | error` — the NodeRoster posture precedent) rendering EVERY worktree + clone row verbatim: state, branch, provenance (`createdBySessionId`, `createdByRunId`), clone policy + `expiresAt` (no client expiry math — I-010-20); `failed`/`retired` rows render labeled, never filtered (I-010-19). The stale owning-workspace context renders the write-blocked label with `lastError` when `repo.workspaceList` carries it (D-010-17). Subscribes to the `workspace.*` + five `worktree.*` daemon events as OPAQUE re-read signals (payload never decoded — the Plan-009 WorkspaceListView precedent); V1 accepts no push signal for TTL retirement (freshness rides re-reads, D-010-11 disposition).
  - **Tests:** covered by T4.4.
  - **Spec coverage:** Spec-010 line 79 (status surface exposes records, lifecycle, provenance), Spec-010 line 110 (provenance survives retirement — rendered for retired rows), Spec-010 line 88 (daemon-owned projections rendered verbatim)
  - **Verifies invariant:** I-010-19, I-010-20
  - **Consumes:** `repo.worktreeStatusRead` ← Phase 3 (D-010-3); `WorktreeStatusReadRequest`/`Response` ← Phase 1; `repo.workspaceList` (+`lastError?`) ← Plan-009 Phase 3 + Phase 1 T1.3 (D-010-17); `daemon.subscribe` + `Unsubscribe` ← Plan-023-partial (shipped stub)
- **T4.3 — `WorktreeReuseCheckView.tsx` + barrel.**
  - **Files:** `apps/desktop/src/renderer/src/execution-mode-picker/WorktreeReuseCheckView.tsx` (CREATE), `apps/desktop/src/renderer/src/execution-mode-picker/index.ts` (CREATE — barrels the three views; App-shell composition is Plan-023's per CP-010-10)
  - Probe view: explicit branch-name input → `repo.worktreeReuseCheck` → renders the singular candidate verdict verbatim (`isClean`, `compatible`, `reason`); NO auto-proceed — the view surfaces the verdict; the explicit reuse decision (naming + dirty acknowledgement) belongs to the caller flow (I-010-17; the view never fires prepare).
  - **Tests:** covered by T4.4.
  - **Spec coverage:** Spec-010 line 75 (reuse check reports branch, cleanliness, compatibility), Spec-010 line 65 (dirty/incompatible surfaces for explicit user choice), Spec-010 line 109 (no implicit-reuse magic)
  - **Verifies invariant:** I-010-17, I-010-20
  - **Consumes:** `repo.worktreeReuseCheck` ← Phase 3 (D-010-3); schemas ← Phase 1; bridge ← Plan-023-partial (CP-010-10)
- **T4.4 — Mock-bridge component test suites.**
  - **Files:** `apps/desktop/src/renderer/src/execution-mode-picker/__tests__/ExecutionModePicker.test.tsx`, `apps/desktop/src/renderer/src/execution-mode-picker/__tests__/WorktreeStatusView.test.tsx`, `apps/desktop/src/renderer/src/execution-mode-picker/__tests__/WorktreeReuseCheckView.test.tsx` (CREATE ×3)
  - Per-suite mock `window.sidekicks` bridge (Plan-002 P6 / Plan-009 Phase 4 precedent): the picker fires exactly one select per click + renders provisioning verbatim + restriction-disabled options; the status view renders the all-states fixture incl. failed/retired + `lastError` labeling + re-read on event signal; the reuse view renders dirty/incompatible verdicts + never auto-fires prepare; every rejected branch surfaces the typed code.
  - **Tests:** the suites ARE the tests.
  - **Spec coverage:** Spec-010 line 115 (AC2 — all four modes distinguished in the rendered contract), Spec-010 line 117 (AC4 — reuse linkage rendered from daemon truth)
  - **Verifies invariant:** I-010-17, I-010-18, I-010-19, I-010-20
  - **Consumes:** views ← T4.1, T4.2, T4.3; jsdom workspace config ← Plan-002 Phase 6 (shipped)
- **T4.5 — Tier-8 manual-verification disposition record.**
  - **Files:** this plan §Test And Verification Plan (the manual row below)
  - The "manual verification of worktree lifecycle from create through retire" row is executable only when Plan-023 Tier 8 wires the live bridge; per the Plan-003 T5.4 / Plan-009 T4.5 precedent the row is dispositioned NOW (deferred-to-Tier-8, tracked on the Plan-023 remainder) rather than silently skipped.
  - **Tests:** n/a (disposition record).
  - **Spec coverage:** Spec-010 AC1 (line 114 — end-to-end leg is the Tier-8 manual scope)
  - **Verifies invariant:** none (disposition record — the manual end-to-end leg executes at Plan-023 Tier 8)
  - **Consumes:** live `window.sidekicks` backend ← Plan-023 Tier 8 remainder (tracked-not-satisfied — CP-010-10)

## Parallelization Notes

- Phase 1 contract work and Phase 2 git-service scaffolding can proceed together once the D-010-2/D-010-5 shapes are fixed (they are — this audit).
- T2.2 / T2.3 are independent after T2.1; T2.4 integrates both.
- Phase 4 starts after T2.5's projection + T3.4's status-read binder are stable.

## Test And Verification Plan

- Execution-mode selection tests across read-only, branch, worktree, and ephemeral clone (T3.1)
- Worktree create / reuse / collision / retirement tests (T2.2, T2.6)
- Ephemeral clone prepare / TTL / sweep / disposition tests (T2.3)
- Failure-path tests proving no silent main-checkout mutation (T2.6 byte-identity)
- Tests proving execution-root preparation runs no setup scripts and no repository hooks (T2.6 sentinel fixtures)
- Run-setup gate tests: blocked-in-setup parking, busy bracketing, terminal release (T3.2)
- Wire + SDK round-trips incl. typed error codes (T3.6–T3.8)
- Renderer mock-bridge suites (T4.4)
- Manual verification of the full lifecycle — Tier-8 leg, dispositioned per T4.5

## Rollout Order

1. Ship worktree persistence and daemon services (Phases 1–2)
2. Enforce canonical execution-mode resolution in repo-bound run setup (Phase 3)
3. Enable desktop execution-mode controls (Phase 4)

## Rollback Or Fallback

- Disable automatic worktree creation (deregister the run-setup gate) and require explicit branch or read-only mode if rollout blocks too much valid work; the seam-registration design makes the gate removable without touching Plan-004's engine.

## Risks And Blockers

- Branch naming collisions — mitigated by D-010-7 (provenance-split policy + index-arbitrated retry)
- Git edge cases on repos with unusual worktree support — surface as typed `worktree.create_failed`, never substitution (I-010-7)
- Ephemeral clone cleanup may leak disk usage — mitigated by D-010-13 (TTL sweep + `cleaned_at` idempotent stamping); residual risk: daemon down past TTL windows
- Repositories with mandatory bootstrap steps need explicit follow-on setup flows (Spec-010 line 69) — out of scope here by design
- BL-142 / BL-143 are Plan-007-owned Phase-3 preconditions; if they slip, Phases 1–2 still land

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

- 2026-06-10 — Tier-6 plan-readiness audit (NS-18): plan rewritten to the audited four-phase Tasks structure; 67 findings adjudicated (17 critical / 38 major / 11 minor / 1 nit) across 24 cross-phase adjudications; wire block, DDL, error vocabulary, method registry, and the Plan-004/Plan-009/Spec-009/Spec-010 reciprocal amendments ratified in the same audit PR.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
