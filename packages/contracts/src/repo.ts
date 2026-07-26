// Repo-mount and workspace contracts — the branded `RepoMountId` /
// `WorkspaceId` scalars, the four canonical repo/workspace enums, the derived
// `RepoMountHealth` projection, and the shared repo/workspace/worktree
// lifecycle event payload for Plan-009 (Repo Attachment And Workspace
// Binding). Exact enum membership mirrors the canonical TypeScript shapes in
// `docs/architecture/contracts/api-payload-contracts.md §Shared Enums` and
// `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Repo Attachment And Workspace Binding`
// (verbatim — adding/removing/renaming a member here is a contract break and
// requires the spec edit first).
//
// CANONICAL ORIGIN (Plan-009 CP-009-1). This module owns `ExecutionMode`,
// `WorkspaceState`, `RepoMountState`, `VcsType`, `RepoMountHealth`, the
// branded `RepoMountId` / `WorkspaceId`, and `RepoWorkspaceLifecyclePayload`.
// Plan-010's `worktree.ts` MUST import them — never redefine — because
// Plan-009 ships first within Tier 6. The reciprocal boundary holds here too:
// `WorktreeId` and `WorktreeState` are Plan-010-owned and are deliberately
// NOT declared in this file (see the `worktreeId` / `state` notes on the
// lifecycle payload below).
//
// IMPORT DIRECTION IS ONE-WAY — this module imports NOTHING from `./event.js`.
// `event.ts` imports `RepoWorkspaceLifecyclePayloadSchema` from here to
// register the six Plan-009 variants into `SessionEventSchema` (CP-009-4), so
// a back-import would close a module cycle whose Zod const initialization
// order is unsound (the importer's `const` bindings sit in TDZ while this
// module's body evaluates). The one value that would otherwise be imported —
// event.ts's `EVENT_FIELD_MAX_LEN` — is therefore restated locally; see the
// cap declaration on the lifecycle payload below.
//
// THE RULE IS TRANSITIVE, and reads on the whole import CLOSURE: this module
// must import nothing that itself reaches `./event.js`, however many hops out.
// T1.2 found the gap — `NodeIdSchema` needed by the attach/read surfaces below
// lived in `runtime-node.ts`, which imports values FROM `event.ts`, so the
// direct import would have closed `repo.ts` → `runtime-node.ts` → `event.ts`
// → `repo.ts`. Every edge in that cycle is an eager module-scope Zod
// initializer, so it throws `ReferenceError` at import time from every entry
// point, and `tsc` does not flag it. The resolution was to hoist the `NodeId`
// declaration into the dependency-free leaf `./node-id.js` (Plan-003 still
// owns the shape) and import from there — NOT to restate the parser here, and
// NOT to weaken the field's brand. Before composing any new cross-module
// symbol below, check its closure the same way.
//
// Refs: Spec-009 (Repo Attachment And Workspace Binding), Spec-006 §Repo,
// Workspace, and Worktree Lifecycle (the shared payload shape), ADR-006
// (worktree-first execution mode), ADR-018 (versioning), ADR-022 (toolchain —
// Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
// DIRECT import from the `./node-id.js` leaf, never from `./runtime-node.js`
// (which re-exports the same three symbols): runtime-node.ts imports values
// from `./event.js`, and event.ts imports `RepoWorkspaceLifecyclePayloadSchema`
// from THIS module, so routing through it would close the eager three-hop
// cycle described in the header and throw at import time. Plan-003 still owns
// the shape — this is composition of another plan's canonical symbol, the
// CP-009-1 rule read in the reciprocal direction.
import { NodeIdSchema, type NodeId } from "./node-id.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Server-minted UUIDs, so both compose the `brandedUuidIdSchema` helper from
// `./internal/branded.js` (which encapsulates the
// `z.string().uuid().brand().as unknown as z.ZodType<T, T>` cast bridging
// Zod's single-T `$ZodBranded` output to the double-T shape tRPC v11's
// Standard-Schema-V1 input inference needs per ADR-014) — the same idiom as
// `SessionIdSchema` in session.ts. The contrast case is `NodeIdSchema`
// (node-id.js — Plan-003-owned), a daemon-assigned opaque scalar that
// deliberately departs from the UUID parser; `repo_mounts.id` and
// `workspaces.id` are ordinary UUID primary keys, so no departure applies
// here. Both are composed side by side on `RepoAttachRequest` below.
//
// The `z.ZodType<T, T>` double-T annotations are also what
// `--isolatedDeclarations` requires (TS9010 — exported declarations cannot
// rely on inferred types).

export type RepoMountId = string & { readonly __brand: "RepoMountId" };
export const RepoMountIdSchema: z.ZodType<RepoMountId, RepoMountId> =
  brandedUuidIdSchema<RepoMountId>("RepoMountId");

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export const WorkspaceIdSchema: z.ZodType<WorkspaceId, WorkspaceId> =
  brandedUuidIdSchema<WorkspaceId>("WorkspaceId");

// --------------------------------------------------------------------------
// Canonical enums (`docs/architecture/contracts/api-payload-contracts.md §Shared Enums`)
// --------------------------------------------------------------------------
//
// Membership of each set is the contract, not declaration order — RFC 8785
// JCS serializes the literal wire string, so order is not load-bearing, but
// additions are MINOR and removals MAJOR per ADR-018 §Decision #8 (same
// stance as `NodeState` in runtime-node.ts / `SessionState` in session.ts).

// `"ephemeral clone"` CONTAINS A SPACE — preserved verbatim from the
// canonical enum (`docs/architecture/contracts/api-payload-contracts.md §Shared Enums`),
// exactly as `MembershipRole`'s `"runtime contributor"` is in session.ts.
// This is the wire form; editing it to `"ephemeral_clone"` or
// `"ephemeral-clone"` is a contract break. The four members are the canonical
// execution-mode taxonomy `Spec-009 §Required Behavior` mandates for git-backed
// binding, per ADR-006's four-mode decision.
export type ExecutionMode = "read-only" | "branch" | "worktree" | "ephemeral clone";
export const ExecutionModeSchema: z.ZodType<ExecutionMode> = z.enum([
  "read-only",
  "branch",
  "worktree",
  "ephemeral clone",
]);

// The 5-value workspace lifecycle. `stale` is the availability-loss position
// (`Spec-009 §Fallback Behavior` — a workspace whose path becomes unavailable
// transitions to `stale` and write runs are blocked until repair); `busy` is
// the run-hold position Plan-009's `markBusy` / `releaseBusy` primitives own
// (CP-009-7). Aligned with the `workspaces.state` CHECK constraint in
// `docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`.
export type WorkspaceState = "provisioning" | "ready" | "busy" | "stale" | "archived";
export const WorkspaceStateSchema: z.ZodType<WorkspaceState> = z.enum([
  "provisioning",
  "ready",
  "busy",
  "stale",
  "archived",
]);

// The 3-value mount lifecycle. `detached` is TERMINAL for the row — re-attach
// creates a NEW mount row rather than reviving this one
// (`Spec-009 §Detach Semantics (V1 Definition)`, D-009-6), which is why the
// partial unique index on the canonical root filters `WHERE state =
// 'attached'` (D-009-7).
export type RepoMountState = "attached" | "detached" | "archived";
export const RepoMountStateSchema: z.ZodType<RepoMountState> = z.enum([
  "attached",
  "detached",
  "archived",
]);

// --------------------------------------------------------------------------
// VcsType — the honest non-git discriminator (I-009-4).
// --------------------------------------------------------------------------
//
// CLOSED 2-value union, no third member and no passthrough arm: this schema is
// the contract carrier of I-009-4 (honest non-git classification). A non-git
// path is classified `"none"` at resolution time and is never presented as a
// git mount — so a third "unknown"/"pending" member, or a tolerant
// `z.union([VcsTypeSchema, z.string()])` arm, would make exactly the
// misclassification the invariant forbids representable on the wire. The
// capability projection keys off this discriminator (D-009-5: `"git"` yields
// all four execution modes, `"none"` yields `["read-only"]` with a populated
// `restrictions` reason per excluded mode), so a wrong or widened value makes
// that projection lie about git-backed modes
// (`Spec-009 §Fallback Behavior`).
//
// Both values ride the SAME attach funnel (D-009-4, mount-first single
// funnel): `repo.attach` accepts any local path, and a non-git path yields a
// RepoMount with `vcsType: "none"` rather than a mount-less bind path.
// Canonical shape: `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Repo Attachment And Workspace Binding`.
export type VcsType = "git" | "none";
export const VcsTypeSchema: z.ZodType<VcsType> = z.enum(["git", "none"]);

// --------------------------------------------------------------------------
// RepoMountHealth — derived projection, never persisted (D-009-2).
// --------------------------------------------------------------------------
//
// Ratified shape: `{ status: "healthy" | "unreachable"; checkedAt: string }`
// (`docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Repo Attachment And Workspace Binding`;
// semantics in `Spec-009 §Repo Mount Health (V1 Definition)`). A render-ready
// discriminant plus the probe provenance that produced it.
//
// Three properties are load-bearing, and each is a deliberate rejection of a
// competing shape:
//   • NO `unknown` member. The on-read probe floor (D-009-5) synchronously
//     probes filesystem availability before every health-reporting read, so
//     every read carries a fresh verdict and there is no third state to
//     report. Admitting `unknown` would let a read answer "we did not check"
//     for a surface contractually obliged to check.
//   • `"unreachable"`, NOT `"stale"`. `stale` already names a WORKSPACE state
//     above; reusing it here would overload one vocabulary across two axes
//     (mount reachability vs workspace lifecycle) and make a `health.status`
//     of `"stale"` indistinguishable from a workspace-state leak.
//   • `checkedAt` is REQUIRED, not optional. A verdict with no probe
//     timestamp is unauditable — the reader cannot tell a fresh probe from a
//     cached one, which is the whole reason the field exists.
// NO `health` column lands in `repo_mounts`: `Spec-009 §State And Data
// Implications` pins health to projection state, not row state.
export interface RepoMountHealth {
  status: "healthy" | "unreachable";
  checkedAt: string;
}
// Single-T `z.ZodType<T>` — a derived read-side projection, never a tRPC input
// surface, so it needs no double-T input-inference bridge (matches
// `MembershipSummarySchema` in session.ts / `RuntimeNodeAttachResponseSchema`
// in runtime-node.ts).
export const RepoMountHealthSchema: z.ZodType<RepoMountHealth> = z
  .object({
    status: z.enum(["healthy", "unreachable"]),
    // ISO 8601 instant of the probe that produced the verdict.
    // `{ offset: true }` widens default Z-only acceptance to numeric RFC 3339
    // §5.6 offsets — the package-wide datetime convention (`createdAt` in
    // session.ts, `occurredAt` in event.ts, `attachedAt` in runtime-node.ts).
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// RepoWorkspaceLifecyclePayload — the FAMILY-SHARED event payload (CP-009-4).
// --------------------------------------------------------------------------
//
// `EventEnvelope.payload` shape for every type in
// `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`:
// `{sessionId, repoMountId?, workspaceId?, worktreeId?, state, actor?}`. That
// family registers ELEVEN types under ONE payload shape — the six Plan-009
// emits (`repo.attached`, `repo.detached`, `workspace.provisioning`,
// `workspace.ready`, `workspace.stale`, `workspace.archived`, registered into
// `SessionEventSchema` by this task per CP-009-4) plus the five `worktree.*`
// types Plan-010 registers later against this SAME schema (CP-010-5).
//
// FAMILY-SHARED CONSTRAINT. Because one schema serves all eleven, the SUBJECT
// of an event is identified by WHICH optional id it carries, not by a
// per-type payload shape: a mount event carries `repoMountId`, a workspace
// event carries `workspaceId`, a worktree event carries `worktreeId`. The
// schema imposes no cross-field requirement — Spec-006 marks all three
// optional, and inventing a "exactly one id" refinement here would reject the
// legitimately multi-id rows the detach cascade emits (a `workspace.archived`
// caused by `repo.detached` names both). Which id each type populates is the
// EMITTER's obligation (Plan-009 Phase 2 / Plan-010 Phase 2), enforced at the
// `.parse()` emission seam, not a shape rule.
//
// This is also why the payload is authored HERE rather than in event.ts:
// emitter-authors-payload, the Plan-003 precedent carried forward in Plan-006
// CP-006-5. Registration into the discriminated union stays Plan-006-owned.

// Bound on the free-form `actor` audit string. This MUST equal event.ts's
// `EVENT_FIELD_MAX_LEN` — `actor` is the same wire field as
// `EventEnvelope.actor`, and a payload-level cap that disagreed with the
// envelope-level one would accept an actor on one surface and reject it on
// the other. It is restated rather than imported ONLY because importing from
// `./event.js` would close the module cycle documented in this file's header;
// the equality is enforced behaviorally in `__tests__/repo.test.ts`, which
// imports the real `EVENT_FIELD_MAX_LEN` and pins the accept/reject boundary
// against it (a comment alone would be an unenforced pin).
const REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN = 256;

/**
 * Payload of every `Spec-006 §Repo, Workspace, and Worktree Lifecycle (session_lifecycle)`
 * event — see the family-shared note above — PARAMETERIZED by the state
 * vocabulary its emitting plan owns.
 *
 * The parameter exists so that no consuming plan has to edit this file. Every
 * field but `state` is identical across all eleven types; `state` is the one
 * axis that differs, and it differs per OWNING PLAN rather than per event. See
 * `buildRepoWorkspaceLifecyclePayloadSchema` for why parameterizing beats the
 * third-union-arm alternative.
 *
 * Declared as a TYPE ALIAS, not an `interface`, and that is load-bearing: the
 * six variant interfaces in event.ts narrow `EventEnvelope.payload`, which is
 * typed `Record<string, unknown>`. TypeScript grants an implicit index
 * signature to an object type alias but NOT to an interface, so an interface
 * here would fail the `extends EventEnvelope` narrowing with "index signature
 * is missing". (runtime-node.ts's payloads are interfaces because they are
 * standalone `.parse()` shapes that never narrow the envelope member.)
 *
 * Optional fields are typed `key?: T | undefined` (not bare `key?:`): Zod's
 * `.optional()` infers `T | undefined`, and with no `as unknown as` cast
 * TypeScript checks the alias against the schema's inferred output exactly
 * under `exactOptionalPropertyTypes` (the same stance as `ChannelSummary.name`
 * in session.ts). The wire signal is still "key absent" — consumers that need
 * the absent-vs-undefined distinction can test `"workspaceId" in payload`.
 */
export type RepoWorkspaceLifecyclePayloadOf<TState extends string> = {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
  worktreeId?: string | undefined;
  state: TState;
  actor?: string | null | undefined;
};

/**
 * The Plan-009 instantiation — the two vocabularies THIS plan emits. Named
 * separately because it is the shape event.ts's six variant interfaces narrow
 * against, and because `RepoWorkspaceLifecyclePayload` is the name every
 * existing consumer already imports.
 */
export type RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<
  RepoMountState | WorkspaceState
>;
/**
 * Build the family payload schema over ONE plan's state vocabulary.
 *
 * Exported because Plan-010 needs it: CP-010-5 registers five `worktree.*`
 * types against this family, and D-010-12 gives them a vocabulary
 * (`creating` / `dirty` / `merged` / `retired`) that overlaps the two below at
 * `ready` alone. Plan-010 calls this factory with its own `WorktreeStateSchema`
 * from `worktree.ts` and registers the result — payload schemas stay in the
 * EMITTER's domain file, which is exactly what the additive
 * `SessionEventSchema` union-registration seam
 * (`docs/architecture/cross-plan-dependencies.md`) says each event-emitting
 * plan does.
 *
 * NO THIRD UNION ARM, not now and not later — the alternative this factory
 * exists to refuse, and it fails on three independent grounds:
 *
 *   • CYCLE. Adding `WorktreeStateSchema` to the `state` union here means
 *     repo.ts importing from worktree.ts, while CP-009-1 makes worktree.ts
 *     import FROM repo.ts. That is the eager module-scope Zod cycle this
 *     file's header describes — the one the `node-id.js` relocation was cut
 *     to break — and `tsc` does not flag it.
 *   • ACCEPT SET. One shared union widens ALL eleven types at once: a
 *     `workspace.archived` payload could then claim `state: "merged"`, and a
 *     `worktree.retired` could claim `"provisioning"`. Parameterizing keeps
 *     each plan's accept set exactly its own vocabulary — strictly tighter
 *     than today for the worktree half, and unchanged for this one.
 *   • OWNERSHIP. The dependency map's registered seam classes do not sanction
 *     Plan-010 editing repo.ts, and its own entry says it "never redefines"
 *     Plan-009's symbols. A third arm would need precisely that edit.
 *
 * Adding this export is additive-MINOR under ADR-018 §Decision #8: no member
 * is removed, no field reshaped, and `RepoWorkspaceLifecyclePayloadSchema`
 * below is byte-for-byte the same accept set it was before the refactor.
 * Plan-009 T1.1's boundary is untouched — `WorktreeId` and `WorktreeState`
 * remain Plan-010-owned and are still NOT declared in this file.
 *
 * The return type is the erased `z.ZodType<…>`, not a `ZodObject`, and that is
 * sufficient: consumers `.parse()` the result and register it into the event
 * union. Nothing extends it — a plan that needs different FIELDS has a
 * different payload family, not a widened one.
 */
export function buildRepoWorkspaceLifecyclePayloadSchema<TState extends string>(
  stateSchema: z.ZodType<TState>,
): z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState>> {
  return z
    .object({
      // REQUIRED — Spec-006 spells the family base `{sessionId, …}` with no
      // `?`, unlike the `sessionId?` base of the runtime-node family. Every
      // repo/workspace/worktree subject is session-scoped, so there is no
      // session-less row to represent. Duplicates the envelope's `sessionId`,
      // exactly as `session.created`'s payload does (projector convenience).
      sessionId: SessionIdSchema,
      repoMountId: RepoMountIdSchema.optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      // PLAIN CANONICAL-UUID STRING, deliberately NOT a branded `WorktreeId`:
      // that brand is Plan-010-owned per Plan-009 T1.1's own task text, and
      // minting it here would pre-empt the owning plan's declaration (CP-009-1
      // makes this file the canonical origin Plan-010 imports FROM, not a place
      // to declare Plan-010's symbols). The parser is the
      // same `z.string().uuid()` the branded ids compose through
      // `brandedUuidIdSchema`, so the RUNTIME accept-set is already identical —
      // only the compile-time brand is absent, and Plan-010 can narrow at its
      // own consumption site without a wire change. Representable NOW so
      // CP-010-5's registration is purely additive.
      worktreeId: z.string().uuid().optional(),
      // The subject's post-transition state — THE PARAMETER, and the only
      // field that varies across the family. Each caller supplies the
      // vocabulary its own plan owns; see this function's note on why that is
      // a parameter rather than an ever-widening union.
      state: stateSchema,
      // The EventEnvelope free-form actor (`participant_id | agent_id | null`),
      // carried at payload level IN ADDITION to the envelope's own `actor` —
      // the family payload shape spells it, the same way it re-spells
      // `sessionId`. Realized with the package's standard
      // `wireFreeFormString` (length cap + whitespace-only rejection + NUL-byte
      // rejection at the wire/replay trust boundary), matching
      // `buildCommonShape()`'s envelope actor and runtime-node.ts's
      // payload-level actors. `.nullable()` composes AFTER the helper so the
      // string checks run only on string values; a system-emitted event uses
      // `null` or omits the key, never an empty string.
      actor: wireFreeFormString(
        REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN,
        "RepoWorkspaceLifecyclePayload.actor",
      )
        .nullable()
        .optional(),
    })
    .strict();
}

// Single-T `z.ZodType<T>`, `.strict()` — a non-input event payload,
// constructed daemon-side and validated at the emission boundary with
// `.parse()`, never a tRPC request input (the same typing stance as
// runtime-node.ts's `runtime_node.*` payload schemas). `.strict()` is the
// house posture for a `session_lifecycle` payload: unknown keys are schema
// drift surfaced at parse time. (The non-strict carve-out
// `Spec-006 §Artifact and Diff Publication (artifact_publication)` mandates is
// scoped to `artifact.*` payloads and does not reach this family.)
//
// The two Plan-009 vocabularies are composed from the enum schemas above
// rather than re-typed as a combined seven-literal `z.enum`, so a change to
// either enum propagates here instead of drifting (`"archived"` is a member of
// both and collapses in the union). This is the schema event.ts registers for
// all six Plan-009 types (CP-009-4).
export const RepoWorkspaceLifecyclePayloadSchema: z.ZodType<RepoWorkspaceLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(z.union([RepoMountStateSchema, WorkspaceStateSchema]));

// ==========================================================================
// Wire surfaces — RepoAttach / RepoMountRead / RepoDetach (Plan-009 T1.2).
// ==========================================================================
//
// The three request/response pairs for the MOUNT half of Plan-009's six
// `repo.*` methods — `repo.attach` (mutation), `repo.mountRead` (query),
// `repo.detach` (mutation) per D-009-1. The workspace half
// (`repo.workspaceBind`, `repo.executionModeCapabilitiesRead`,
// `repo.workspaceList`) is T1.3's surface and is deliberately absent here.
//
// Field sets are transcribed from
// `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Repo Attachment And Workspace Binding`
// (verbatim — adding/removing/renaming a field is a contract break and
// requires the doc edit first) and satisfy the field requirements in
// `Spec-009 §Interfaces And Contracts` (RepoAttach accepts a local path,
// session id, and owning runtime node; RepoMountRead exposes canonical root,
// VCS metadata, and current health) plus
// `Spec-009 §Detach Semantics (V1 Definition)` (RepoDetach accepts a repo
// mount id and transitions the mount to `detached`). Every shape composes the
// T1.1 enums / branded ids / `RepoMountHealth` above rather than re-spelling
// them — the CP-009-1 canonical-origin rule.
//
// TRANSPORT. All six methods ride the daemon JSON-RPC transport ONLY: repo
// mounts and workspaces are node-local filesystem state (ADR-004), so no
// control-plane tRPC sibling exists (`Plan-009 §API And Transport Changes`),
// and the names register under the Plan-007-partial `MethodRegistry`
// (CP-009-5). I-009-10 makes BOTH directions validated — the substrate
// `.parse()`s inbound params against the request schema before the handler
// runs, and the handler's result against the response schema before it reaches
// the wire.
//
// TYPING — REQUESTS are double-T `z.ZodType<T, T>`, RESPONSES are single-T
// `z.ZodType<T>`. Grounded in how the substrate actually consumes them rather
// than in file-wide uniformity. `MethodRegistry.register` (jsonrpc-registry.ts)
// declares `paramsSchema: ZodType<P>` and `resultSchema: ZodType<R>` — both
// single-T slots — and the live `session.read` registration passes a double-T
// request schema alongside a single-T response schema into exactly those slots
// (`packages/runtime-daemon/src/ipc/handlers/session-read.ts`). That is the
// closest precedent available: `session.*` is a daemon JSON-RPC namespace, not
// a tRPC router. Double-T satisfies the single-T slot for free — Zod 4 declares
// `ZodType<out Output, out Input>`, so `ZodType<T, T>` is assignable to
// `ZodType<T, unknown>` — which means the request side keeps the package-wide
// `*RequestSchema` idiom, and its Standard-Schema-V1 input inference stays
// available to any later typed-SDK consumer (ADR-014), at no cost here.
//
// The response side is single-T for the reason every response schema in
// session.ts / runtime-node.ts is: a response is not an input surface. It is
// also the CAST-FREE choice — `RepoMountReadResponseSchema` composes T1.1's
// single-T `RepoMountHealthSchema`, whose `Input` slot is `unknown`, so a
// double-T response annotation would need an `as unknown as` bridge to express
// nothing extra. The rejected alternative was presence.ts's uniform-double-T
// file style, which its own `PresenceSubscribeRequestSchema` comment concedes
// is "for file-wide annotation uniformity, not a live tRPC-input requirement".
//
// None of the three request schemas needs the `as unknown as z.ZodType<T, T>`
// bridge that runtime-node.ts's request schemas carry. Every member composed
// below is either double-T (`SessionIdSchema`, `NodeIdSchema`,
// `RepoMountIdSchema`) or a `z.ZodString` (`wireFreeFormString`, whose `Input`
// slot is `string`, not `unknown`), so no single-T member contributes an
// `unknown` input slot to poison the composed object's inference — the same
// structural condition under which `RuntimeNodeDetachRequestSchema` and
// `RuntimeNodeRosterRequestSchema` compile bridge-free.

// Bound on the two filesystem-path wire strings these surfaces carry:
// `RepoAttachRequest.localPath` (inbound, caller-supplied) and the
// `canonicalRoot` / `localPath` the attach + read responses return. 4096 is
// Linux's `PATH_MAX` — the most generous of the supported platforms' limits
// (macOS caps at 1024; Windows' long-path form runs far higher but the ADR-019
// V1 tier needs no such headroom) — so no legitimate path is refused on
// wire-length grounds. Defense-in-depth at the wire/IPC trust boundary, the
// same posture as `NODE_ID_MAX_LEN` / `EVENT_CURSOR_MAX_LEN`; the framework
// body-size cap (Plan-004/Plan-005) remains the authoritative limit.
//
// EXPORTED, unlike T1.1's module-local `REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN`
// — that cap MIRRORS an authority that lives elsewhere (event.ts's exported
// `EVENT_FIELD_MAX_LEN`) and is pinned to it by test, whereas this constant IS
// the authority for its fields. Exporting matches every other `*_MAX_LEN` in
// the package and lets `__tests__/repo.test.ts` assert the accept/reject
// boundary against the named constant instead of a magic number. T1.3 REUSED
// this constant for `WorkspaceBindRequest.directory` rather than minting a
// second cap; the joined-path reasoning is on that field's declaration.
export const REPO_PATH_MAX_LEN = 4096;

// --------------------------------------------------------------------------
// RepoAttach — `repo.attach` (mutation).
// --------------------------------------------------------------------------
//
// The envelope-admission action: attach is the ONLY way a path enters the
// session's declared local trust envelope
// (`Spec-009 §Local Trust Envelope (V1 Definition)` — "no path enters the
// envelope implicitly"). It is also a SINGLE FUNNEL (D-009-4): a non-git path
// rides this same method and yields a mount with `vcsType: "none"`, rather
// than a mount-less bind path.

export interface RepoAttachRequest {
  sessionId: SessionId;
  localPath: string;
  nodeId: NodeId;
}
export const RepoAttachRequestSchema: z.ZodType<RepoAttachRequest, RepoAttachRequest> = z
  .object({
    sessionId: SessionIdSchema,
    // USER-ENTERED PATH, provenance only — persisted as
    // `repo_mounts.local_path` and never used as the canonical root (I-009-5:
    // trust-envelope enforcement and node-ownership routing key off
    // `canonical_root`, never `local_path`).
    //
    // Realized with the package's standard `wireFreeFormString` (length cap +
    // whitespace-only rejection + NUL-byte rejection). The NUL guard is the
    // load-bearing one on a PATH: an embedded NUL is a classic truncation
    // vector as well as the log-injection vector the helper documents.
    //
    // THREE CHECKS DELIBERATELY NOT MADE HERE, each for its own reason:
    //   • Absoluteness. A `startsWith("/")` test would refuse every Windows
    //     path (`C:\repos\foo`), and Windows is a V1 tier (ADR-019); a
    //     cross-platform absoluteness rule is exactly the normalization
    //     I-009-1 assigns to the daemon resolver — which APPLIES that rule
    //     rather than relaxing it: `RepoRootResolver` refuses with typed
    //     `not_absolute` any input that does not name one COMPLETE location.
    //     That is three shapes, not one: a relative path, a `~`-prefixed path,
    //     and a driveless Windows root such as `\repos\foo` (which
    //     `path.win32.isAbsolute` calls absolute while it names no volume).
    //     Completing any of them would mean taking the missing piece from
    //     daemon-side state — its working directory, its home, its current
    //     drive — and under the cross-node model (`nodeId` below) that is not
    //     the author's context, so the root would be a guess, which I-009-2
    //     forbids. All three therefore fail LOUDLY; resolving them against the
    //     author's context belongs to the client/CLI layer, before the path
    //     reaches the wire. They stay
    //     REPRESENTABLE here anyway, because refusing them at parse time would
    //     mean spelling absoluteness in Zod for every platform, and that is
    //     the resolver's job. `Spec-009 §Implementation Notes` separately
    //     warns that attach must not assume the entered path is even the repo
    //     root.
    //   • `..` traversal. Rejecting it here would refuse the legitimate
    //     `/home/me/../me/repo`. Traversal is a CONTAINMENT concern, checked
    //     post-resolution against the mount root by T1.6's validator
    //     (I-009-3); `Spec-009 §Local Trust Envelope (V1 Definition)` scopes
    //     that check to `WorkspaceBind`'s `directory`, not to the
    //     envelope-ADMITTING attach path.
    //   • Existence / readability. A filesystem probe belongs to the resolver,
    //     and a missing path is the typed `repo.root_resolution_failed`
    //     refusal (I-009-2), not a parse error.
    // ACCEPTED TRADE-OFF: the helper's `/\S/` guard refuses a whitespace-only
    // path, which is a technically legal POSIX filename. A path that is
    // nothing but spaces is far likelier to be a UI-submission bug than an
    // intended target, so the guard stays.
    localPath: wireFreeFormString(REPO_PATH_MAX_LEN, "RepoAttachRequest.localPath"),
    // The OWNING runtime node — the node that can actually reach the
    // filesystem path (`Spec-009 §Implementation Notes`), persisted as
    // `repo_mounts.node_id`. Load-bearing beyond provenance: the D-009-7
    // active-root uniqueness index is keyed `(session_id, node_id,
    // canonical_root)`, because the same absolute path on two different nodes
    // names two distinct node-local filesystems and both may attach.
    nodeId: NodeIdSchema,
  })
  .strict();

export interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string;
  defaultWorkspaceId: WorkspaceId;
}
// Single-T — a response is not an input surface (see the typing note above).
export const RepoAttachResponseSchema: z.ZodType<RepoAttachResponse> = z
  .object({
    repoMountId: RepoMountIdSchema,
    // The mount's post-attach lifecycle position. Composes the full 3-value
    // `RepoMountStateSchema` and is NOT narrowed to `z.literal("attached")`:
    // the wire doc types this field `RepoMountState` with no narrowing and no
    // per-value gloss on THIS row (the detach response does carry one), so a
    // literal would silently reject the other two lawful states. It would also
    // re-type the field on any later attach path that returns a non-`attached`
    // row, which is a wire break rather than the additive change
    // ADR-018 §Decision #8 would want.
    state: RepoMountStateSchema,
    // The honest git/non-git verdict fixed at resolution time (I-009-4); the
    // D-009-5 capability projection keys off it downstream.
    vcsType: VcsTypeSchema,
    // RESOLVER OUTPUT — absolute and symlink-resolved, NEVER the echoed
    // `localPath` input (I-009-1). This is the value the trust envelope and
    // the D-009-7 active-root uniqueness index key off. REQUIRED: an attach
    // response with no resolved root is unrepresentable, because resolution
    // failure ABORTS attach with typed `repo.root_resolution_failed` rather
    // than returning a partial success (I-009-2).
    canonicalRoot: wireFreeFormString(REPO_PATH_MAX_LEN, "RepoAttachResponse.canonicalRoot"),
    // REQUIRED, not optional — D-009-7: attach unconditionally creates the
    // default read-only workspace, for git and non-git mounts alike
    // (`Spec-009 §Default Behavior`). Optionality would make "attached, but no
    // workspace" representable, and the persistence model never produces it.
    defaultWorkspaceId: WorkspaceIdSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// RepoMountRead — `repo.mountRead` (query).
// --------------------------------------------------------------------------

export interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
export const RepoMountReadRequestSchema: z.ZodType<RepoMountReadRequest, RepoMountReadRequest> = z
  .object({
    repoMountId: RepoMountIdSchema,
  })
  .strict();

export interface RepoMountReadResponse {
  id: RepoMountId;
  sessionId: SessionId;
  nodeId: NodeId;
  localPath: string;
  canonicalRoot: string;
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth;
  attachedAt: string;
}
// Single-T — a read projection, never an input surface.
export const RepoMountReadResponseSchema: z.ZodType<RepoMountReadResponse> = z
  .object({
    // BARE `id`, NOT `repoMountId` — transcribed verbatim from the wire doc,
    // which uses the unqualified `id` on READ PROJECTIONS (the convention
    // `WorkspaceListResponse.workspaces[].id` follows too) and the qualified
    // name on the attach/detach MUTATION responses. The asymmetry is
    // deliberate: a projection names its own row's key `id`, while a mutation
    // response names the entity it acted on. Do not "fix" it to `repoMountId`.
    id: RepoMountIdSchema,
    sessionId: SessionIdSchema,
    nodeId: NodeIdSchema,
    // Provenance and resolved identity travel TOGETHER and independently
    // (I-009-5 — both values are meaningful: the entered path is what the user
    // recognizes, the canonical root is what the system trusts). Attaching
    // from a nested subdirectory is the case that separates them.
    localPath: wireFreeFormString(REPO_PATH_MAX_LEN, "RepoMountReadResponse.localPath"),
    canonicalRoot: wireFreeFormString(REPO_PATH_MAX_LEN, "RepoMountReadResponse.canonicalRoot"),
    vcsType: VcsTypeSchema,
    state: RepoMountStateSchema,
    // The D-009-2 DERIVED projection — probed at read time, never a
    // `repo_mounts` column. REQUIRED: `Spec-009 §Interfaces And Contracts`
    // obliges this read to expose "current health", and the D-009-5 on-read
    // probe floor means every health-reporting read carries a fresh verdict,
    // so there is no "health not computed" case to represent. Composes T1.1's
    // `RepoMountHealthSchema` rather than re-spelling `{status, checkedAt}`,
    // so the 2-value status union cannot drift between the two surfaces.
    health: RepoMountHealthSchema,
    // `repo_mounts.attached_at`. ISO 8601 with `{ offset: true }` — the
    // package-wide datetime convention (`checkedAt` above, `createdAt` in
    // session.ts, `attachedAt` on runtime-node.ts's attach response).
    attachedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// RepoDetach — `repo.detach` (mutation).
// --------------------------------------------------------------------------
//
// `Spec-009 §Detach Semantics (V1 Definition)` / D-009-6. Detach is REFUSED
// with typed `repo.detach_conflict` while any dependent workspace is `busy`
// (there is no force-detach in V1), so the refusal carries no shape here — it
// is an error envelope, not a response variant. On the success path the mount
// transitions to the TERMINAL `detached` state (no `detached -> attached`
// transition exists; re-attaching the same canonical root creates a NEW mount
// row) and every dependent workspace is archived by the cascade.

export interface RepoDetachRequest {
  repoMountId: RepoMountId;
}
export const RepoDetachRequestSchema: z.ZodType<RepoDetachRequest, RepoDetachRequest> = z
  .object({
    repoMountId: RepoMountIdSchema,
  })
  .strict();

export interface RepoDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  archivedWorkspaceIds: WorkspaceId[];
}
// Single-T — a response is not an input surface.
export const RepoDetachResponseSchema: z.ZodType<RepoDetachResponse> = z
  .object({
    repoMountId: RepoMountIdSchema,
    // Full `RepoMountStateSchema`, NOT `z.literal("detached")` — the same
    // stance as `RepoAttachResponse.state` above: the wire doc types the field
    // `RepoMountState` and its `// 'detached'` comment glosses the value the
    // daemon writes, rather than narrowing the contract.
    state: RepoMountStateSchema,
    // One id per workspace the cascade archived — the detach half of I-009-9
    // (each archived workspace also emits its own `workspace.archived` event,
    // and `repo.detached` accompanies them). An EMPTY array is VALID and is
    // not degenerate: a mount whose dependent workspaces were all already
    // `archived` archives none. Hence no `.min(1)`, even though D-009-7
    // guarantees attach created at least one workspace to begin with.
    archivedWorkspaceIds: z.array(WorkspaceIdSchema),
  })
  .strict();

// ==========================================================================
// Wire surfaces — WorkspaceBind / WorkspaceExecutionModeCapabilitiesRead /
// WorkspaceList (Plan-009 T1.3).
// ==========================================================================
//
// The three request/response pairs for the WORKSPACE half of Plan-009's six
// `repo.*` methods — `repo.workspaceBind` (mutation),
// `repo.executionModeCapabilitiesRead` (query), `repo.workspaceList` (query)
// per D-009-1, completing the mount half above.
//
// Field sets are transcribed from
// `docs/architecture/contracts/api-payload-contracts.md §Plan-009 — Repo Attachment And Workspace Binding`
// (verbatim — adding/removing/renaming a field is a contract break and
// requires the doc edit first) and satisfy three
// `Spec-009 §Interfaces And Contracts` requirements: `WorkspaceBind` "must
// accept repo mount or directory root plus intended execution mode from the
// canonical mode set"; `WorkspaceExecutionModeCapabilitiesRead` "must expose
// which execution modes are currently valid for the bound repo mount or
// workspace"; `WorkspaceList` "must expose workspace health and current
// binding state". Every shape composes T1.1's enums and branded ids rather
// than re-spelling them — the CP-009-1 canonical-origin rule.
//
// The TRANSPORT and TYPING notes on the T1.2 block above govern these three
// unchanged: daemon JSON-RPC only (no control-plane tRPC sibling), requests
// double-T `z.ZodType<T, T>`, responses single-T `z.ZodType<T>`, and I-009-10
// validates BOTH directions. The one departure is
// `WorkspaceBindRequestSchema`, which needs the `as unknown as` bridge T1.2's
// three requests did not; its own comment carries the mechanism.
//
// NO CROSS-FIELD REFINEMENTS ON THE THREE CONDITIONAL FIELDS — a deliberate
// boundary, not an omission. Three conditional relationships are real:
// `restrictions` names every mode absent from `availableModes` (I-009-8),
// `lastError` is present iff the workspace went `stale` from a recorded
// failure, and `fsRoot` is absent while a workspace is `provisioning`. All
// three are plain-optional in the canonical wire doc, and all three are
// EMITTER obligations discharged at the `.parse()` boundary of the surface
// that produces them (Phase 2 T2.4 / T2.5) — the same stance the
// family-shared lifecycle payload above takes on which subject id each event
// type populates. Spelling them as refinements here would reject shapes the
// wire doc permits and would make T2.5's I-009-8 test vacuous, since the
// schema would be asserting what the test exists to prove. The ONE cross-field
// rule that is genuinely a shape constraint — exactly one of `repoMountId` /
// `workspaceId` on the capabilities read — is a refinement below, because the
// wire doc mandates it there by name.

// Bound on the per-mode reason strings in
// `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions`. 512 is this
// package's SHORT-HUMAN-REASON class (`RUNTIME_NODE_DETACH_REASON_MAX_LEN`,
// `RUNTIME_NODE_CAPABILITY_UPDATE_REASON_MAX_LEN`, `INVITE_REVOKE_REASON_MAX_LEN`),
// which is the right class here: V1's matrix is STATIC by `vcs_type` (D-009-5),
// so these values are short daemon-authored explanations such as "no git
// repository at the mount root", never captured subprocess output.
export const EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN = 512;

// Bound on `WorkspaceListResponse.workspaces[].lastError`. DELIBERATELY a
// different, far more generous class than the restriction reason above:
// `lastError` records the detail of a FAILED mode switch
// (`Spec-009 §Execution Mode Transitions` — "an error detail recorded in the
// workspace's metadata"), which in practice is captured git/provisioning
// output, not a curated sentence. The cap must be generous because the two
// sides fail asymmetrically: an over-sized cap costs bytes on a rare failure
// row, while an under-sized one makes a LAWFUL daemon list response
// unrepresentable — I-009-10 validates responses too, so the daemon could not
// report the failure it just recorded. That asymmetry is what picks the
// generous side.
// 8192 matches the package's error-message class (`ERROR_MESSAGE_MAX_LEN` in
// error.ts) rather than the far larger single-item `DRIVER_FAILURE_DETAIL_MAX_LEN`,
// because this field MULTIPLIES across a list projection. The value is
// restated rather than imported: `lastError` is workspace metadata, not the
// error envelope's `message`, so binding the two would assert an equality
// neither contract owes the other (contrast
// `REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN` above, which does mirror an
// authority elsewhere and is pinned to it by test).
//
// TWO PHASE-2 OBLIGATIONS, IN THIS ORDER, named here because this is where the
// bound is defined and the contract layer can discharge neither. Both fall on
// Plan-009 Phase 2 T2.4 (`workspace-service.ts`, whose CP-009-2
// `failReprovision` writes `metadata.lastError`) — named by task because "the
// emitter" in this file means T2.2's workspace-event emitter, which never
// writes this field.
//
//   1. SCRUB. A failing `ephemeral clone` against an authenticated remote can
//      echo a token-bearing remote URL into stderr; a cap this generous
//      carries it verbatim into unencrypted `workspaces.metadata` and
//      re-broadcasts it on every `repo.workspaceList` read. Captured
//      provisioning output MUST be credential-scrubbed before it is persisted.
//   2. TRUNCATE, to this constant, at PERSIST time. The cap is not only a wire
//      bound: nothing else in the model enforces it — `workspaces.metadata`
//      carries no length CHECK
//      (`docs/architecture/schemas/local-sqlite-schema.md §Workspace and Git Tables (Plan-009, Plan-010, Plan-011)`)
//      — so an unbounded stderr capture persists intact and then fails
//      response validation on the way out. Because I-009-10 validates
//      responses too, that makes every subsequent `repo.workspaceList` call
//      unrepresentable, not just the one row: a single verbose provisioning
//      failure takes down the whole list surface until the row is repaired.
//
// The ORDER is load-bearing, and it is the reason these are one numbered rule
// rather than two independent notes. Truncating first can cut a secret in
// half, leaving a fragment the scrubber's pattern no longer matches — the
// scrub then passes over a string that still leaks. Scrubbing first cannot
// have the reciprocal failure: truncation after redaction can only remove
// already-safe bytes.
export const WORKSPACE_LAST_ERROR_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// WorkspaceBind — `repo.workspaceBind` (mutation).
// --------------------------------------------------------------------------
//
// MOUNT-FIRST SINGLE FUNNEL (D-009-4). `Spec-009 §Interfaces And Contracts`
// says bind accepts "repo mount or directory root"; the directory-root arm is
// satisfied by first attaching the directory as a plain-directory mount
// (`vcsType: "none"`) through `repo.attach`, so this request identifies its
// target by `repoMountId` and by nothing else. There is deliberately NO
// `localPath` arm: `workspaces.repo_mount_id` is NOT NULL, there is no
// mount-less workspace, and a second identifying field here would reopen
// exactly the second envelope-admission door D-009-4 closed
// (`Spec-009 §Local Trust Envelope (V1 Definition)` — "no path enters the
// envelope implicitly").

export interface WorkspaceBindRequest {
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string | undefined;
}
// The `as unknown as z.ZodType<T, T>` bridge — the one departure from T1.2's
// bridge-free request stance, and it is structural, not stylistic. Every
// member T1.2's requests compose is either double-T (`SessionIdSchema`,
// `NodeIdSchema`, `RepoMountIdSchema`) or a `z.ZodString`, so none contributes
// an `unknown` input slot. `ExecutionModeSchema` is SINGLE-T (declared
// `z.ZodType<ExecutionMode>` above — its `Input` slot defaults to `unknown`),
// and `$ZodTypeInternals` declares `Input` covariant, so the composed object's
// input infers `executionMode: unknown`, which is not assignable to the
// double-T annotation's `WorkspaceBindRequest`. This is the identical
// mechanism that puts the bridge on `RuntimeNodeAttachRequestSchema` in
// runtime-node.ts (single-T `RuntimeNodeHealthStateSchema` member). We bridge
// at the CONSUMPTION site rather than re-annotating the shared canonical
// `ExecutionModeSchema`: its other consumers are typed against the single-T
// form, and re-annotation is a T1.1-owned change outside this task.
export const WorkspaceBindRequestSchema: z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest> = z
  .object({
    repoMountId: RepoMountIdSchema,
    // REQUIRED and NOT `.default("read-only")` — the T1.3 acceptance criterion
    // is that binding is representable only with an EXPLICIT mode from the
    // canonical set. Two independent reasons the default was rejected. First,
    // semantic: a wire-level default makes "caller omitted the mode" and
    // "caller chose read-only" indistinguishable, and
    // `Spec-009 §Default Behavior`'s read-only initial posture is already the
    // `workspaces.execution_mode` DDL default (D-009-7) — daemon-side row
    // state, not a wire coercion. Second, mechanical: `.default()` is a
    // transform, so Input would stop equalling Output and the double-T
    // annotation this file's typing note relies on would no longer be
    // truthful.
    executionMode: ExecutionModeSchema,
    // MOUNT-ROOT-RELATIVE subdirectory — a subtree of the mount's canonical
    // root, never an absolute path. OPTIONAL: omission binds the mount root
    // itself, which is the D-009-7 default-workspace case.
    //
    // CONTAINMENT IS NOT CHECKED HERE, and `../../etc` is representable on
    // this field on purpose. I-009-3 is enforced by T1.6's trust-envelope
    // validator, which joins this value onto the canonical root, re-resolves
    // symlinks, and re-checks containment AFTER resolution —
    // `Spec-009 §Local Trust Envelope (V1 Definition)` scopes that check to
    // exactly this field. A `..`-rejecting regex here would be simultaneously
    // insufficient (a symlink inside the mount escapes the envelope without a
    // single `..`) and over-broad (`docs/../packages` names a legitimate
    // subtree), so it would trade a sound post-resolution check for a
    // bypassable pre-resolution one — the same reasoning that keeps traversal
    // off `RepoAttachRequest.localPath` above.
    //
    // The cap REUSES `REPO_PATH_MAX_LEN` instead of minting the separate
    // constant T1.2's note anticipated. The honest bound on a relative segment
    // is the same PATH_MAX ceiling: what the filesystem actually bounds is the
    // joined `canonicalRoot + directory`, and the schema cannot see the root's
    // length at parse time, so any tighter number would be invented. A second
    // constant holding the same 4096 would be two values obliged to stay equal
    // with nothing enforcing the equality.
    directory: wireFreeFormString(REPO_PATH_MAX_LEN, "WorkspaceBindRequest.directory").optional(),
  })
  .strict() as unknown as z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest>;

export interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  fsRoot?: string | undefined;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}
// Single-T — a response is not an input surface (see the T1.2 typing note).
export const WorkspaceBindResponseSchema: z.ZodType<WorkspaceBindResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // OPTIONAL, and the optionality is load-bearing rather than defensive: a
    // WRITABLE bind returns BEFORE its execution root exists. The workspace is
    // created `provisioning` and Plan-010 fills `fs_root` at provisioning
    // completion (`Spec-009 §Execution Mode Transitions`), so a REQUIRED
    // `fsRoot` would make the `provisioning` response unrepresentable and
    // force the daemon to either block the bind until provisioning finished or
    // return a placeholder root — a guess, which I-009-2 forbids. A READ-ONLY
    // bind has its root immediately (the mount's canonical root) and populates
    // the field on the same response. Which of the two cases applies is the
    // emitter's obligation, not a shape rule — see the no-cross-field-
    // refinements note above.
    fsRoot: wireFreeFormString(REPO_PATH_MAX_LEN, "WorkspaceBindResponse.fsRoot").optional(),
    // Echoed back from the request so the caller sees the mode the daemon
    // actually bound. Composes the full four-value taxonomy, not a narrowing.
    executionMode: ExecutionModeSchema,
    // The workspace's post-bind lifecycle position — `provisioning` for a
    // writable bind, `ready` for a read-only one. Composes the full 5-value
    // `WorkspaceStateSchema` and is NOT narrowed to those two literals: the
    // wire doc types the field `WorkspaceState` with no narrowing, and a
    // narrowing would be re-typed (a wire break) the first time a bind
    // legitimately answers from another state — the same stance
    // `RepoAttachResponse.state` takes above.
    state: WorkspaceStateSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// WorkspaceExecutionModeCapabilitiesRead —
// `repo.executionModeCapabilitiesRead` (query).
// --------------------------------------------------------------------------
//
// TWO SCOPES, ONE METHOD. A MOUNT-scoped read answers "what could a workspace
// on this mount do" — the pre-bind question, whose answer is D-009-5's static
// matrix keyed on `vcs_type`. A WORKSPACE-scoped read answers "what may THIS
// workspace do now" — the post-bind question, whose answer additionally
// reflects per-workspace state (a `stale` workspace restricts writable modes
// per `Spec-009 §Fallback Behavior`, which blocks new write runs until
// repair). The two are not interchangeable, which is why the request must name
// exactly one.

export interface WorkspaceExecutionModeCapabilitiesReadRequest {
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
}
// EXACTLY-ONE is a STRICT refinement, rejecting both-present AND
// neither-present. Both degenerate shapes are real hazards, not theoretical:
// neither-present has no subject at all and could only be answered by
// inventing one, and both-present is ambiguous in a way that resolves
// SILENTLY — a handler picking `workspaceId` when the caller meant the mount
// would return the narrower per-workspace answer to a pre-bind question, which
// is the "capability gap exposed explicitly, never silently substituted"
// mandate (`Spec-009 §Fallback Behavior`, I-009-8) failing in the other
// direction.
//
// The competing shape was a two-arm union of single-key objects. Rejected on
// two counts: the wire doc names the refinement explicitly ("exactly one of
// repoMountId | workspaceId (Zod refinement)"), and a `z.union` degrades the
// error a caller sees — a both-present request fails every arm and surfaces as
// an aggregate mismatch rather than the one sentence below. It also could not
// be a TOLERANT union with a permissive arm, which would accept the wrong
// shape rather than reject it.
//
// The predicate counts DEFINED values rather than testing key presence, so an
// explicit `{ repoMountId: undefined, workspaceId: X }` from a TypeScript
// caller reads the same as an omitted key. That is the correct leniency: the
// wire signal is absence, and JSON cannot carry `undefined` at all.
//
// Bridge-free double-T: both members are double-T branded ids, `.optional()`
// preserves both slots, and Zod 4's `.refine()` with a non-predicate callback
// returns the same schema type (the `SessionCreateRequestSchema` precedent in
// session.ts covers the optional-member half).
export const WorkspaceExecutionModeCapabilitiesReadRequestSchema: z.ZodType<
  WorkspaceExecutionModeCapabilitiesReadRequest,
  WorkspaceExecutionModeCapabilitiesReadRequest
> = z
  .object({
    repoMountId: RepoMountIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
  })
  .strict()
  .refine(
    (request) => {
      const scopedToMount = request.repoMountId !== undefined;
      const scopedToWorkspace = request.workspaceId !== undefined;
      return scopedToMount !== scopedToWorkspace;
    },
    {
      message:
        "WorkspaceExecutionModeCapabilitiesReadRequest MUST carry exactly one of `repoMountId` (what could a workspace on this mount do) or `workspaceId` (what may this workspace do now).",
    },
  );

export interface WorkspaceExecutionModeCapabilitiesReadResponse {
  availableModes: ExecutionMode[];
  defaultMode: ExecutionMode;
  restrictions?: Partial<Record<ExecutionMode, string>> | undefined;
}
// Single-T — a read projection, never an input surface.
export const WorkspaceExecutionModeCapabilitiesReadResponseSchema: z.ZodType<WorkspaceExecutionModeCapabilitiesReadResponse> =
  z
    .object({
      // The modes valid RIGHT NOW for the requested scope. No `.min(1)`: the
      // canonical wire doc states no non-empty constraint, and I-009-8's
      // pairing of `availableModes` with `restrictions` makes a fully
      // restricted answer — empty list, a reason per mode — well formed rather
      // than a shape error. V1's static matrix never emits one (a `'none'`
      // mount still offers `read-only`, per D-009-5), so this is headroom for a
      // later probe-derived matrix, not a case in the current model.
      // Mutable `ExecutionMode[]`, matching the wire doc's spelling.
      availableModes: z.array(ExecutionModeSchema),
      // The default for the next WRITABLE coding run (D-009-5), NOT the
      // fresh-workspace posture. The distinction is the one reviewers should
      // check: a newly bound workspace is always `read-only`
      // (`Spec-009 §Default Behavior`, and the `workspaces.execution_mode` DDL
      // default per D-009-7), while this field reports `worktree` on a `'git'`
      // mount per ADR-006. They disagree by design, and a reader who conflates
      // them will think one of the two is wrong.
      //
      // The full four-value taxonomy, NOT narrowed to exclude `read-only`:
      // D-009-5 sets `defaultMode` to `'read-only'` on a `'none'` mount, where
      // no writable mode exists to default to. "Writable" is the semantics of
      // the field, not a constraint on its type — the same
      // no-narrowing stance as `RepoAttachResponse.state` above.
      defaultMode: ExecutionModeSchema,
      // SPARSE map — a reason per RESTRICTED mode; unrestricted modes are
      // omitted entirely, and the whole field is omitted when nothing is
      // restricted. Carries I-009-8's explicit-gap mandate: every mode absent
      // from `availableModes` is expected to appear here with a reason (the
      // presence half is T2.5's obligation, per the note above; the SHAPE half
      // — that a reason is expressible per mode and keyed to the canonical
      // taxonomy — is this schema's).
      //
      // `z.partialRecord`, not `z.record`. Zod 4 makes an ENUM-keyed
      // `z.record` EXHAUSTIVE — every member of the key enum must be present,
      // which is what `CapabilityDetails.flags` in event.ts wants and is
      // exactly wrong here, since a `'git'` mount restricts nothing.
      // `z.partialRecord` clears the key schema's enumerated-value set on a
      // CLONE (leaving this module's shared `ExecutionModeSchema` untouched)
      // and routes parsing through the key schema per present key, so a strict
      // subset is accepted while an out-of-taxonomy key is still rejected.
      //
      // Keyed on the canonical `ExecutionModeSchema` rather than
      // `z.record(z.string(), …)`: an unkeyed map would let a producer emit a
      // restriction for a mode that does not exist, and the reader has no way
      // to match it against `availableModes`. The value stays a plain wire
      // string — branding or narrowing it would silently falsify T1.1's
      // `Partial<Record<ExecutionMode, string>>` compile-time pin, since a
      // narrower partial record stays assignable to a wider one.
      restrictions: z
        .partialRecord(
          ExecutionModeSchema,
          wireFreeFormString(
            EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN,
            "WorkspaceExecutionModeCapabilitiesReadResponse.restrictions",
          ),
        )
        .optional(),
    })
    .strict();

// --------------------------------------------------------------------------
// WorkspaceList — `repo.workspaceList` (query).
// --------------------------------------------------------------------------

export interface WorkspaceListRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
}
// Bridge-free double-T: `SessionIdSchema` and `RepoMountIdSchema` are both
// double-T, and no single-T member is composed here (contrast
// `WorkspaceBindRequestSchema` above).
export const WorkspaceListRequestSchema: z.ZodType<WorkspaceListRequest, WorkspaceListRequest> = z
  .object({
    // SESSION-scoped, not node-scoped: a session may hold several mounts on
    // several nodes (`Spec-009 §State And Data Implications`), and the list is
    // the session's whole workspace roster.
    sessionId: SessionIdSchema,
    // OPTIONAL FILTER, not a second identifier — omission lists every
    // workspace in the session, presence narrows to one mount's workspaces.
    // Contrast the capabilities read above, where the two optional ids are
    // mutually exclusive SCOPES and carry an exactly-one refinement; here
    // `sessionId` alone already identifies the query, so no refinement applies.
    repoMountId: RepoMountIdSchema.optional(),
  })
  .strict();

export interface WorkspaceListResponse {
  workspaces: Array<{
    id: WorkspaceId;
    repoMountId: RepoMountId;
    executionMode: ExecutionMode;
    state: WorkspaceState;
    fsRoot?: string | undefined;
    lastError?: string | undefined;
  }>;
}
// The item TYPE stays INLINE and unnamed, transcribed from the wire doc's own
// anonymous `Array<{…}>` spelling. The contrast case is `MembershipSummary` /
// `ChannelSummary` in session.ts, which the wire doc NAMES and which several
// surfaces reuse; nothing else in Plan-009 consumes this shape, so exporting a
// `WorkspaceSummary` would pre-commit every downstream importer to a symbol
// neither the plan nor the spec asked for. Consumers that need the element type
// spell `WorkspaceListResponse["workspaces"][number]`. The in-file precedent
// for an inline nested object type is `SessionReadResponse.timelineCursors`.
//
// The SCHEMA is a module-local, unexported const rather than an inline
// `z.array(z.object({…}))`, matching event.ts's `sessionCreatedPayloadSchema`
// and presence.ts's `PresenceReadResponseParticipantSchema`: nesting a
// forty-line object two levels inside a call argument buries the field list.
// Unexported, so it adds no public surface and needs no
// `isolatedDeclarations` annotation — the outer schema's
// `z.ZodType<WorkspaceListResponse>` annotation is what checks the composition.
const workspaceListItemSchema = z
  .object({
    // BARE `id`, the read-projection convention — the same asymmetry
    // `RepoMountReadResponse.id` documents above (a projection names its own
    // row's key `id`; a mutation response names the entity it acted on, hence
    // `WorkspaceBindResponse.workspaceId`). Do not "fix" it.
    id: WorkspaceIdSchema,
    // REQUIRED — `workspaces.repo_mount_id` is NOT NULL under the D-009-4
    // mount-first funnel, so every workspace names its mount and a mount-less
    // list item is a state the model never produces.
    repoMountId: RepoMountIdSchema,
    // Together, `executionMode` + `fsRoot` are the "current binding state"
    // `Spec-009 §Interfaces And Contracts` obliges this list to expose.
    executionMode: ExecutionModeSchema,
    // The "workspace health" half of the same requirement. `state` is the
    // health surface here — NOT `RepoMountHealth`, which is the MOUNT's
    // reachability projection (D-009-2) and belongs to `repo.mountRead`. A
    // workspace's health is its lifecycle position: `stale` is the
    // availability-loss verdict I-009-7 requires every daemon read surface to
    // expose.
    state: WorkspaceStateSchema,
    // Optional for the same reason as on the bind response: a `provisioning`
    // workspace has no execution root yet.
    fsRoot: wireFreeFormString(
      REPO_PATH_MAX_LEN,
      "WorkspaceListResponse.workspaces[].fsRoot",
    ).optional(),
    // The `metadata.lastError` detail recorded when a mode switch fails
    // (`Spec-009 §Execution Mode Transitions`, D-009-7 — the key lives in the
    // `workspaces.metadata` JSON blob, surfaced here rather than leaking the
    // whole blob). Present iff the workspace went `stale` from a RECORDED
    // failure: a workspace that went stale from a vanished path with no
    // captured detail carries none, which is why the emitter owns the pairing
    // and the schema does not refine it.
    //
    // This is the ONLY place the cap is enforced today, and that is why the
    // constant's declaration assigns Phase 2 a persist-time scrub-then-
    // truncate: an over-long `lastError` that reached the row would fail
    // validation HERE, on the read path, taking down every subsequent
    // `repo.workspaceList` response rather than the one bad row.
    lastError: wireFreeFormString(
      WORKSPACE_LAST_ERROR_MAX_LEN,
      "WorkspaceListResponse.workspaces[].lastError",
    ).optional(),
  })
  // The ITEM carries its own `.strict()` as well as the envelope below — the
  // wire shape is closed at both levels, matching
  // `RuntimeNodeCapabilityUpdateRequest.healthChanges`. A top-level-only guard
  // would let item-level drift through unnoticed.
  .strict();

// Single-T — a read projection, never an input surface.
export const WorkspaceListResponseSchema: z.ZodType<WorkspaceListResponse> = z
  .object({
    workspaces: z.array(workspaceListItemSchema),
  })
  .strict();
