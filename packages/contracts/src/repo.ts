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
// Refs: Spec-009 (Repo Attachment And Workspace Binding), Spec-006 §Repo,
// Workspace, and Worktree Lifecycle (the shared payload shape), ADR-006
// (worktree-first execution mode), ADR-018 (versioning), ADR-022 (toolchain —
// Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
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
// (runtime-node.ts), a daemon-assigned opaque scalar that deliberately
// departs from the UUID parser; `repo_mounts.id` and `workspaces.id` are
// ordinary UUID primary keys, so no departure applies here.
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
