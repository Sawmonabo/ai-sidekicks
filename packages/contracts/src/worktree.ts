// Worktree and ephemeral-clone contracts — the branded `WorktreeId` /
// `EphemeralCloneId` / `BranchContextId` scalars, the worktree/clone lifecycle
// enums, the clone cleanup-policy vocabulary, and the Plan-010 instantiation
// of the Plan-009 family lifecycle event payload, for Plan-010 (Worktree
// Lifecycle And Execution Modes; this file is the plan's contract domain per
// D-010-1). Exact enum membership mirrors the canonical shapes in
// `docs/architecture/contracts/api-payload-contracts.md §Shared Enums` and
// `docs/architecture/contracts/api-payload-contracts.md §Plan-010 — Worktree Lifecycle And Execution Modes`
// and the `CHECK` constraints in
// `docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`
// (verbatim — adding/removing/renaming a member here is a contract break and
// requires the spec edit first). Contract↔DDL lockstep is I-010-2, pinned by
// the T1.4 conformance test against the migration's `CHECK` clauses.
//
// CANONICAL CONSUMER (CP-010-1, the reciprocal of Plan-009 CP-009-1).
// Plan-009's repo.ts owns `ExecutionMode`, `WorkspaceState`, `RepoMountState`,
// the branded `RepoMountId` / `WorkspaceId`, and the family payload factory
// `buildRepoWorkspaceLifecyclePayloadSchema` — this module IMPORTS them and
// never redefines (I-010-1). Only the symbols this contract core composes are
// imported below; the remaining Plan-009 canon arrives with T1.2's seven wire
// request/response pairs. The reciprocal boundary: `WorktreeId`,
// `WorktreeState`, `EphemeralCloneId`, `BranchContextId`,
// `EphemeralCloneState`, and the clone cleanup-policy vocabulary (schema
// only — see its own note below) are declared HERE and nowhere else. repo.ts
// deliberately leaves its family payload's `worktreeId?` an unbranded
// canonical-UUID string so this file's brand needs no repo.ts edit
// (PR #250 round 4).
//
// IMPORT DIRECTION IS ONE-WAY — this module imports NOTHING from `./event.js`,
// and nothing whose import CLOSURE reaches it, however many hops out (the
// transitive rule repo.ts's header documents; the `node-id.js` hoist is the
// precedent). `event.ts` imports `WorktreeLifecyclePayloadSchema` from here to
// register the five `worktree.*` variants into `SessionEventSchema`
// (CP-010-5), so a back-import would close an eager module-scope Zod cycle
// that throws `ReferenceError` at import time and that `tsc` does not flag.
// Before composing any new cross-module symbol below, check its closure the
// same way.
//
// Refs: Spec-010 (Worktree Lifecycle And Execution Modes), Spec-006 §Repo,
// Workspace, and Worktree Lifecycle (session_lifecycle) (the shared payload
// shape), ADR-006 (worktree-first execution mode), ADR-018 (versioning),
// ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  type RepoWorkspaceLifecyclePayloadOf,
} from "./repo.js";

// --------------------------------------------------------------------------
// ExecutionMode — Plan-009 canon, re-exported (type AND schema value).
// --------------------------------------------------------------------------
//
// `Spec-010 §Acceptance Criteria` requires the execution-mode contract this
// domain builds on to distinguish `read-only` / `branch` / `worktree` /
// `ephemeral clone`. That four-member taxonomy is Plan-009 canon, so it is
// satisfied by IMPORT, never redefinition (I-010-1 / CP-010-1) — re-exported
// here so the taxonomy is reachable through this module's own surface, the
// same cross-module composition channels.ts / memberships.ts / presence.ts
// use for session.ts's ids and runtime-node.ts uses for `NodeId`. Both this
// module and repo.ts are star-exported by index.ts; a re-export that resolves
// to the SAME declaration is not an ambiguous duplicate (the four-way
// `SessionIdSchema` path through those three modules is the standing proof).
//
// TWO STATEMENTS, the shape all four of those siblings use: the type-only
// half MUST spell `export type { ... }` (the `isolatedModules` +
// `verbatimModuleSyntax` posture from tsconfig.base.json forbids erased
// re-exports on the runtime form), and the value half re-exports the
// canonical binding rather than declaring a new one, so no explicit type
// annotation applies (TS9010 governs declarations, not re-exports) and no
// module edge is added — this file already imports repo.ts at runtime for the
// payload factory. T1.2 consumes the VALUE: both `ExecutionModeSelectRequest`
// and `ExecutionModeSelectResponse` in
// `docs/architecture/contracts/api-payload-contracts.md §Plan-010 — Worktree Lifecycle And Execution Modes`
// type `executionMode: ExecutionMode`, so those Zod pairs need the schema and
// not merely the type. `__tests__/worktree.test.ts` pins the four-member set
// three ways: compile-time exhaustiveness over the re-exported type, runtime
// `.options` equality, and object identity against repo.ts's declaration (the
// check a forked redefinition here would fail).
export type { ExecutionMode } from "./repo.js";
export { ExecutionModeSchema } from "./repo.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Daemon-minted UUID primary keys (`worktrees.id`, `ephemeral_clones.id`,
// `branch_contexts.id` — Plan-010 D-010-5), so all three compose the
// `brandedUuidIdSchema` helper from `./internal/branded.js`, the same idiom as
// `RepoMountIdSchema` / `WorkspaceIdSchema` in repo.ts: the double-T
// `z.ZodType<T, T>` bridges Zod's single-T `$ZodBranded` output to the shape
// tRPC v11's Standard-Schema-V1 input inference needs per ADR-014, and the
// explicit annotation is what `--isolatedDeclarations` requires (TS9010).

// Canonical origin of the `WorktreeId` brand
// (`docs/architecture/contracts/api-payload-contracts.md §Branded ID Types`).
// The family payload's `worktreeId?` field in repo.ts stays an unbranded
// canonical-UUID string with an IDENTICAL runtime accept set (both parse
// `z.string().uuid()`) — the brand applies where consumers parse through this
// schema, so declaring it here required no repo.ts edit (PR #250 round 4).
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
export const WorktreeIdSchema: z.ZodType<WorktreeId, WorktreeId> =
  brandedUuidIdSchema<WorktreeId>("WorktreeId");

// Declared in-block in the ratified §Plan-010 contract rather than under
// §Branded ID Types — D-010-2's cite-stability choice:
// `docs/architecture/contracts/api-payload-contracts.md §Plan-010 — Worktree Lifecycle And Execution Modes`.
export type EphemeralCloneId = string & { readonly __brand: "EphemeralCloneId" };
export const EphemeralCloneIdSchema: z.ZodType<EphemeralCloneId, EphemeralCloneId> =
  brandedUuidIdSchema<EphemeralCloneId>("EphemeralCloneId");

// The polymorphic branch-context carrier row's id (`branch_contexts`,
// workspace-anchored per D-010-5). Plan-010 creates the brand and table;
// Plan-011 extends the row for PR/diff attribution — CP-010-6 provides both
// forward, so this brand is cross-plan surface from the day it lands.
export type BranchContextId = string & { readonly __brand: "BranchContextId" };
export const BranchContextIdSchema: z.ZodType<BranchContextId, BranchContextId> =
  brandedUuidIdSchema<BranchContextId>("BranchContextId");

// --------------------------------------------------------------------------
// Canonical enums
// --------------------------------------------------------------------------
//
// TWO LEVELS — do not conflate them. On the WIRE, membership of each set is
// the whole contract and declaration order is not: RFC 8785 JCS serializes
// the literal string, so a reorder breaks no consumer and is no version
// event, while additions are MINOR and removals MAJOR per ADR-018
// §Decision #8 (the same stance as repo.ts's enums). In-repo, order is ALSO
// pinned: the declaration order below mirrors the ratified `CHECK` clauses in
// `docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`
// byte-for-byte, so I-010-2's contract↔DDL lockstep hands the T1.4
// conformance test an ORDERED target to compare the migration's extracted
// `CHECK` clauses against, and `__tests__/worktree.test.ts` asserts these
// three enums unsorted. A reorder here is therefore a suite failure plus a
// required T1.4 re-sync, never a wire break.

// The 6-value worktree lifecycle (`Spec-010 §Required Behavior`;
// `docs/architecture/contracts/api-payload-contracts.md §Shared Enums`;
// `worktrees.state` CHECK). `retired` and `failed` are the two non-live
// positions — the active-branch partial-unique index filters
// `WHERE state NOT IN ('retired', 'failed')` (I-010-4), git-faithfully: a
// `merged` checkout still holds its branch, while a `failed` creation never
// materialized one (D-010-5).
//
// SIX STATES, FIVE EVENTS. Each transition maps to its `worktree.*` event per
// D-010-12 (row creation → `worktree.created`; `creating -> ready` →
// `worktree.ready`; `-> dirty` / `-> merged` / `-> retired` likewise) EXCEPT
// `-> failed`, which deliberately emits none — the failure incident is
// already evented as `workspace.stale` by the coupled `failReprovision`
// (I-010-13), and the Spec-006 registry stays closed (D-010-11; no
// `worktree.failed` row exists to emit). Failed rows remain queryable via
// `repo.worktreeStatusRead`.
export type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
export const WorktreeStateSchema: z.ZodType<WorktreeState> = z.enum([
  "creating",
  "ready",
  "dirty",
  "merged",
  "retired",
  "failed",
]);

// The 4-value ephemeral-clone lifecycle
// (`docs/architecture/contracts/api-payload-contracts.md §Plan-010 — Worktree Lifecycle And Execution Modes`,
// in-block per D-010-2; `ephemeral_clones.state` CHECK). Deliberately NO
// `dirty` / `merged` members: a clone is a disposable per-task root retired
// by TTL expiry (`expires_at`), owning-workspace archival, run completion, or
// explicit dispose (D-010-13) — merge-back and dirtiness tracking are the
// worktree vocabulary's concern. Clone transitions emit NO session events
// (D-010-11).
export type EphemeralCloneState = "creating" | "ready" | "retired" | "failed";
export const EphemeralCloneStateSchema: z.ZodType<EphemeralCloneState> = z.enum([
  "creating",
  "ready",
  "retired",
  "failed",
]);

// When a prepared ephemeral clone is retired (`ephemeral_clones.cleanup_policy`
// CHECK; the wire spelling is the snake_case row literal, verbatim — NOT
// camelCase): `on_run_complete` retires the clone when its owning run reaches
// a terminal state (the run-setup gate's `onRunTerminal` release path,
// D-010-16); `manual` waits for an explicit `repo.ephemeralCloneDispose`. The
// TTL sweep over `expires_at` is the backstop for both (D-010-13), and
// clone-prepare responses report the EFFECTIVE policy applied (D-010-2).
//
// NO PAIRED `export type CleanupPolicy`, deliberately, and it is the one
// place this file departs from repo.ts's type+schema pairing. The ratified
// §Plan-010 block NAMES `EphemeralCloneState` and both brands but spells this
// union inline at all three of its use sites
// (`EphemeralClonePrepareRequest.cleanupPolicy?`,
// `EphemeralClonePrepareResponse.cleanupPolicy`, and the status read's clone
// records). Minting a name the ratified contract does not carry would
// pre-commit every downstream importer to a symbol with no doc-first
// backing — so the annotation carries the literal union directly, T1.2's
// wire pairs spell it exactly as ratified, and a named alias stays a purely
// additive one-liner if a later task earns one.
export const CleanupPolicySchema: z.ZodType<"on_run_complete" | "manual"> = z.enum([
  "on_run_complete",
  "manual",
]);

// --------------------------------------------------------------------------
// WorktreeLifecyclePayload — the Plan-010 instantiation of the family payload.
// --------------------------------------------------------------------------
//
// `EventEnvelope.payload` for the five `worktree.*` members of
// `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
// (`worktree.created` / `worktree.ready` / `worktree.dirty` /
// `worktree.merged` / `worktree.retired`), registered into
// `SessionEventSchema` by event.ts per CP-010-5. The shape is Plan-009's
// family payload `{sessionId, repoMountId?, workspaceId?, worktreeId?, state,
// actor?}` instantiated over THIS plan's state vocabulary via the exported
// factory — NOT `.extend()` (the factory's erased `z.ZodType` return admits
// none, by design), NOT a redefinition (I-010-1), and NOT a third `state`
// union arm in repo.ts (refused in the factory's own doc comment: it would
// re-close the node-id.ts eager-cycle class and widen every family member's
// accept set at once). Parameterizing keeps each member's accept set exactly
// its owning plan's vocabulary — a worktree payload claiming `attached` or
// `provisioning`, or a workspace payload claiming `merged`, stays a parse
// error (PR #250 round 4).
//
// EMITTER'S OBLIGATION (Plan-010 Phase 2, D-010-12): `worktreeId` populated
// on every `worktree.*` emission. The family schema leaves it optional
// because subject-id presence is per-type emitter discipline enforced at the
// `.parse()` emission seam, not a family shape rule (a detach-cascade row
// legitimately carries several ids). It stays the unbranded canonical-UUID
// string the family declares; the runtime accept set already equals
// `WorktreeIdSchema`'s, and consumers narrow to the brand at their own parse
// boundaries.
//
// FIVE OF THE SIX STATES appear on the wire: `failed` is representable in
// this payload type, but no `worktree.*` event carries it in V1 because the
// `-> failed` transition emits no worktree event at all (I-010-13, D-010-11,
// D-010-12). Representability is deliberate — the state enum is the ROW
// vocabulary (I-010-2 lockstep), and the closed EVENT registry, not a
// narrowed payload arm, is what pins the no-failed-event decision (the T2.1
// regression test plus the union-rejection pin in
// `__tests__/worktree.test.ts`).
//
// Declared as a TYPE ALIAS, never an `interface` — event.ts's five variant
// interfaces narrow `EventEnvelope.payload` (`Record<string, unknown>`), and
// only an object type ALIAS carries the implicit index signature that
// narrowing needs (see `RepoWorkspaceLifecyclePayloadOf`'s doc comment).
export type WorktreeLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<WorktreeState>;
// Single-T `z.ZodType<T>`, `.strict()` via the factory — a non-input event
// payload constructed daemon-side and validated at the emission boundary with
// `.parse()`, never a tRPC request input (the same typing stance as
// `RepoWorkspaceLifecyclePayloadSchema` in repo.ts).
export const WorktreeLifecyclePayloadSchema: z.ZodType<WorktreeLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(WorktreeStateSchema);
