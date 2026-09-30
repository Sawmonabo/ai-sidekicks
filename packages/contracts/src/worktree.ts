// Worktree contracts — the worktree state and its lifecycle payload, the
// branded `WorktreeId`, `BranchContextId` and `RemovedWorktreeId`, and the
// create, remove and status pairs. Contract and DDL lockstep is pinned by a
// conformance test against the daemon schema's `CHECK` clauses.
//
// repo.ts owns `ExecutionMode`, `WorkspaceState`, the branded `RepoMountId` and
// `WorkspaceId`, and the family payload factory
// `buildRepoWorkspaceLifecyclePayloadSchema`; this module imports them and never
// redefines one. `WorktreeId`, `WorktreeState`, `BranchContextId` and
// `RemovedWorktreeId` are declared here and nowhere else. The setup card, the
// kept copies and the extra event payloads live in `worktree-setup.ts`,
// `removed-worktree.ts` and `worktree-events.ts`, which import this module.
//
// IMPORT DIRECTION IS ONE-WAY — this module imports NOTHING from `./event.js`,
// and nothing whose import CLOSURE reaches it, however many hops out (the
// transitive rule repo.ts's header documents; the `node-id.js` hoist is the
// precedent). `event.ts` imports this module's payload schema to register the
// `worktree.*` variants into `SessionEventSchema`, so a back-import would close
// an eager module-scope Zod cycle that throws `ReferenceError` at import time
// and that `tsc` does not flag. `./session.js`, `./provider-driver.js` and
// `./workspace.js` are closure-clean: none of them reaches `./event.js`. Before
// composing any new cross-module symbol below, check its closure the same way.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { RunIdSchema, type RunId } from "./provider-driver.js";
import {
  buildRepoWorkspaceLifecyclePayloadSchema,
  ExecutionModeSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountId,
  type RepoWorkspaceLifecyclePayloadOf,
  type WorkspaceId,
  type WorkspaceState,
} from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session.js";

// --------------------------------------------------------------------------
// ExecutionMode — canon, re-exported (type AND schema value).
// --------------------------------------------------------------------------
//
// The execution-mode contract this domain builds on distinguishes `bound-root`
// and `provisioned-worktree`. That taxonomy is canon, so it is satisfied by
// IMPORT, never redefinition — re-exported here so the taxonomy is reachable
// through this module's own surface, the same cross-module composition
// presence.ts uses for session.ts's ids. Both this module and repo.ts are
// star-exported by index.ts; a re-export that resolves to the SAME declaration
// is not an ambiguous duplicate.
//
// TWO STATEMENTS, the shape those siblings use: the type-only half MUST spell
// `export type {... }` (the `isolatedModules` + `verbatimModuleSyntax` posture
// from tsconfig.base.json forbids erased re-exports on the runtime form), and the
// value half re-exports the canonical binding rather than declaring a new one, so
// no explicit type annotation applies (TS9010 governs declarations, not
// re-exports) and no module edge is added — this file already imports repo.ts at
// runtime for the payload factory. consumes the VALUE: both
// `ExecutionModeSelectRequest` and `ExecutionModeSelectResponse` type
// `executionMode: ExecutionMode`, so those Zod pairs need the schema and not
// merely the type. `__tests__/worktree.test.ts` pins the member set three
// ways: compile-time exhaustiveness over the re-exported type, runtime `.options`
// equality, and object identity against repo.ts's declaration (the check a forked
// redefinition here would fail).
export type { ExecutionMode } from "./repo.js";
export { ExecutionModeSchema } from "./repo.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Daemon-minted UUID primary keys (`worktrees.id`, `branch_contexts.id`), so
// both compose the `brandedUuidIdSchema`
// helper from `./internal/branded.js`, the same idiom as `RepoMountIdSchema` /
// `WorkspaceIdSchema` in repo.ts: the double-T `z.ZodType<T, T>` bridges Zod's
// single-T `$ZodBranded` output to the shape tRPC v11's Standard-Schema-V1
// input inference needs and the explicit annotation is what
// `--isolatedDeclarations` requires (TS9010).

// Canonical origin of the `WorktreeId` brand. The family payload's `worktreeId?`
// field in repo.ts stays an unbranded canonical-UUID string with an IDENTICAL
// runtime accept set (both parse the same RFC 9562 text form) — the brand applies
// where consumers parse through this schema, so declaring it here required no
// repo.ts edit.
export type WorktreeId = string & { readonly __brand: "WorktreeId" };
export const WorktreeIdSchema: z.ZodType<WorktreeId, WorktreeId> =
  brandedUuidIdSchema<WorktreeId>("WorktreeId");

// The polymorphic branch-context carrier row's id (`branch_contexts`,
// workspace-anchored). creates the brand and table extends the row for
// PR/diff attribution — provides both forward, so this brand is cross-plan
// surface from the day it lands.
export type BranchContextId = string & { readonly __brand: "BranchContextId" };
export const BranchContextIdSchema: z.ZodType<BranchContextId, BranchContextId> =
  brandedUuidIdSchema<BranchContextId>("BranchContextId");

// A worktree removed with `Discard and remove`, kept whole until the person
// deletes the copy. It is a record of its own, apart from the retired worktree
// row, because the copy outlives the tree and a put-back makes a new worktree.
export type RemovedWorktreeId = string & { readonly __brand: "RemovedWorktreeId" };
export const RemovedWorktreeIdSchema: z.ZodType<RemovedWorktreeId, RemovedWorktreeId> =
  brandedUuidIdSchema<RemovedWorktreeId>("RemovedWorktreeId");

// --------------------------------------------------------------------------
// Canonical enums
// --------------------------------------------------------------------------
//
// TWO LEVELS — do not conflate them. In-repo, order is ALSO pinned: the
// declaration order below mirrors the ratified `CHECK` clauses byte-for-byte, so
// the contract↔DDL lockstep hands conformance test an ORDERED target to compare
// the schema's extracted `CHECK` clauses against, and
// `__tests__/worktree.test.ts` asserts the enum unsorted. A reorder here
// is therefore a suite failure plus a required re-sync, never a wire break.

// The 6-value worktree lifecycle (`worktrees.state` CHECK). `retired` and
// `failed` are the two non-live positions — the active-branch
// partial-unique index filters `WHERE state NOT IN ('retired', 'failed')`,
// git-faithfully: a `merged` checkout still holds its branch, while a
// `failed` creation never materialized one.
//
// SIX STATES, FIVE EVENTS. Each transition maps to its `worktree.*` event
// EXCEPT `-> failed`, which deliberately emits none — the failure incident is
// already evented as `workspace.stale` by the coupled `failRootPreparation`, and
// registry stays closed (no `worktree.failed` row exists to emit). Failed
// rows remain queryable via `repo.worktreeStatusRead`.
export type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
export const WorktreeStateSchema: z.ZodType<WorktreeState> = z.enum([
  "creating",
  "ready",
  "dirty",
  "merged",
  "retired",
  "failed",
]);

// --------------------------------------------------------------------------
// WorktreeLifecyclePayload — instantiation of the family payload.
// --------------------------------------------------------------------------
//
// `EventEnvelope.payload` for the five `worktree.*` members of registered
// into `SessionEventSchema` by event.ts. The shape is the family payload
// `{sessionId, repoMountId?, workspaceId?, worktreeId?, state, actor?}`
// instantiated over THIS plan's state vocabulary via the exported factory —
// NOT `.extend()` (the factory's erased `z.ZodType` return admits none, by
// design), NOT a redefinition, and NOT a third `state` union arm in repo.ts
// (refused in the factory's own doc comment: it would re-close the node-id.ts
// eager-cycle class and widen every family member's accept set at once).
// Parameterizing keeps each member's accept set exactly its owning plan's
// vocabulary — a worktree payload claiming `attached` or `preparing`, or a
// workspace payload claiming `merged`, stays a parse error.
//
// EMITTER'S OBLIGATION: `worktreeId` populated on every `worktree.*`
// emission. The family schema leaves it optional because subject-id presence
// is per-type emitter discipline enforced at the `.parse()` emission seam,
// not a family shape rule (a detach-cascade row legitimately carries several
// ids). It stays the unbranded canonical-UUID string the family declares;
// the runtime accept set already equals `WorktreeIdSchema`'s, and consumers
// narrow to the brand at their own parse boundaries.
//
// FIVE OF THE SIX STATES appear on the wire: `failed` is representable in
// this payload type, but no `worktree.*` event carries it in V1 because the
// `-> failed` transition emits no worktree event at all. Representability is
// deliberate — the state enum is the ROW vocabulary (lockstep), and the
// closed EVENT registry, not a narrowed payload arm, is what pins the
// no-failed-event decision. Two tests pin it: the union rejection in
// `__tests__/worktree.test.ts`, and the daemon emitter's test that no
// emission carries `failed`.
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
// Wire surfaces — the five `repo.*` request/response pairs.
// ==========================================================================
//
// `repo.executionModeSelect` (mutation), `repo.executionRootPrepare`
// (mutation), `repo.worktreeReuseCheck` (query), `repo.worktreeRetire`
// (mutation), `repo.worktreeStatusRead` (query) — the five methods, in
// declaration order. They ride the SAME `repo.*` namespace as the mount and
// workspace methods rather than a new `worktree` root: mounts, workspaces and
// worktrees are one repo aggregate (sibling symmetry — `repo.executionModeCapabilitiesRead`
// ↔ `repo.executionModeSelect`).
//
// Field sets are transcribed, one per pair. Every
// shape composes brands and enums above, or canon by import, rather than
// re-spelling either — which is also the contract half of: the `state` fields
// carry the enum objects conformance test compares against the schema's
// `CHECK` clauses, so a literal union re-spelled here would sit outside that
// lockstep.
//
// Daemon JSON-RPC ONLY — worktrees are node-local filesystem state, so no
// control-plane tRPC sibling exists, and the five names register against the daemon's
// `MethodRegistry` (its regex-conformance and typed-error-projection preconditions are both
// resolved).
//
// BRANCH NAMING IS THE CARVE-OUT from that list, and it is the asymmetry these
// shapes most need read correctly. its own wording is narrower than "output":
// the SDK never COMPUTES the naming. Daemon-DERIVED naming — slug rule and the
// collision suffixing — is never client-computed and reaches a client only as
// output. A caller-SUPPLIED `branchName` is lawful on the way IN; the
// execution-root prepare leaves it optional precisely because that is where the
// derivation path runs, and the reuse check takes one as its lookup KEY.
//
// TYPING — REQUESTS are double-T `z.ZodType<T, T>`, RESPONSES are single-T
// `z.ZodType<T>`. The split is deliberate, grounded in how the substrate actually
// consumes them: `MethodRegistry.register` declares `paramsSchema: ZodType<P>`
// and `resultSchema: ZodType<R>` — both single-T slots — and the live
// `session.read` registration passes a double-T request alongside a single-T
// response into exactly those slots.
//
// ONE of the five requests needs the `as unknown as z.ZodType<T, T>` bridge,
// and the condition is structural rather than stylistic: a SINGLE-T member's
// `Input` slot is `unknown` (`$ZodTypeInternals` declares `Input` covariant),
// which poisons the composed object's inferred input.
// `ExecutionModeSelectRequestSchema` composes single-T `ExecutionModeSchema` —
// the identical mechanism that bridges `WorkspaceBindRequestSchema` in repo.ts.
// The other four compose only double-T branded ids, `z.ZodString`
// (`wireFreeFormString`), and `z.ZodBoolean`, none of which contributes an
// `unknown` slot: the bridge-free condition `WorkspaceListRequestSchema`
// documents. The bridge sits at the CONSUMPTION site rather than re-annotating
// the canonical `ExecutionModeSchema` declaration.
//
// NO CROSS-FIELD REFINEMENTS on any conditional field below — the reuse
// check's six optional fields (five describing the candidate, plus the
// `reason` that explains a negative verdict), the prepare response's
// `worktreeId`, and the status read's `createdByRunId`, `ahead`, `behind` and
// `newWorktree`. All are
// plain-optional, and each conditional relationship is an EMITTER obligation
// discharged at the `.parse()` boundary of the daemon surface that produces it
// — the stance repo.ts's workspace half documents at length. Two of them the
// schema COULD NOT check even in principle: whether a prepare response carries
// `worktreeId` depends on the workspace's selected mode, and the conditional
// `branchName` requiredness on `ExecutionRootPrepareRequest` depends on whether
// a run id exists. Neither is visible at parse time, which is exactly why that
// refusal is the typed service-side `workspace.branch_name_required` (400)
// raised before any git call, and not a parse error.

// Bound on the git ref names these surfaces carry — `branchName` (the head
// branch of a worktree) and `baseRef` (the worktree base: a branch,
// tag, or commit-ish). ONE constant for both, because both carry a git ref
// name, and two constants obliged to hold the same value with nothing
// enforcing the equality is a hazard.
//
// 256 is this package's IDENTIFIER class (`NODE_ID_MAX_LEN`,
// `EVENT_FIELD_MAX_LEN`, `DRIVER_BINDING_ID_MAX_LEN`) and NOT the 4096
// filesystem-path class — the deliberate opposite of the generosity argument
// `WORKSPACE_LAST_ERROR_MAX_LEN` makes, so it needs the reason that defuses
// it. That argument says an under-sized cap can make a LAWFUL daemon RESPONSE
// unrepresentable, because responses are validated too. It does not reach
// here: every `branchName` that can appear on a response originated at this
// same capped wire, from the daemon's own slug rule (the
// `sidekicks/<session-short-id>/<task-slug>` pattern, whose slug segment
// truncates far below this bound), or from the `onCollision: 'suffix'` arm
// appending `-<ordinal>` to a capped name — the one origin that can OUTGROW
// the cap, which refuses at the write (`branch_name_unavailable`) rather than
// persist a name this bound would make unrepresentable — and `bound-root` mode
// writes no worktree row at all. So no read surface can inherit a name this
// cap would refuse.
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
// defined and the contract layer can discharge none of it. It falls on the
// only task that hands either ref to git:
//
//   1. OPTION INJECTION on `baseRef`. The field reaches `git worktree add` in
//      the POSITIONAL commit-ish slot, and gives it no pre-git validation —
//      the daemon resolves the mount's HEAD only when the field is ABSENT, so
//      a present value passes through as written. closes the two ADJACENT
//      hazards and neither is this one: argv-only `execFile` removes the
//      shell, and the neutralized `core.hooksPath` removes
//      repository-controlled code, but git's own `parse_options` keeps
//      scanning for options AFTER a non-option argument, so a leading-dash
//      `baseRef` is consumed as an OPTION rather than as a commit-ish.
//      Discharge either by passing `--` before the positional refs, or by
//      refusing a leading-dash `baseRef` before any git call.
//
// That refusal deliberately does NOT live in this schema: a wire-level
// leading-dash rejection would be a contract change ahead of the ratified
// block, and which discharge to take is the call. `branchName` is UNAFFECTED
// under either — it rides `-b`'s value slot, which `parse_options` consumes
// as the argument to a known option rather than re-scanning.
export const WORKTREE_GIT_REF_MAX_LEN = 256;

//
// The 8192 captured-output class (`WORKSPACE_LAST_ERROR_MAX_LEN`) is the wrong
// neighbor — that field records a FAILURE detail with no authored form
// available, while this one records a routine verdict on a success-path read.
//
// MINTED rather than importing the
// `EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN`, which holds the same 512:
// importing would assert an equality neither contract owes the other, the
// reasoning that keeps `WORKSPACE_LAST_ERROR_MAX_LEN` from importing
// `ERROR_MESSAGE_MAX_LEN`. `FILE_PATH_MAX_LEN` is imported and NOT restated
// for the opposite reason — it mirrors an external platform ceiling
// (`PATH_MAX`), so one constant is the honest source rather than a
// coincidence of policy.
export const WORKTREE_REUSE_REASON_MAX_LEN = 512;

// --------------------------------------------------------------------------
// ExecutionModeSelect — `repo.executionModeSelect` (mutation).
// --------------------------------------------------------------------------
//
// SELECT RECORDS; PREPARE MATERIALIZES. This mutation records the canonical
// mode and transitions the workspace through `beginRootPreparation` — while
// per-task root materialization is `repo.executionRootPrepare`'s surface below.
// A client sends exactly one selection mutation per explicit switch, never a
// client-sequenced select-then-prepare chain.

/** The `repo.executionModeSelect` input: the workspace and the mode it switches to. */
export interface ExecutionModeSelectRequest {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
}
// The `as unknown as` bridge — single-T `ExecutionModeSchema` member; see the
// banner's typing note for the mechanism and for why the bridge belongs here
// rather than on the declaration.
/** Wire schema for {@link ExecutionModeSelectRequest}. */
export const ExecutionModeSelectRequestSchema: z.ZodType<
  ExecutionModeSelectRequest,
  ExecutionModeSelectRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // The mode being switched TO — REQUIRED, and the full taxonomy reached by
    // import rather than a re-spelling. No `.default()`, for both of the reasons
    // `WorkspaceBindRequest.executionMode` gives: a wire default would make
    // "caller omitted the mode" indistinguishable from "caller chose that
    // mode" on the one surface whose entire job is recording an EXPLICIT
    // switch, and `.default()` is a transform, so Input would stop equalling
    // Output and the double-T annotation would no longer be truthful.
    executionMode: ExecutionModeSchema,
  })
  .strict() as unknown as z.ZodType<ExecutionModeSelectRequest, ExecutionModeSelectRequest>;

/** The `repo.executionModeSelect` result: the recorded mode and the workspace's position. */
export interface ExecutionModeSelectResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}
/** Wire schema for {@link ExecutionModeSelectResponse}; single-T, as a response is no input. */
export const ExecutionModeSelectResponseSchema: z.ZodType<ExecutionModeSelectResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Echoed back so the caller sees the mode the daemon actually RECORDED.
    // Load-bearing rather than cosmetic: an unavailable mode is a typed
    // `workspace.mode_unsupported` refusal, never a substituted mode quietly
    // reported here.
    executionMode: ExecutionModeSchema,
    // The post-select workspace position — `preparing` while the root
    // awaits prepare. Composes the FULL 5-value `WorkspaceStateSchema` and is
    // NOT narrowed to that literal: the ratified block types the field
    // `WorkspaceState`, exactly as `WorkspaceBindResponse.state` does. Contrast
    // the `Extract`-narrowed retire `state` further down, where the ratified
    // block narrows the TYPE itself and the schema follows it.
    state: WorkspaceStateSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// ExecutionRootPrepare — `repo.executionRootPrepare` (mutation).
// --------------------------------------------------------------------------
//
// Materializes (or binds) the execution root for the workspace's selected mode
// before a run enters `running`, and it is also the surface explicit worktree
// REUSE rides, by naming the candidate.
//
// NO WIRE `runId`, deliberately: run binding is gate-supplied service-side.
// The run-setup gate calls the service directly and
// supplies the run id that populates `worktrees.created_by_run_id` + the
// `run_execution_contexts` row, so a wire `runId` would let a caller forge
// run provenance on a row the gate owns.

/** The `repo.executionRootPrepare` input: the workspace, its branch, and any worktree to reuse. */
export interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string | undefined;
  baseRef?: string | undefined;
  reuseWorktreeId?: WorktreeId | undefined;
  acknowledgeDirtyCandidate?: boolean | undefined;
  carryUncommitted?: boolean | undefined;
}
// Bridge-free double-T: `WorkspaceIdSchema` / `WorktreeIdSchema` are double-T,
// `wireFreeFormString` is a `z.ZodString` (Input `string`), and `z.boolean()`
// is a `z.ZodBoolean` (Input `boolean`) — no single-T member, so nothing
// contributes an `unknown` input slot.
/** Wire schema for {@link ExecutionRootPrepareRequest}. */
export const ExecutionRootPrepareRequestSchema: z.ZodType<
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareRequest
> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // SCHEMA-OPTIONAL, SERVICE-CONDITIONAL — the one field on these five
    // pairs whose optionality does not mean "optional". A wire prepare is
    // pre-run by definition and carries no slug-rule derivation seed, so
    // omitting the branch draws the typed `workspace.branch_name_required`
    // (400) refusal before any git call.
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.branchName",
    ).optional(),
    // Omission means the mount's current HEAD branch; an explicit value
    // overrides. A detached-HEAD mount with no explicit base is a typed
    // refusal daemon-side, never a guess — which is why the default is
    // absent from the wire rather than spelled as a `.default()`: the daemon
    // reads HEAD, and the schema cannot.
    baseRef: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "ExecutionRootPrepareRequest.baseRef",
    ).optional(),
    // EXPLICIT REUSE ONLY: a worktree binds as a reuse target only by being
    // NAMED here. There is no "reuse if available" flag and no implicit-reuse
    // path anywhere in the plan, which is why this is an id rather than a
    // boolean.
    //
    // MOUNT CONSISTENCY is a runtime obligation rather than a shape one: the named
    // candidate's `worktrees.repo_mount_id` must equal the mount behind
    // `workspaceId`, or the prepare would bind an execution root inside a
    // DIFFERENT repository. Neither row is visible at parse time, so it rides the
    // `validateReuse` compatibility verdict. This covers the hand-assembled
    // request, not the normal one — the sanctioned discovery path is
    // mount-consistent by construction, since `WorktreeReuseCheckRequest` is
    // keyed on `repoMountId`.
    reuseWorktreeId: WorktreeIdSchema.optional(),
    // The SEPARATE consent that binds a DIRTY named candidate — separate
    // because naming a candidate and accepting its dirty state are two distinct
    // acts, and the acknowledgement is TOCTOU-scoped: a candidate that turned
    // dirty after the reuse check refuses `worktree.reuse_conflict` when the
    // ack is absent. It never bypasses INCOMPATIBILITY; an incompatible
    // candidate never binds regardless.
    //
    // No `.default(false)`: absence already means "no consent", so a default
    // would add a transform (breaking the double-T Input=Output equality the
    // annotation asserts) to express what omission expresses already.
    acknowledgeDirtyCandidate: z.boolean().optional(),
    // Carries the session's uncommitted work, untracked files included, onto
    // the new tree. The daemon refuses it unless the new base is the branch
    // the work sits on; absence means nothing is carried.
    carryUncommitted: z.boolean().optional(),
  })
  .strict();

/** The `repo.executionRootPrepare` result: the prepared root and the rows it names. */
export interface ExecutionRootPrepareResponse {
  executionRoot: string;
  state: WorkspaceState;
  worktreeId?: WorktreeId | undefined;
  branchContextId: BranchContextId;
}
/** Wire schema for {@link ExecutionRootPrepareResponse}; single-T, as a response is no input. */
export const ExecutionRootPrepareResponseSchema: z.ZodType<ExecutionRootPrepareResponse> = z
  .object({
    // Prepare either resolves a root or REFUSES with a typed error
    // (`worktree.create_failed` / the workspace codes) — admits no substituted
    // mode and no fallback root, so there is no partial success carrying an
    // unresolved root to represent.
    executionRoot: wireFreeFormString(
      FILE_PATH_MAX_LEN,
      "ExecutionRootPrepareResponse.executionRoot",
    ),
    // The workspace position after reprovision bracket
    // (`completeRootPreparation` on success). Full 5-value vocabulary, not
    // narrowed — the same stance as the select response above.
    state: WorkspaceStateSchema,
    // `worktreeId` is present for a `provisioned-worktree` prepare only, with
    // no refinement: which is lawful depends on the workspace's selected mode,
    // which the schema cannot see. The mode-conditional `run_execution_contexts`
    // CHECK is where that rule is structural. Every prepare writes or refreshes
    // a branch context, so `branchContextId` is always present.
    worktreeId: WorktreeIdSchema.optional(),
    branchContextId: BranchContextIdSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// WorktreeReuseCheck — `repo.worktreeReuseCheck` (query).
// --------------------------------------------------------------------------
//
// SINGULAR CANDIDATE BY CONSTRUCTION, which is why the response describes ONE
// candidate rather than carrying a `candidates` array: the partial-unique
// active-branch index `idx_worktrees_active_branch` guarantees at most one
// live checkout per (mount, branch) — so a list shape would be a wire
// promise the persistence model can never fill.
//
// requires this surface to report branch, cleanliness, and compatibility makes
// all three DAEMON verdicts, which is why they arrive as decided booleans and
// a rendered reason rather than as raw git state for a client to interpret.

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
    // branch has no key to look a candidate up by, and the derivation seed
    // argument does not apply to a pure read.
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
    // singular candidate holds (the check reports branch).
    branchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeReuseCheckResponse.branchName",
    ).optional(),
    // The two daemon verdicts. `isClean` is the working-tree cleanliness the
    // dirty-acknowledgement gate keys off; `compatible` is branch-strategy
    // compatibility, and an incompatible candidate never binds regardless of
    // acknowledgement.
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
// WorktreeRetire — `repo.worktreeRetire` (mutation).
// --------------------------------------------------------------------------
//
// requires retirement to be RECORDED even when filesystem deletion happens
// later, and fixes the order: the row transition and its `worktree.retired`
// event land before any disk mutation, and the async sweep stamps `cleaned_at`
// on the daemon's own record afterwards: when this response is produced, nothing
// has been cleaned.
//
// Metadata and provenance survive retirement: retiring erases nothing, and the
// retired record stays in the daemon, though the switcher's read lists only
// trees still standing.

/**
 * The `repo.worktreeRetire` input. `discard: false` is the ordinary removal: it
 * removes nothing the confirm did not show, and is refused with the current
 * risks when the tree changed since they were read. `discard: true` is sent only
 * from the discard confirm; the daemon then keeps the tree whole instead of
 * deleting it.
 */
export interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
  discard: boolean;
}
// Bridge-free double-T (a double-T branded id and a `z.ZodBoolean`).
export const WorktreeRetireRequestSchema: z.ZodType<WorktreeRetireRequest, WorktreeRetireRequest> =
  z
    .object({
      worktreeId: WorktreeIdSchema,
      discard: z.boolean(),
    })
    .strict();

/**
 * The `repo.worktreeRetire` result: the worktree, now `retired`, and the kept
 * copy when a discard kept one.
 */
export interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">;
  kept?: { removedWorktreeId: RemovedWorktreeId } | undefined;
}
/** Wire schema for {@link WorktreeRetireResponse}; single-T, since a response is not an input. */
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
    kept: z.object({ removedWorktreeId: RemovedWorktreeIdSchema }).strict().optional(),
  })
  .strict();

// The removal's refusal. A plain removal is refused while an agent runs in the
// tree (`root_busy`, naming the workspace that holds it), and when the tree has
// something to lose the confirm did not show (`has_changes`, carrying the risks
// as they stand now, so the confirm redraws them). Ignored files count as
// something to lose.

/** The code `repo.worktreeRetire` refuses with. */
export type WorktreeRetireConflictCode = "worktree.retire_conflict";
/** The code of {@link WorktreeRetireConflictCode}. */
export const WORKTREE_RETIRE_CONFLICT_CODE: WorktreeRetireConflictCode = "worktree.retire_conflict";

/** Why a removal was refused. */
export const WORKTREE_RETIRE_CONFLICT_REASONS = ["root_busy", "has_changes"] as const;
/** One of {@link WORKTREE_RETIRE_CONFLICT_REASONS}. */
export type WorktreeRetireConflictReason = (typeof WORKTREE_RETIRE_CONFLICT_REASONS)[number];

/**
 * What removing a tree would lose, each named in the confirm: uncommitted files,
 * ignored files (an `.env`, say) that would be destroyed, commits no
 * remote-tracking branch of the folder reaches, and the sessions standing in it.
 */
export interface WorktreeRemovalRisks {
  uncommittedFileCount: number;
  ignoredFileCount: number;
  unpushedCommitCount: number;
  occupyingSessionIds: SessionId[];
}
/** Wire schema for {@link WorktreeRemovalRisks}. */
export const WorktreeRemovalRisksSchema: z.ZodType<WorktreeRemovalRisks> = z
  .object({
    uncommittedFileCount: z.number().int().nonnegative(),
    ignoredFileCount: z.number().int().nonnegative(),
    unpushedCommitCount: z.number().int().nonnegative(),
    occupyingSessionIds: z.array(SessionIdSchema),
  })
  .strict();

/** The details a `worktree.retire_conflict` refusal carries, by its reason. */
export type WorktreeRetireConflictDetails =
  | { worktreeId: WorktreeId; reason: "root_busy"; holdingWorkspaceId: WorkspaceId }
  | { worktreeId: WorktreeId; reason: "has_changes"; risks: WorktreeRemovalRisks };
/** Wire schema for {@link WorktreeRetireConflictDetails}. */
export const WorktreeRetireConflictDetailsSchema: z.ZodType<WorktreeRetireConflictDetails> =
  z.discriminatedUnion("reason", [
    z
      .object({
        worktreeId: WorktreeIdSchema,
        reason: z.literal("root_busy"),
        holdingWorkspaceId: WorkspaceIdSchema,
      })
      .strict(),
    z
      .object({
        worktreeId: WorktreeIdSchema,
        reason: z.literal("has_changes"),
        risks: WorktreeRemovalRisksSchema,
      })
      .strict(),
  ]);

// --------------------------------------------------------------------------
// WorktreeStatusRead — `repo.worktreeStatusRead` (query).
// --------------------------------------------------------------------------
//
// The worktree switcher's one read, keyed by the project's folder: the repo-root
// row, every worktree of the project that is still standing, and the figures each
// row draws. One read rather than a status read beside a separate counts read,
// because a switcher composing its rows from two answers could draw a tree as
// free while the other called it occupied, and the trash lock is the control
// that must never be wrong.
//
// Only trees still standing are listed: a retired worktree's record keeps its
// provenance in the daemon, and a copy kept by a discard is listed by
// `repo.removedWorktreeList`. So a listed row never carries `retired`.

/** The state of a listed worktree: every state but `retired`. */
export type ListedWorktreeState = Exclude<WorktreeState, "retired">;

/**
 * One listed worktree, as its switcher row draws it.
 *
 * `name` is the tree's own name and `baseBranchName` the branch it was cut from
 * (`off <base>`). `ahead` and `behind` count commits against the branch's
 * upstream, read against the daemon's latest background fetch, and are absent
 * when the branch has none. `uncommittedFileCount` and `unpushedCommitCount` are
 * the same figures the removal confirm names; unpushed means not reachable from
 * any remote-tracking branch of the folder. `occupyingSessionIds` are the
 * sessions standing in the tree, and `runningSessionId` names the one whose
 * agent is running there, which locks the trash.
 */
export interface WorktreeStatusRecord {
  worktreeId: WorktreeId;
  repoMountId: RepoMountId;
  name: string;
  branchName: string;
  baseBranchName: string;
  fsRoot: string;
  state: ListedWorktreeState;
  ahead?: number | undefined;
  behind?: number | undefined;
  uncommittedFileCount: number;
  unpushedCommitCount: number;
  occupyingSessionIds: SessionId[];
  runningSessionId: SessionId | null;
  createdBySessionId: SessionId;
  createdByRunId?: RunId | undefined;
  createdAt: string;
  updatedAt: string;
}
const worktreeStatusRecordSchema: z.ZodType<WorktreeStatusRecord> = z
  .object({
    worktreeId: WorktreeIdSchema,
    repoMountId: RepoMountIdSchema,
    name: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusRecord.name"),
    branchName: wireFreeFormString(WORKTREE_GIT_REF_MAX_LEN, "WorktreeStatusRecord.branchName"),
    baseBranchName: wireFreeFormString(
      WORKTREE_GIT_REF_MAX_LEN,
      "WorktreeStatusRecord.baseBranchName",
    ),
    // A root under the daemon's worktrees folder, never a path inside the
    // attached checkout.
    fsRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusRecord.fsRoot"),
    state: WorktreeStateSchema.refine(
      (state): state is ListedWorktreeState => state !== "retired",
      "A retired worktree is not listed",
    ),
    ahead: z.number().int().nonnegative().optional(),
    behind: z.number().int().nonnegative().optional(),
    uncommittedFileCount: z.number().int().nonnegative(),
    unpushedCommitCount: z.number().int().nonnegative(),
    occupyingSessionIds: z.array(SessionIdSchema),
    runningSessionId: SessionIdSchema.nullable(),
    createdBySessionId: SessionIdSchema,
    // Absent for a tree prepared before any run, which has no run to attribute.
    createdByRunId: RunIdSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * `repo.worktreeStatusRead`: the project's folder whose worktrees are listed, and
 * the session asking, when one is. A session's switcher names itself, so the read
 * also answers the new-worktree form's suggestion for it.
 */
export interface WorktreeStatusReadRequest {
  repoMountId: RepoMountId;
  sessionId?: SessionId | undefined;
}
/** Wire schema for {@link WorktreeStatusReadRequest}. */
export const WorktreeStatusReadRequestSchema: z.ZodType<
  WorktreeStatusReadRequest,
  WorktreeStatusReadRequest
> = z
  .object({
    repoMountId: RepoMountIdSchema,
    sessionId: SessionIdSchema.optional(),
  })
  .strict();

/**
 * What the new-worktree form opens with, from the same daemon function that
 * creates the tree and names its folder: the fixed leading part of the name (the
 * project's branch pattern filled in up to `{title}`), the suggested tail derived
 * from the session's title, and the folder the tree will get up to that tail.
 * The form shows the folder as `folderBefore` followed by whatever tail is typed,
 * so it copies none of the daemon's naming.
 */
export interface NewWorktreeSuggestion {
  fixedPart: string;
  suggestedTail: string;
  folderBefore: string;
}

/**
 * The `repo.worktreeStatusRead` result.
 *
 * `repoRoot` is the project's own checkout and the branch it is on. `worktrees`
 * lists the project's standing trees, empty when it has none. `countsAsOf` is
 * present when the last background fetch failed, and says when the ahead and
 * behind figures were last true. `newWorktree` is present when the request named
 * the asking session.
 */
export interface WorktreeStatusReadResponse {
  repoRoot: { path: string; branchName: string };
  worktrees: WorktreeStatusRecord[];
  countsAsOf?: string | undefined;
  newWorktree?: NewWorktreeSuggestion | undefined;
}
/** Wire schema for {@link WorktreeStatusReadResponse}; single-T, since a read is not an input. */
export const WorktreeStatusReadResponseSchema: z.ZodType<WorktreeStatusReadResponse> = z
  .object({
    repoRoot: z
      .object({
        path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorktreeStatusReadResponse.repoRoot.path"),
        branchName: wireFreeFormString(
          WORKTREE_GIT_REF_MAX_LEN,
          "WorktreeStatusReadResponse.repoRoot.branchName",
        ),
      })
      .strict(),
    worktrees: z.array(worktreeStatusRecordSchema),
    countsAsOf: z.iso.datetime({ offset: true }).optional(),
    newWorktree: z
      .object({
        fixedPart: z.string().max(WORKTREE_GIT_REF_MAX_LEN),
        suggestedTail: wireFreeFormString(
          WORKTREE_GIT_REF_MAX_LEN,
          "WorktreeStatusReadResponse.newWorktree.suggestedTail",
        ),
        folderBefore: wireFreeFormString(
          FILE_PATH_MAX_LEN,
          "WorktreeStatusReadResponse.newWorktree.folderBefore",
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
