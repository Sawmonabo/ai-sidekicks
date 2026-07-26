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
// `buildRepoWorkspaceLifecyclePayloadSchema` — this module IMPORTS the ones it
// needs and never redefines ANY of them (I-010-1). `RepoMountState` is the one
// it does NOT need: no Plan-010 wire shape or payload carries a mount state.
// I-010-1 and CP-010-1 enumerated it until the PR #253 post-merge true-up
// struck it — residue from when the worktree payload reused the two-arm
// `RepoMountState` ∪ `WorkspaceState` union the round-4 factory amendment
// removed. The contract core composes the mode taxonomy and
// the factory; T1.2's seven wire pairs below add the remaining Plan-009 canon
// they need (`WorkspaceStateSchema`, the branded `RepoMountId` /
// `WorkspaceId`, the shared `REPO_PATH_MAX_LEN`, and `ExecutionModeSchema` as
// a LOCAL binding — the re-export just below declares no local name), plus
// Plan-001's `SessionIdSchema` / `wireFreeFormString` and the TYPE-ONLY
// `RunId` brand from Plan-005's provider-driver.ts (the status read's
// provenance field). The reciprocal boundary:
// `WorktreeId`,
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
// same way. T1.2's two NEW edges were checked and both clear it. `./session.js`
// (`SessionIdSchema`, `wireFreeFormString`) is closure-clean — repo.ts already
// imports it under this same rule. `./provider-driver.js` adds no RUNTIME edge
// whatsoever, because the `RunId` brand rides a top-level `import type`: under
// `verbatimModuleSyntax` that form is elided whole, while the inline
// `import { type RunId } from "./provider-driver.js"` spelling would leave an
// `import {} from …` side-effect edge behind. Do not "simplify" it back into
// the inline form.
//
// Refs: Spec-010 (Worktree Lifecycle And Execution Modes),
// `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)` (the
// shared payload shape), ADR-006 (worktree-first execution mode),
// ADR-018 (versioning), ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import type { RunId } from "./provider-driver.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  REPO_PATH_MAX_LEN,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountId,
  type RepoWorkspaceLifecyclePayloadOf,
  type WorkspaceId,
  type WorkspaceState,
} from "./repo.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

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
// to the SAME declaration is not an ambiguous duplicate (the THREE-way
// `SessionIdSchema` path — its session.ts declaration plus the channels.ts and
// presence.ts re-exports — is the standing proof; memberships.ts re-exports
// other session.ts-declared ids but not this one).
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
// narrowed payload arm, is what pins the no-failed-event decision. Only ONE
// of its two pins ships today: the union-rejection pin in
// `__tests__/worktree.test.ts`. The `-> failed` emits-nothing regression test
// belongs to Phase 2 T2.1 and lands with `worktree-event-emitter.ts`.
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

// ==========================================================================
// Wire surfaces — the seven `repo.*` request/response pairs (Plan-010 T1.2).
// ==========================================================================
//
// `repo.executionModeSelect` (mutation), `repo.executionRootPrepare`
// (mutation), `repo.worktreeReuseCheck` (query), `repo.ephemeralClonePrepare`
// (mutation), `repo.ephemeralCloneDispose` (mutation), `repo.worktreeRetire`
// (mutation), `repo.worktreeStatusRead` (query) — D-010-3's seven methods, in
// the ratified declaration order. They ride the SAME `repo.*` namespace as
// Plan-009's six rather than a new `worktree` root: the Tier-1 ratified
// namespace-root enumeration admits `repo`, and mounts, workspaces, worktrees,
// and clones are one repo aggregate (sibling symmetry —
// `repo.executionModeCapabilitiesRead` ↔ `repo.executionModeSelect`).
//
// Field sets are transcribed from
// `docs/architecture/contracts/api-payload-contracts.md §Plan-010 — Worktree Lifecycle And Execution Modes`
// (verbatim — adding/removing/renaming a field is a contract break and
// requires the doc edit first) and satisfy the seven
// `Spec-010 §Interfaces And Contracts` bullets, one per pair. Every shape
// composes the T1.1 brands and enums above, or Plan-009 canon by import,
// rather than re-spelling either (I-010-1 / CP-010-1) — which is also the
// contract half of I-010-2: the `state` fields carry the enum objects the
// T1.4 conformance test compares against the migration's `CHECK` clauses, so
// a literal union re-spelled here would sit outside that lockstep.
//
// TRANSPORT. Daemon JSON-RPC ONLY — worktrees and ephemeral clones are
// node-local filesystem state, so no control-plane tRPC sibling exists
// (`Plan-010 §API And Transport Changes`), and the seven names register under
// the Plan-007-partial `MethodRegistry` (CP-010-8; its BL-142 regex-conformance
// and BL-143 typed-error-projection preconditions are both resolved). I-010-15
// is what these shapes underwrite: every `repo.*` method validates its request
// schema and resolves EVERY verdict daemon-side — cleanliness, compatibility,
// and roots are daemon OUTPUTS on the response shapes below, never values an
// SDK or renderer computes and submits.
//
// BRANCH NAMING IS THE CARVE-OUT from that list, and it is the asymmetry these
// shapes most need read correctly. I-010-15's own wording is narrower than
// "output": the SDK never COMPUTES the naming. Daemon-DERIVED naming — the
// `Spec-010 §Resolved Questions and V1 Scope Decisions` slug rule and D-010-7's
// collision suffixing — is never client-computed and reaches a client only as
// output. A caller-SUPPLIED `branchName` is lawful on the way IN, and on
// `EphemeralClonePrepareRequest` it is REQUIRED (D-010-19); the execution-root
// prepare leaves it optional precisely because that is where the derivation
// path runs, and the reuse check takes one as its lookup KEY.
//
// TYPING — REQUESTS are double-T `z.ZodType<T, T>`, RESPONSES are single-T
// `z.ZodType<T>`. The split is Plan-009 T1.2's, grounded in how the substrate
// actually consumes them: `MethodRegistry.register` declares
// `paramsSchema: ZodType<P>` and `resultSchema: ZodType<R>` — both single-T
// slots — and the live `session.read` registration passes a double-T request
// alongside a single-T response into exactly those slots. Double-T satisfies
// the single-T slot for free (Zod 4 declares `ZodType<out Output, out Input>`),
// so the request side keeps the package-wide `*RequestSchema` idiom and its
// Standard-Schema-V1 input inference stays available to a later typed-SDK
// consumer per ADR-014, at no cost; a response is not an input surface and
// stays single-T, as every response schema in repo.ts / session.ts /
// runtime-node.ts is.
//
// TWO of the seven requests need the `as unknown as z.ZodType<T, T>` bridge,
// and the condition is structural rather than stylistic: a SINGLE-T member's
// `Input` slot is `unknown` (`$ZodTypeInternals` declares `Input` covariant),
// which poisons the composed object's inferred input.
// `ExecutionModeSelectRequestSchema` composes single-T `ExecutionModeSchema` —
// the identical mechanism that bridges `WorkspaceBindRequestSchema` in repo.ts,
// which composes the same schema — and `EphemeralClonePrepareRequestSchema`
// composes single-T `CleanupPolicySchema` from T1.1 above. The other five
// compose only double-T branded ids, `z.ZodString` (`wireFreeFormString`), and
// `z.ZodBoolean`, none of which contributes an `unknown` slot: the bridge-free
// condition `WorkspaceListRequestSchema` documents. Both bridges sit at the
// CONSUMPTION site rather than re-annotating a canonical declaration —
// `ExecutionModeSchema` is Plan-009's symbol (I-010-1), and re-annotating
// `CleanupPolicySchema` would re-type it for consumers that want the single-T
// form.
//
// NO CROSS-FIELD REFINEMENTS on any conditional field below — the reuse
// check's six optional fields (five describing the candidate, plus the
// `reason` that explains a negative verdict), the prepare response's three
// mode-discriminated ids, the select response's `executionRoot`, and the
// status read's `createdByRunId` / `cleanedAt`. All are plain-optional in the
// ratified block, and each conditional relationship is an EMITTER obligation
// discharged at the `.parse()` boundary of the Phase 2 / Phase 3 surface that
// produces it — the stance repo.ts's workspace half documents at length. Two
// of them the schema COULD NOT check even in principle: which root id a
// prepare response carries depends on the workspace's selected mode, and
// D-010-19's mode-conditional `branchName` requiredness on
// `ExecutionRootPrepareRequest` does too. Neither the mode nor the row is
// visible at parse time, which is exactly why that refusal is the typed
// service-side `workspace.branch_name_required` (400) raised before any git
// call, and not a parse error.

// Bound on the git ref names these surfaces carry — `branchName` (the head
// branch of a worktree or clone) and `baseRef` (the worktree base: a branch,
// tag, or commit-ish, D-010-8). ONE constant for both, because both carry a
// git ref name and two constants obliged to hold the same value with nothing
// enforcing the equality is the hazard `WorkspaceBindRequest.directory`
// declined when it reused `REPO_PATH_MAX_LEN`.
//
// 256 is this package's IDENTIFIER class (`NODE_ID_MAX_LEN`,
// `EVENT_FIELD_MAX_LEN`, `DRIVER_BINDING_ID_MAX_LEN`) and NOT the 4096
// filesystem-path class — the deliberate opposite of the generosity argument
// `WORKSPACE_LAST_ERROR_MAX_LEN` makes, so it needs the reason that defuses
// it. That argument says an under-sized cap can make a LAWFUL daemon RESPONSE
// unrepresentable, because responses are validated too. It does not reach
// here: every `branchName` that can appear on a Plan-010 response originated
// either at this same capped wire or from the daemon's own slug rule
// (`Spec-010 §Default Behavior`'s `sidekicks/<session-short-id>/<task-slug>`
// pattern, whose slug segment T2.2 truncates far below this bound), and
// `branch` mode writes no worktree or clone row at all — so no read surface
// can inherit a name this cap would refuse.
//
// ACCEPTED RESIDUAL: a PRE-EXISTING repository branch longer than 256
// characters cannot be probed through `repo.worktreeReuseCheck` or named as a
// `baseRef`. It fails LOUDLY at the wire rather than silently, and the refused
// set is pathological rather than merely long — git materializes a new ref as
// a loose file under `$GIT_DIR/refs/`, so every SLASH-SEPARATED SEGMENT of the
// name is already bounded by the 255-byte `NAME_MAX` the supported platforms'
// filesystems impose; only a many-segment name can exceed this cap in total.
//
// ONE PHASE-2 OBLIGATION, named here because this is where the ref bound is
// defined and the contract layer can discharge none of it. It falls on T2.2
// (`worktree-service.ts`), the only task that hands either ref to git:
//
//   1. OPTION INJECTION on `baseRef`. The field reaches `git worktree add` in
//      the POSITIONAL commit-ish slot, and D-010-8 gives it no pre-git
//      validation — the daemon resolves the mount's HEAD only when the field
//      is ABSENT, so a present value passes through as written. D-010-10
//      closes the two ADJACENT hazards and neither is this one: argv-only
//      `execFile` removes the shell, and the neutralized `core.hooksPath`
//      removes repository-controlled code, but git's own `parse_options` keeps
//      scanning for options AFTER a non-option argument, so a leading-dash
//      `baseRef` is consumed as an OPTION rather than as a commit-ish.
//      Discharge either by passing `--` before the positional refs, or by
//      refusing a leading-dash `baseRef` before any git call.
//
// That refusal deliberately does NOT live in this schema: a wire-level
// leading-dash rejection would be a contract change ahead of the ratified
// block, and which discharge to take is T2.2's call. `branchName` is
// UNAFFECTED under either — it rides `-b`'s value slot, which `parse_options`
// consumes as the argument to a known option rather than re-scanning.
export const WORKTREE_GIT_REF_MAX_LEN = 256;

// Bound on `WorktreeReuseCheckResponse.reason` — the daemon's explanation of
// why a candidate is not clean or not compatible, which is what
// `Spec-010 §Fallback Behavior`'s "must require explicit user choice" is
// shown against.
//
// 512 is the package's SHORT-HUMAN-REASON class
// (`EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN`,
// `RUNTIME_NODE_DETACH_REASON_MAX_LEN`, `INVITE_REVOKE_REASON_MAX_LEN`), and
// I-010-15 is why that is the right class: the daemon resolves the VERDICT, so
// this field carries a short authored summary ("candidate holds uncommitted
// changes"), never captured `git status` output. The 8192 captured-output
// class (`WORKSPACE_LAST_ERROR_MAX_LEN`) is the wrong neighbor — that field
// records a FAILURE detail with no authored form available, while this one
// records a routine verdict on a success-path read.
//
// MINTED rather than importing Plan-009's
// `EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN`, which holds the same 512:
// importing would assert an equality neither contract owes the other, the
// reasoning that keeps `WORKSPACE_LAST_ERROR_MAX_LEN` from importing
// `ERROR_MESSAGE_MAX_LEN`. `REPO_PATH_MAX_LEN` is imported and NOT restated
// for the opposite reason — it mirrors an external platform ceiling
// (`PATH_MAX`) that both plans read off the same fact, so one constant is the
// honest source rather than a coincidence of policy.
export const WORKTREE_REUSE_REASON_MAX_LEN = 512;

// --------------------------------------------------------------------------
// ExecutionModeSelect — `repo.executionModeSelect` (mutation).
// --------------------------------------------------------------------------
//
// SELECT RECORDS; PREPARE MATERIALIZES (D-010-14). This mutation records the
// canonical mode and transitions the workspace — `beginReprovision` for a
// writable target, synchronous completion for `read-only` — while per-task
// root materialization is `repo.executionRootPrepare`'s surface below. The
// split is architecturally forced rather than stylistic: worktree and clone
// roots are per-TASK, and a select carries no task context to name one for.
// `Spec-010 §Interfaces And Contracts` states the same boundary and adds the
// client rule I-010-17 carries — exactly one selection mutation per explicit
// switch, never a client-sequenced select-then-prepare chain.

export interface ExecutionModeSelectRequest {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
}
// The `as unknown as` bridge — single-T `ExecutionModeSchema` member; see the
// banner's typing note for the mechanism and for why the bridge belongs here
// rather than on Plan-009's declaration.
export const ExecutionModeSelectRequestSchema: z.ZodType<
  ExecutionModeSelectRequest,
  ExecutionModeSelectRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // The mode being switched TO — REQUIRED, and the full four-value taxonomy
    // reached by import (I-010-1), so `Spec-010 §Interfaces And Contracts`'s
    // "must distinguish `read-only`, `branch`, `worktree`, and
    // `ephemeral clone`" is satisfied by the canonical schema rather than a
    // re-spelling. No `.default()`, for both of the reasons
    // `WorkspaceBindRequest.executionMode` gives: a wire default would make
    // "caller omitted the mode" indistinguishable from "caller chose that
    // mode" on the one surface whose entire job is recording an EXPLICIT
    // switch, and `.default()` is a transform, so Input would stop equalling
    // Output and the double-T annotation would no longer be truthful.
    executionMode: ExecutionModeSchema,
  })
  .strict() as unknown as z.ZodType<ExecutionModeSelectRequest, ExecutionModeSelectRequest>;

export interface ExecutionModeSelectResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState;
  executionRoot?: string | undefined;
}
// Single-T — a response is not an input surface (see the banner's typing note).
export const ExecutionModeSelectResponseSchema: z.ZodType<ExecutionModeSelectResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Echoed back so the caller sees the mode the daemon actually RECORDED.
    // Load-bearing rather than cosmetic under I-010-7: an unavailable mode is
    // a typed `workspace.mode_unsupported` refusal, never a substituted mode
    // quietly reported here.
    executionMode: ExecutionModeSchema,
    // The post-select workspace position — `ready` when the select resolved
    // synchronously (`read-only`), `provisioning` while a writable root awaits
    // prepare. Composes the FULL 5-value `WorkspaceStateSchema` and is NOT
    // narrowed to those two literals: the ratified block types the field
    // `WorkspaceState` and glosses the two values in a comment, exactly as
    // `WorkspaceBindResponse.state` does. Contrast the three `Extract`-narrowed
    // `state` fields further down, where the ratified block narrows the TYPE
    // itself and the schema follows it.
    state: WorkspaceStateSchema,
    // PRESENT IFF RESOLVED SYNCHRONOUSLY (D-010-2). A `read-only` select
    // resolves the bind root immediately and populates this; a writable select
    // returns while the workspace sits `provisioning` and the root does not
    // exist yet. A REQUIRED field would force the daemon either to block the
    // select until provisioning finished or to answer with a placeholder root
    // — a guess, and I-010-7 admits no fallback root.
    executionRoot: wireFreeFormString(
      REPO_PATH_MAX_LEN,
      "ExecutionModeSelectResponse.executionRoot",
    ).optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// ExecutionRootPrepare — `repo.executionRootPrepare` (mutation).
// --------------------------------------------------------------------------
//
// Materializes (or binds) the execution root for the workspace's selected mode
// before a run enters `running` (`Spec-010 §Interfaces And Contracts`), and it
// is also the surface explicit worktree REUSE rides, by naming the candidate.
//
// NO WIRE `runId`, deliberately: run binding is gate-supplied service-side.
// The run-setup gate (D-010-16, registered on the Plan-004 T3.10 seam per
// CP-010-9) calls the service directly and supplies the run id that populates
// `worktrees.created_by_run_id` + the `run_execution_contexts` row, so a wire
// `runId` would let a caller forge run provenance on a row the gate owns.

export interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string | undefined;
  baseRef?: string | undefined;
  reuseWorktreeId?: WorktreeId | undefined;
  acknowledgeDirtyCandidate?: boolean | undefined;
}
// Bridge-free double-T: `WorkspaceIdSchema` / `WorktreeIdSchema` are double-T,
// `wireFreeFormString` is a `z.ZodString` (Input `string`), and `z.boolean()`
// is a `z.ZodBoolean` (Input `boolean`) — no single-T member, so nothing
// contributes an `unknown` input slot.
export const ExecutionRootPrepareRequestSchema: z.ZodType<
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // SCHEMA-OPTIONAL, SERVICE-CONDITIONAL (D-010-19) — the one field on these
    // seven pairs whose optionality does not mean "optional". A WRITABLE-mode
    // wire prepare is pre-run by definition and carries no slug-rule
    // derivation seed, so omitting the branch draws the typed
    // `workspace.branch_name_required` (400) refusal before any git call,
    // while a `read-only` prepare ignores the field entirely. That is
    // mode-conditional requiredness, and the mode lives on the `workspaces`
    // row — invisible at parse time — so it cannot be a refinement here
    // without the schema inventing state it does not have.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.branchName",
    ).optional(),
    // The worktree BASE (D-010-8). Omission means the mount's current HEAD
    // branch; an explicit value overrides. A detached-HEAD mount with no
    // explicit base is a typed refusal daemon-side, never a guess — which is
    // why the default is absent from the wire rather than spelled as a
    // `.default()`: the daemon reads HEAD, and the schema cannot.
    baseRef: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.baseRef",
    ).optional(),
    // EXPLICIT REUSE ONLY (I-010-8 / D-010-15): a worktree binds as a reuse
    // target only by being NAMED here. There is no "reuse if available" flag
    // and no implicit-reuse path anywhere in the plan, which is why this is an
    // id rather than a boolean.
    //
    // MOUNT CONSISTENCY is a T2.2 obligation rather than a shape one: the named
    // candidate's `worktrees.repo_mount_id` must equal the mount behind
    // `workspaceId`, or the prepare would bind an execution root inside a
    // DIFFERENT repository. Neither row is visible at parse time, so it rides
    // T2.2's `validateReuse` compatibility verdict. This covers the
    // hand-assembled request, not the normal one — the sanctioned discovery
    // path is mount-consistent by construction, since `WorktreeReuseCheckRequest`
    // is keyed on `repoMountId`.
    reuseWorktreeId: WorktreeIdSchema.optional(),
    // The SEPARATE consent that binds a DIRTY named candidate (D-010-15) —
    // separate because naming a candidate and accepting its dirty state are
    // two distinct acts, and the acknowledgement is TOCTOU-scoped: a candidate
    // that turned dirty after the reuse check refuses `worktree.reuse_conflict`
    // when the ack is absent. It never bypasses INCOMPATIBILITY; an
    // incompatible candidate never binds regardless.
    //
    // No `.default(false)`: absence already means "no consent", so a default
    // would add a transform (breaking the double-T Input=Output equality the
    // annotation asserts) to express what omission expresses already.
    acknowledgeDirtyCandidate: z.boolean().optional(),
  })
  .strict();

export interface ExecutionRootPrepareResponse {
  executionRoot: string;
  state: WorkspaceState;
  worktreeId?: WorktreeId | undefined;
  ephemeralCloneId?: EphemeralCloneId | undefined;
  branchContextId?: BranchContextId | undefined;
}
// Single-T — a response is not an input surface.
export const ExecutionRootPrepareResponseSchema: z.ZodType<ExecutionRootPrepareResponse> = z
  .object({
    // REQUIRED. Prepare either resolves a root or REFUSES with a typed error
    // (`worktree.create_failed` / `clone.prepare_failed` / the workspace
    // codes) — I-010-7 admits no substituted mode and no fallback root, so
    // there is no partial success carrying an unresolved root to represent.
    executionRoot: wireFreeFormString(
      REPO_PATH_MAX_LEN,
      "ExecutionRootPrepareResponse.executionRoot",
    ),
    // The workspace position after the CP-010-2 reprovision bracket
    // (`completeReprovision` on success). Full 5-value vocabulary, not
    // narrowed — the same stance as the select response above.
    state: WorkspaceStateSchema,
    // The three MODE-DISCRIMINATED ids: `worktreeId` for worktree mode,
    // `ephemeralCloneId` for ephemeral-clone mode, `branchContextId` for all
    // three writable modes (`Spec-010 §State And Data Implications`;
    // `read-only` carries none of them). Plain-optional per the ratified
    // block, with no refinement — which id set is lawful depends on the
    // workspace's selected mode, and the schema cannot see it. The
    // at-most-one rule that IS structural lives where it can be enforced: the
    // `branch_contexts` CHECK constraint (I-010-5, T1.3) and the
    // mode-conditional `run_execution_contexts` CHECK.
    worktreeId: WorktreeIdSchema.optional(),
    ephemeralCloneId: EphemeralCloneIdSchema.optional(),
    branchContextId: BranchContextIdSchema.optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// WorktreeReuseCheck — `repo.worktreeReuseCheck` (query).
// --------------------------------------------------------------------------
//
// SINGULAR CANDIDATE BY CONSTRUCTION, which is why the response describes ONE
// candidate rather than carrying a `candidates` array: the partial-unique
// active-branch index `idx_worktrees_active_branch` (T1.3) guarantees at most
// one live checkout per (mount, branch) — I-010-4 — so a list shape would be a
// wire promise the persistence model can never fill.
//
// `Spec-010 §Interfaces And Contracts` requires this surface to report branch,
// cleanliness, and compatibility; I-010-15 makes all three DAEMON verdicts,
// which is why they arrive as decided booleans and a rendered reason rather
// than as raw git state for a client to interpret.

export interface WorktreeReuseCheckRequest {
  repoMountId: RepoMountId;
  branchName: string;
}
// Bridge-free double-T (`RepoMountIdSchema` plus a `z.ZodString`).
export const WorktreeReuseCheckRequestSchema: z.ZodType<
  WorktreeReuseCheckRequest,
  WorktreeReuseCheckRequest
> = z
  .object({
    // MOUNT-scoped, not workspace-scoped: the uniqueness the check reads off
    // is keyed `(repo_mount_id, branch_name)`, and several workspaces on one
    // mount share those candidates.
    repoMountId: RepoMountIdSchema,
    // REQUIRED here, unlike the prepare request above — a reuse check with no
    // branch has no key to look a candidate up by, and D-010-19's derivation
    // seed argument does not apply to a pure read.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeReuseCheckRequest.branchName",
    ),
  })
  .strict();

export interface WorktreeReuseCheckResponse {
  available: boolean;
  worktreeId?: WorktreeId | undefined;
  state?: WorktreeState | undefined;
  branchName?: string | undefined;
  isClean?: boolean | undefined;
  compatible?: boolean | undefined;
  reason?: string | undefined;
}
// Single-T — a read projection, never an input surface.
export const WorktreeReuseCheckResponseSchema: z.ZodType<WorktreeReuseCheckResponse> = z
  .object({
    // The only REQUIRED field: true iff a live candidate exists. Everything
    // else describes that candidate, so `{ available: false }` alone is a
    // complete, well-formed answer — the negative case is not a degenerate
    // shape.
    available: z.boolean(),
    worktreeId: WorktreeIdSchema.optional(),
    // The candidate's lifecycle position, full six-value vocabulary. Not
    // narrowed to the live states even though `available: true` implies one:
    // the ratified block types it `WorktreeState`, and the narrowing would
    // encode a cross-field rule this schema deliberately does not make.
    state: WorktreeStateSchema.optional(),
    // The candidate's branch, echoed so the caller can see WHICH branch the
    // singular candidate holds (`Spec-010 §Interfaces And Contracts`: the
    // check reports branch).
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeReuseCheckResponse.branchName",
    ).optional(),
    // The two daemon verdicts. `isClean` is the working-tree cleanliness the
    // dirty-acknowledgement gate keys off (D-010-15); `compatible` is
    // branch-strategy compatibility, and an incompatible candidate never binds
    // regardless of acknowledgement (I-010-8).
    isClean: z.boolean().optional(),
    compatible: z.boolean().optional(),
    // Populated when `!isClean || !compatible` — an emitter obligation, not a
    // refinement (see the banner). Short authored summary, capped at the
    // short-human-reason class; see the constant's declaration for why raw
    // porcelain output does not belong here.
    reason: wireFreeFormString(
      WORKTREE_REUSE_REASON_MAX_LEN,
      "WorktreeReuseCheckResponse.reason",
    ).optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// EphemeralClonePrepare — `repo.ephemeralClonePrepare` (mutation).
// --------------------------------------------------------------------------
//
// NO TTL ON THE WIRE (D-010-2; `Spec-010 §Resolved Questions and V1 Scope
// Decisions`): the clone TTL is DAEMON CONFIGURATION
// (`ephemeral-clone-service.ts`'s `ttlMs`), and the request carries no
// `ttlMs` / `expiresAt` / `ttlSeconds` field of any spelling. `.strict()` is
// what makes that a refusal rather than a silent strip — a caller who believes
// it set a TTL and had the key dropped would run against a deadline it never
// chose, so the parse error is the honest outcome and
// `__tests__/worktree.test.ts` pins it behaviorally.

export interface EphemeralClonePrepareRequest {
  workspaceId: WorkspaceId;
  branchName: string;
  cleanupPolicy?: "on_run_complete" | "manual" | undefined;
}
// The `as unknown as` bridge — single-T `CleanupPolicySchema` member (the
// banner's typing note).
export const EphemeralClonePrepareRequestSchema: z.ZodType<
  EphemeralClonePrepareRequest,
  EphemeralClonePrepareRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // REQUIRED ON THE WIRE (D-010-19) — the head branch inside the clone. The
    // contrast with `ExecutionRootPrepareRequest.branchName?` above is
    // deliberate and is the whole of D-010-19: wire prepares are pre-run and
    // carry no slug-rule seed, and unlike the execution-root prepare there is
    // no `read-only` arm here for which the field would be meaningless — every
    // clone prepare needs a head branch, so requiredness is expressible in the
    // SHAPE and belongs here rather than in a service-side refusal.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "EphemeralClonePrepareRequest.branchName",
    ),
    // OPTIONAL; the daemon applies `on_run_complete` when it is absent and
    // reports the EFFECTIVE policy on the response (D-010-2). Deliberately not
    // `.default("on_run_complete")`, for both of the reasons the select
    // request's `executionMode` gives: the default is service-side state, and
    // `.default()` is a transform that would break the Input=Output equality
    // the double-T annotation asserts — a divergence the `as unknown as`
    // bridge on this schema would HIDE rather than surface.
    cleanupPolicy: CleanupPolicySchema.optional(),
  })
  .strict() as unknown as z.ZodType<EphemeralClonePrepareRequest, EphemeralClonePrepareRequest>;

export interface EphemeralClonePrepareResponse {
  cloneId: EphemeralCloneId;
  cloneRoot: string;
  state: Extract<EphemeralCloneState, "creating" | "ready">;
  cleanupPolicy: "on_run_complete" | "manual";
  branchName: string;
  expiresAt: string;
}
// Single-T — a response is not an input surface.
export const EphemeralClonePrepareResponseSchema: z.ZodType<EphemeralClonePrepareResponse> = z
  .object({
    cloneId: EphemeralCloneIdSchema,
    cloneRoot: wireFreeFormString(REPO_PATH_MAX_LEN, "EphemeralClonePrepareResponse.cloneRoot"),
    // NARROWED TO THE TWO NON-TERMINAL STATES, and here the narrowing is the
    // ratified contract rather than a local tightening: the block types this
    // field `Extract<EphemeralCloneState, "creating" | "ready">`. A prepare
    // that ended `retired` or `failed` did not prepare a clone — it refused
    // with `clone.prepare_failed` (I-010-7), so the terminal states are
    // unrepresentable on the success path by construction.
    //
    // Spelled as a narrowed `z.enum` rather than derived from
    // `EphemeralCloneStateSchema`, because T1.1 annotates that schema as the
    // ERASED `z.ZodType<EphemeralCloneState>`, which exposes no `ZodEnum`
    // members to narrow through (the same erasure that makes the family-payload
    // factory's return admit no `.extend()`). The binding to the parent
    // vocabulary is the `Extract<…>` on the interface above and is a real
    // compile-time check, not a comment: drop a member from
    // `EphemeralCloneState` and this object's inferred output stops being
    // assignable to the annotation.
    state: z.enum(["creating", "ready"]),
    // The EFFECTIVE policy actually applied — the request's field is optional,
    // this one is not, because reporting it is the point (D-010-2 /
    // `Spec-010 §Interfaces And Contracts`: clone prepare reports cleanup
    // policy). Composes T1.1's `CleanupPolicySchema` so the snake_case wire
    // literals cannot drift between the two surfaces.
    cleanupPolicy: CleanupPolicySchema,
    // The effective head branch, persisted on the clone row
    // (`ephemeral_clones.branch_name` NOT NULL) and REQUIRED here: the request
    // above always supplies one, and the run-setup gate path always resolves
    // one before reaching the service, so "a clone with no head branch" is a
    // state the model never produces.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "EphemeralClonePrepareResponse.branchName",
    ),
    // The TTL deadline the daemon computed (`now + ttlMs`), reported so the
    // caller can see the expiry it did not get to choose. ISO 8601 with
    // `{ offset: true }` — the package-wide datetime convention (`checkedAt` /
    // `attachedAt` in repo.ts, `occurredAt` in event.ts). I-010-20 keeps the
    // views from doing expiry MATH on it; carrying the instant is not the same
    // as deriving from it.
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// EphemeralCloneDispose — `repo.ephemeralCloneDispose` (mutation).
// --------------------------------------------------------------------------
//
// The explicit-disposal arm: `Spec-010 §Interfaces And Contracts`'s "explicit
// disposal of a prepared clone", which is the `manual` cleanup-policy path and
// the operator-driven cleanup path. The TTL sweep and the `on_run_complete`
// release reach the same terminal state without this method (D-010-13).

export interface EphemeralCloneDisposeRequest {
  cloneId: EphemeralCloneId;
}
// Bridge-free double-T (a lone double-T branded id).
export const EphemeralCloneDisposeRequestSchema: z.ZodType<
  EphemeralCloneDisposeRequest,
  EphemeralCloneDisposeRequest
> = z
  .object({
    cloneId: EphemeralCloneIdSchema,
  })
  .strict();

export interface EphemeralCloneDisposeResponse {
  cloneId: EphemeralCloneId;
  state: Extract<EphemeralCloneState, "retired">;
}
// Single-T — a response is not an input surface.
export const EphemeralCloneDisposeResponseSchema: z.ZodType<EphemeralCloneDisposeResponse> = z
  .object({
    cloneId: EphemeralCloneIdSchema,
    // `Extract<EphemeralCloneState, "retired">` — a single literal, so
    // `z.literal` rather than a one-member `z.enum`. Dispose has exactly one
    // success shape: it RECORDS retirement, and disk removal follows
    // asynchronously (I-010-9's recorded-then-cleaned ordering), so no other
    // state is reachable on this path. The narrowing is the ratified block's,
    // not a local tightening — contrast `RepoDetachResponse.state` in repo.ts,
    // which stays the full vocabulary precisely because its ratified spelling
    // glosses the value in a comment instead of narrowing the type.
    state: z.literal("retired"),
  })
  .strict();

// --------------------------------------------------------------------------
// WorktreeRetire — `repo.worktreeRetire` (mutation).
// --------------------------------------------------------------------------
//
// `Spec-010 §Interfaces And Contracts` requires retirement to be RECORDED even
// when filesystem deletion happens later, and I-010-9 fixes the order: the row
// transition and its `worktree.retired` event land before any disk mutation,
// and the async sweep stamps `cleaned_at` afterwards. That is why this
// response carries no `cleanedAt` — at the moment it is produced, nothing has
// been cleaned. The stamp surfaces on the status read below.
//
// Metadata and provenance survive retirement (I-010-3 / D-010-5): retiring
// erases nothing, and a retired row stays queryable.

export interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
}
// Bridge-free double-T (a lone double-T branded id).
export const WorktreeRetireRequestSchema: z.ZodType<WorktreeRetireRequest, WorktreeRetireRequest> =
  z
    .object({
      worktreeId: WorktreeIdSchema,
    })
    .strict();

export interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">;
}
// Single-T — a response is not an input surface.
export const WorktreeRetireResponseSchema: z.ZodType<WorktreeRetireResponse> = z
  .object({
    worktreeId: WorktreeIdSchema,
    // `Extract<WorktreeState, "retired">`, the ratified narrowing — the retire
    // path has one success state. Note what it EXCLUDES: `failed` is not a
    // retire outcome (a failed CREATION never materialized a checkout), and a
    // refusal while the root is held busy is the typed
    // `worktree.retire_conflict` error rather than a response carrying the
    // unchanged state.
    state: z.literal("retired"),
  })
  .strict();

// --------------------------------------------------------------------------
// WorktreeStatusRead — `repo.worktreeStatusRead` (query).
// --------------------------------------------------------------------------
//
// The daemon-owned read surface over worktree AND clone records with
// provenance (D-010-17; `Spec-010 §Interfaces And Contracts`), feeding the
// Phase 4 execution-mode-picker status view. Two arrays in one response
// because the two record kinds answer one question — what roots does this
// session hold — and the picker renders them together.
//
// NEVER-HIDE (I-010-19): the projection returns EVERY row, `failed` and
// `retired` included, and the views label rather than filter. Both `state`
// fields below therefore carry their full vocabularies; a "live states only"
// narrowing would make the admit-not-eject contract unrepresentable on the
// wire, which is the mirror image of the three `Extract` narrowings above.

// The RUNTIME half of `WorktreeStatusReadResponse.worktrees[].createdByRunId`.
//
// `RunId`'s canonical origin is `packages/contracts/src/provider-driver.ts`
// (Plan-005 CP-005-6), which declares the brand TYPE-ONLY on purpose: the
// paired `RunIdSchema` — spelled there as `brandedUuidIdSchema<RunId>("RunId")`
// — co-locates at Plan-005 T4.2, whose first consumer is the SDK seam.
// Authoring that export from here would both break Plan-005's ratified
// type-only Phase 1 and declare another plan's symbol, which is the
// canonical-origin rule (I-010-1) read in the reciprocal direction.
//
// So the TYPE is imported and the runtime half is carried by this
// module-local, DELIBERATELY UNEXPORTED validator, composed from the same
// helper with the same brand name — behaviorally identical to the schema T4.2
// will export. It adds no public surface (and so needs no
// `isolatedDeclarations` annotation, the `workspaceListItemSchema` precedent),
// and when T4.2 lands the swap is one line: delete this const and import
// `RunIdSchema` from `./provider-driver.js`.
const runIdSchema = brandedUuidIdSchema<RunId>("RunId");

// The item TYPES stay INLINE and unnamed on the response interface below,
// transcribed from the ratified block's own anonymous `Array<{…}>` spellings;
// the SCHEMAS are hoisted to module-local consts rather than nested two levels
// inside a call argument, which would bury a ten-field and a nine-field list
// (the clone record carries no `updatedAt`; see its declaration). Both halves
// are the `WorkspaceListResponse` precedent, including its reason for not
// exporting a named item type: nothing else in Plan-010 consumes these shapes,
// so a `WorktreeSummary` export would pre-commit every downstream importer to
// a symbol neither the plan nor the spec asked for. Consumers that need an
// element type spell `WorktreeStatusReadResponse["worktrees"][number]`.
const worktreeStatusRecordSchema = z
  .object({
    // QUALIFIED `worktreeId`, not the bare `id` the mount and workspace read
    // projections use — transcribed verbatim from the ratified block. The
    // asymmetry is the doc's and it is coherent: this projection returns TWO
    // record kinds in one response, so each names its own key (`worktreeId` /
    // `cloneId`) rather than both answering to `id`.
    worktreeId: WorktreeIdSchema,
    repoMountId: RepoMountIdSchema,
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeStatusReadResponse.worktrees[].branchName",
    ),
    // `worktrees.fs_root` — a daemon-provisioned root under the execution-roots
    // directory (D-010-6), never a path inside the attached checkout. REQUIRED
    // because the column is NOT NULL: a worktree row exists only once its
    // placement is decided.
    fsRoot: wireFreeFormString(REPO_PATH_MAX_LEN, "WorktreeStatusReadResponse.worktrees[].fsRoot"),
    state: WorktreeStateSchema,
    // REQUIRED — `worktrees.created_by_session_id` is NOT NULL and I-010-3
    // makes creating-session provenance unconditional, so a provenance-less
    // worktree row is a state the model never produces.
    createdBySessionId: SessionIdSchema,
    // OPTIONAL, and the asymmetry with `createdBySessionId` IS the provenance
    // contract rather than an inconsistency: `created_by_run_id` is nullable
    // because a pre-run explicit `repo.executionRootPrepare` creates a worktree
    // with no run to attribute (D-010-5). Retirement erases neither (I-010-3).
    createdByRunId: runIdSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    // The async disk-cleanup stamp (`worktrees.cleaned_at`), absent until the
    // sweep runs. Its absence on a `retired` row is the observable half of
    // I-010-9's recorded-then-cleaned ordering — missing information about the
    // world, not missing data in the row.
    cleanedAt: z.iso.datetime({ offset: true }).optional(),
  })
  // The ITEM carries its own `.strict()` as well as the envelope below, so the
  // wire shape is closed at BOTH levels (the `workspaceListItemSchema`
  // precedent). A top-level-only guard would let item-level drift through
  // unnoticed, and outer `.strict()` leaves no compile-time trace to catch it.
  .strict();

const ephemeralCloneStatusRecordSchema = z
  .object({
    cloneId: EphemeralCloneIdSchema,
    // WORKSPACE-anchored, where the worktree record above is MOUNT-anchored —
    // transcribed from the ratified block and faithful to the DDL
    // (`ephemeral_clones.workspace_id` vs `worktrees.repo_mount_id`). A clone
    // is provisioned for one workspace's writable execution; a worktree is a
    // checkout OF a mount that several workspaces may reuse.
    workspaceId: WorkspaceIdSchema,
    cloneRoot: wireFreeFormString(
      REPO_PATH_MAX_LEN,
      "WorktreeStatusReadResponse.ephemeralClones[].cloneRoot",
    ),
    // The head branch inside the clone — exposed on clone records by
    // `Spec-010 §Interfaces And Contracts` and REQUIRED here because
    // `ephemeral_clones.branch_name` is NOT NULL (D-010-5).
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeStatusReadResponse.ephemeralClones[].branchName",
    ),
    // Full four-value vocabulary, `retired` and `failed` included (I-010-19).
    state: EphemeralCloneStateSchema,
    cleanupPolicy: CleanupPolicySchema,
    expiresAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    // No `updatedAt` on this record, though `ephemeral_clones.updated_at`
    // exists: the ratified block carries the column on the worktree projection
    // only. Transcribed as ratified — adding it here would be a wire change
    // ahead of the doc.
    cleanedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export interface WorktreeStatusReadRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
}
// Bridge-free double-T: `SessionIdSchema` and `RepoMountIdSchema` are both
// double-T (the `WorkspaceListRequestSchema` shape exactly).
export const WorktreeStatusReadRequestSchema: z.ZodType<
  WorktreeStatusReadRequest,
  WorktreeStatusReadRequest
> = z
  .object({
    // SESSION-scoped: the read answers "what roots does this session hold",
    // and the T2.5 projection reaches the rows through `repo_mounts`.
    sessionId: SessionIdSchema,
    // OPTIONAL FILTER, not a second identifier — omission returns the whole
    // session, presence narrows to one mount's records. No exactly-one
    // refinement applies (contrast `repo.executionModeCapabilitiesRead`):
    // `sessionId` alone already identifies the query.
    repoMountId: RepoMountIdSchema.optional(),
  })
  .strict();

export interface WorktreeStatusReadResponse {
  worktrees: Array<{
    worktreeId: WorktreeId;
    repoMountId: RepoMountId;
    branchName: string;
    fsRoot: string;
    state: WorktreeState;
    createdBySessionId: SessionId;
    createdByRunId?: RunId | undefined;
    createdAt: string;
    updatedAt: string;
    cleanedAt?: string | undefined;
  }>;
  ephemeralClones: Array<{
    cloneId: EphemeralCloneId;
    workspaceId: WorkspaceId;
    cloneRoot: string;
    branchName: string;
    state: EphemeralCloneState;
    cleanupPolicy: "on_run_complete" | "manual";
    expiresAt: string;
    createdAt: string;
    cleanedAt?: string | undefined;
  }>;
}
// Single-T — a read projection, never an input surface.
export const WorktreeStatusReadResponseSchema: z.ZodType<WorktreeStatusReadResponse> = z
  .object({
    // BOTH ARRAYS REQUIRED, and neither carries `.min(1)`: a session that has
    // bound no writable root yet returns two empty arrays, which is a lawful
    // answer rather than a degenerate one. Required-but-empty also keeps the
    // Phase 4 views from having to distinguish "no records" from "the field
    // was omitted" (I-010-20 — they render what the daemon returns).
    worktrees: z.array(worktreeStatusRecordSchema),
    ephemeralClones: z.array(ephemeralCloneStatusRecordSchema),
  })
  .strict();
