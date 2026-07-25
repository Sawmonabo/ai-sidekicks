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
 * event — see the family-shared note above.
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
export type RepoWorkspaceLifecyclePayload = {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
  worktreeId?: string | undefined;
  state: RepoMountState | WorkspaceState;
  actor?: string | null | undefined;
};
// Single-T `z.ZodType<T>`, `.strict()` — a non-input event payload,
// constructed daemon-side and validated at the emission boundary with
// `.parse()`, never a tRPC request input (the same typing stance as
// runtime-node.ts's `runtime_node.*` payload schemas). `.strict()` is the
// house posture for a `session_lifecycle` payload: unknown keys are schema
// drift surfaced at parse time. (The non-strict carve-out
// `Spec-006 §Artifact and Diff Publication (artifact_publication)` mandates is
// scoped to `artifact.*` payloads and does not reach this family.)
export const RepoWorkspaceLifecyclePayloadSchema: z.ZodType<RepoWorkspaceLifecyclePayload> = z
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
    // The subject's post-transition state. Union of the two Plan-009
    // vocabularies — mount states for `repo.*`, workspace states for
    // `workspace.*` — composed from the enum schemas above rather than
    // re-typed as a combined seven-literal `z.enum`, so a change to either
    // enum propagates here instead of drifting (`"archived"` is a member of
    // both and collapses in the union).
    //
    // FORWARD PATH (CP-010-5 reuses this schema for the five `worktree.*`
    // types; Plan-010 D-010-12 is what fixes the states they carry). D-010-12
    // maps each worktree transition to `creating` / `dirty` / `merged` /
    // `retired` — none of which is in either vocabulary above; only `ready`
    // overlaps. Plan-010's registration therefore ADDS a third arm here,
    // `z.union([RepoMountStateSchema, WorkspaceStateSchema, WorktreeStateSchema])`,
    // widening the accept set. That is an additive-MINOR change under
    // ADR-018 §Decision #8 (no member is removed, no field is reshaped, and
    // every payload valid today stays valid), which is exactly the
    // no-reshaping property CP-010-5 depends on.
    state: z.union([RepoMountStateSchema, WorkspaceStateSchema]),
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
// boundary against the named constant instead of a magic number. T1.3 may mint
// its own cap for `WorkspaceBindRequest.directory` (a mount-root-relative
// subpath — a different bound) per the per-field convention.
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
