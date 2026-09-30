// Repo-mount contracts — the branded `RepoMountId` / `WorkspaceId` scalars, the
// canonical repo and workspace enums, the derived `RepoMountHealth` projection,
// the shared repo, workspace and worktree lifecycle event payload and its
// factories, and the three mount pairs (`repo.attach`, `repo.mountRead`,
// `repo.detach`). Adding, removing, or renaming a member here is a contract
// break.
//
// This module owns `ExecutionMode`, `WorkspaceState`, `RepoMountState`,
// `VcsType`, `RepoMountHealth`, the branded `RepoMountId` / `WorkspaceId`, and
// `RepoWorkspaceLifecyclePayload`. The other `repo.*` contract files
// (`workspace.ts`, `worktree.ts`, `project.ts`, `repo-folders.ts`,
// `repo-clone.ts`, `repo-git-reads.ts`, `worktree-setup.ts`,
// `removed-worktree.ts`, `worktree-events.ts`, `repo-methods.ts`) import them
// and never redefine one; this module imports none of those files.
//
// IMPORT DIRECTION IS ONE-WAY — this module imports NOTHING from `./event.js`.
// `event.ts` imports `RepoWorkspaceLifecyclePayloadSchema` from here to
// register the six variants into `SessionEventSchema`, so a back-import would
// close a module cycle whose Zod const initialization order is unsound (the
// importer's `const` bindings sit in TDZ while this module's body evaluates).
// The one value that would otherwise be imported — event.ts's
// `EVENT_FIELD_MAX_LEN` — is therefore restated locally; see the cap
// declaration on the lifecycle payload below.
//
// THE RULE IS TRANSITIVE, and reads on the whole import CLOSURE: this module
// must import nothing that itself reaches `./event.js`, however many hops out.
// A cycle among eager module-scope Zod initializers throws `ReferenceError` at
// import time from every entry point, and `tsc` does not flag it. That is why
// `NodeIdSchema` comes from the dependency-free leaf `./node-id.js`. Before
// composing any new cross-module symbol below, check its closure the same way.
import { z } from "zod";

import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
// DIRECT import from the dependency-free `./node-id.js` leaf (see the header).
import { NodeIdSchema, type NodeId } from "./node-id.js";
import {
  FILE_PATH_MAX_LEN,
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Server-minted UUIDs, so both compose the `brandedUuidIdSchema` helper from
// `./internal/branded.js` (which encapsulates the `RFC_9562_TEXT_FORM`
// predicate plus the `.brand().as unknown as z.ZodType<T, T>` cast bridging
// Zod's single-T `$ZodBranded` output to the double-T shape tRPC v11's
// Standard-Schema-V1 input inference needs) — the same idiom as
// `SessionIdSchema` in session.ts.
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
// --------------------------------------------------------------------------
//
// Membership of each set is the contract, not declaration order — RFC 8785
// JCS serializes the literal wire string, so order is not load-bearing.

/**
 * How a workspace uses its mount: `bound-root` works in the root already bound
 * to it (the mount's own checkout), `provisioned-worktree` in a worktree the
 * daemon provisions for it.
 */
export type ExecutionMode = "bound-root" | "provisioned-worktree";
/** Wire schema for {@link ExecutionMode}. */
export const ExecutionModeSchema: z.ZodType<ExecutionMode> = z.enum([
  "bound-root",
  "provisioned-worktree",
]);

// The 5-value workspace lifecycle. `stale` is the availability-loss position (a
// workspace whose path becomes unavailable transitions to `stale` and write runs
// are blocked until repair); `busy` is the run-hold position the `markBusy` /
// `releaseBusy` primitives own. Aligned with the `workspaces.state` CHECK
// constraint.
export type WorkspaceState = "preparing" | "ready" | "busy" | "stale" | "archived";
export const WorkspaceStateSchema: z.ZodType<WorkspaceState> = z.enum([
  "preparing",
  "ready",
  "busy",
  "stale",
  "archived",
]);

// The 3-value mount lifecycle. `detached` is TERMINAL for the row — re-attach
// creates a NEW mount row rather than reviving this one, which is why the
// partial unique index on the canonical root filters `WHERE state =
// 'attached'`.
export type RepoMountState = "attached" | "detached" | "archived";
export const RepoMountStateSchema: z.ZodType<RepoMountState> = z.enum([
  "attached",
  "detached",
  "archived",
]);

// --------------------------------------------------------------------------
// VcsType — the version-control system behind a mount.
// --------------------------------------------------------------------------
//
/**
 * The version-control system behind a mount. `repo.attach` refuses a path that
 * is not a git repository, so every mount is `"git"`; the capability projection
 * keys off this value.
 */
export type VcsType = "git";
/** Wire schema for {@link VcsType}. */
export const VcsTypeSchema: z.ZodType<VcsType> = z.enum(["git"]);

// --------------------------------------------------------------------------
// RepoMountHealth — derived projection, never persisted.
// --------------------------------------------------------------------------
//
// Ratified shape: `{ status: "healthy" | "unreachable" | "identity_mismatch";
// checkedAt: string }` (semantics). A render-ready discriminant plus the probe
// provenance that produced it.
//
// Four properties are load-bearing, and each is a deliberate rejection of a
// competing shape:
//   • The on-read probe floor synchronously probes filesystem availability
//     before every health-reporting read, so every read carries a fresh
//     verdict and there is no "we did not check" state to report. Admitting
//     `unknown` would let a read answer "we did not check" for a surface
//     contractually obliged to check.
//   • `"unreachable"`, NOT `"stale"`. `stale` already names a WORKSPACE state
//     above; reusing it here would overload one vocabulary across two axes
//     (mount reachability vs workspace lifecycle) and make a `health.status`
//     of `"stale"` indistinguishable from a workspace-state leak.
//   • `"identity_mismatch"` is the THIRD member and not a refusal. its own
//     words: "`identity_mismatch` when the root is reachable but the common
//     directory re-derived from it no longer equals the attach-persisted
//     identity anchor (`repo_mounts.metadata.commonDir`) … required because the
//     mount's binds and runs are already refusing through the persisted-identity
//     match, and a projection still answering `healthy` for a mount that can
//     never bind again is a lying read model" (per the
//     carried-findings adjudication). `unreachable` TAKES PRECEDENCE — no
//     further question can be put to a root that cannot be probed — and a mount
//     persisting no anchor never projects it. Re-attach is the named recovery, and it mints a
//     new mount row.
//   • `checkedAt` is REQUIRED, not optional. A verdict with no probe
//     timestamp is unauditable — the reader cannot tell a fresh probe from a
//     cached one, which is the whole reason the field exists.
// NO `health` column lands in `repo_mounts`: pins health to projection state,
// not row state — the identity verdict included, which is re-derived on every
// health-reporting read.
export interface RepoMountHealth {
  status: "healthy" | "unreachable" | "identity_mismatch";
  checkedAt: string;
}
// Single-T `z.ZodType<T>` — a derived read-side projection, never a tRPC input
// surface, so it needs no double-T input-inference bridge.
export const RepoMountHealthSchema: z.ZodType<RepoMountHealth> = z
  .object({
    status: z.enum(["healthy", "unreachable", "identity_mismatch"]),
    // ISO 8601 instant of the probe that produced the verdict. `{ offset:
    // true }` widens default Z-only acceptance to numeric RFC 3339 — the
    // package-wide datetime convention (`createdAt` in session.ts,
    // `occurredAt` in event.ts).
    checkedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// RepoWorkspaceLifecyclePayload — the FAMILY-SHARED event payload.
// --------------------------------------------------------------------------
//
// `EventEnvelope.payload` shape for every type: `{sessionId, repoMountId?,
// workspaceId?, worktreeId?, state, actor?}`. That family registers ELEVEN
// types under ONE payload shape — the six emits (`repo.attached`,
// `repo.detached`, `workspace.preparing`, `workspace.ready`,
// `workspace.stale`, `workspace.archived`, registered into
// `SessionEventSchema` by this task) plus the five `worktree.*` types
// registers later against this SAME schema.
//
// Because one schema serves all eleven, the SUBJECT of an event is identified
// by WHICH optional id it carries, not by a per-type payload shape: a mount
// event carries `repoMountId`, a workspace event carries `workspaceId`, a
// worktree event carries `worktreeId`. The schema imposes no cross-field
// requirement — marks all three optional, and inventing a "exactly one id"
// refinement here would reject the legitimately multi-id rows the detach
// cascade emits (its `workspace.archived` names the mount and the
// workspace). Which id each type populates is the EMITTER's obligation, enforced
// at the `.parse()` emission seam, not a shape rule.
//
// This is also why the payload is authored HERE rather than in event.ts:
// emitter-authors-payload precedent carried forward.

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
 * Payload of every event — see the family-shared note above — PARAMETERIZED by the
 * state vocabulary its emitting module owns.
 *
 * The parameter exists so that no emitter has to edit this file. Every
 * field but `state` is identical across all eleven types; `state` is the one
 * axis that differs, and it differs per EMITTING MODULE rather than per event. See
 * `buildRepoWorkspaceLifecyclePayloadSchema` for why parameterizing beats the
 * third-union-arm alternative.
 *
 * Declared as a TYPE ALIAS, not an `interface`, and that is load-bearing: the
 * six variant interfaces in event.ts narrow `EventEnvelope.payload`, which is
 * typed `Record<string, unknown>`. TypeScript grants an implicit index
 * signature to an object type alias but NOT to an interface, so an interface
 * here would fail the `extends EventEnvelope` narrowing with "index signature
 * is missing".
 *
 * Optional fields are typed `key?: T | undefined` (not bare `key?:`): Zod's
 * `.optional()` infers `T | undefined`, and with no `as unknown as` cast
 * TypeScript checks the alias against the schema's inferred output exactly
 * under `exactOptionalPropertyTypes`. The wire signal is still "key absent" — consumers that need
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
 * Instantiation — the two vocabularies THIS file emits. Named separately
 * because it is the shape event.ts's six variant interfaces narrow against,
 * and because `RepoWorkspaceLifecyclePayload` is the name every existing
 * consumer already imports.
 */
export type RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<
  RepoMountState | WorkspaceState
>;
/**
 * Build the family payload schema over ONE emitter's state vocabulary.
 *
 * Exported because `worktree.ts` needs it: it registers five `worktree.*` types
 * against this family, and gives them a vocabulary (`creating` / `dirty` /
 * `merged` / `retired`) that overlaps the two below at `ready` alone. It calls
 * this factory with its own `WorktreeStateSchema` and registers the result —
 * payload schemas stay in the EMITTER's domain file, which is how every
 * emitter registers into the additive `SessionEventSchema` union.
 *
 * NO THIRD UNION ARM, not now and not later — the alternative this factory
 * exists to refuse, and it fails on three independent grounds:
 *
 *   • Adding `WorktreeStateSchema` to the `state` union here means repo.ts
 *     importing from worktree.ts, while this factory makes worktree.ts import FROM
 *     repo.ts. That is the eager module-scope Zod cycle this file's header
 *     describes — the one the `node-id.js` relocation was cut to break —
 *     and `tsc` does not flag it.
 *   • ACCEPT SET. One shared union widens ALL eleven types at once: a
 *     `workspace.archived` payload could then claim `state: "merged"`, and a
 *     `worktree.retired` could claim `"preparing"`. Parameterizing keeps
 *     each family's accept set exactly its own vocabulary.
 *   • A third arm makes every new emitter edit repo.ts, which is the edit
 *     the parameter exists to spare it.
 *
 * The return type is the erased `z.ZodType<…>`, not a `ZodObject`, and that is
 * sufficient: consumers `.parse()` the result and register it into the event
 * union. Nothing extends it — an emitter that needs different FIELDS has a
 * different payload family, not a widened one.
 */
export function buildRepoWorkspaceLifecyclePayloadSchema<TState extends string>(
  stateSchema: z.ZodType<TState>,
): z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState>> {
  return buildRepoWorkspaceLifecyclePayloadObject(stateSchema);
}

/**
 * The same family payload with members of one event type's own added, for the
 * two worktree events that carry one more fact than the family: a discard that
 * kept a copy names it on `worktree.retired`, and a put-back names the copy it
 * came from on `worktree.created`. Every family field and the strict posture stay
 * exactly as {@link buildRepoWorkspaceLifecyclePayloadSchema} builds them, so the
 * shared fields cannot drift between the family and the widened type.
 *
 * `TExtension` names the added members and `extensionShape` holds one schema per
 * member, each checked against that member's type.
 */
export function buildRepoWorkspaceLifecyclePayloadSchemaWith<
  TState extends string,
  TExtension extends Record<string, unknown>,
>(
  stateSchema: z.ZodType<TState>,
  extensionShape: { readonly [Member in keyof TExtension]-?: z.ZodType<TExtension[Member]> },
): z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState> & TExtension> {
  return buildRepoWorkspaceLifecyclePayloadObject(stateSchema).extend(
    extensionShape as Record<string, z.ZodType>,
  ) as unknown as z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState> & TExtension>;
}

function buildRepoWorkspaceLifecyclePayloadObject<TState extends string>(
  stateSchema: z.ZodType<TState>,
) {
  return z
    .object({
      // REQUIRED — spells the family base `{sessionId, …}` with no `?`. Every
      // event in this family is appended to one session's log. Duplicates the
      // envelope's `sessionId`, exactly as `session.created`'s payload does
      // (projector convenience).
      sessionId: SessionIdSchema,
      repoMountId: RepoMountIdSchema.optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      // The parser is the SAME predicate the branded ids compose through —
      // `uuidTextFormSchema` and `brandedUuidIdSchema` are two exports over one
      // `RFC_9562_TEXT_FORM` — so the RUNTIME accept-set is identical by
      // construction and not by coincidence: only the compile-time brand is
      // absent, and a consumer narrows to it at its own parse site.
      worktreeId: uuidTextFormSchema.optional(),
      // The subject's post-transition state — THE PARAMETER, and the only
      // field that varies across the family. Each caller supplies the
      // vocabulary its own module owns; see this function's note on why that is
      // a parameter rather than an ever-widening union.
      state: stateSchema,
      // The EventEnvelope free-form actor (`user_id | agent_id | null`),
      // carried at payload level IN ADDITION to the envelope's own `actor` —
      // the family payload shape spells it, the same way it re-spells
      // `sessionId`. Realized with the package's standard
      // `wireFreeFormString` (length cap + whitespace-only rejection + NUL-byte
      // rejection at the wire/replay trust boundary), matching
      // `buildCommonShape()`'s envelope actor. `.nullable()` composes AFTER the helper so the
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
// `.parse()`, never a tRPC request input. `.strict()` is the
// house posture for a `session_lifecycle` payload: unknown keys are schema
// drift surfaced at parse time. (The non-strict carve-out mandates is scoped
// to `artifact.*` payloads and does not reach this family.)
//
// The two vocabularies are composed from the enum schemas above rather than
// re-typed as a combined seven-literal `z.enum`, so a change to either enum
// propagates here instead of drifting (`"archived"` is a member of both and
// collapses in the union). This is the schema event.ts registers for all six
// types.
export const RepoWorkspaceLifecyclePayloadSchema: z.ZodType<RepoWorkspaceLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(z.union([RepoMountStateSchema, WorkspaceStateSchema]));

// ==========================================================================
// Wire surfaces — RepoAttach / RepoMountRead / RepoDetach.
// ==========================================================================
//
// The three request/response pairs for the MOUNT half of the six `repo.*`
// methods — `repo.attach` (mutation), `repo.mountRead` (query),
// `repo.detach` (mutation).
//
// Field sets are transcribed and satisfy the field requirements plus. Every shape
// composes enums / branded ids / `RepoMountHealth` above rather than re-spelling
// them — canonical-origin rule.
//
// All six methods ride the daemon JSON-RPC transport ONLY: repo mounts and
// workspaces are node-local filesystem state, so no control-plane tRPC sibling
// exists, and the names register against the daemon's `MethodRegistry`, which
// makes BOTH directions validated — the substrate `.parse()`s inbound params against the
// request schema before the handler runs, and the handler's result against the
// response schema before it reaches the wire.
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
// available to any later typed-SDK consumer, at no cost here.
//
// The response side is single-T for the reason every response schema in
// session.ts is: a response is not an input surface. It is
// also the CAST-FREE choice — `RepoMountReadResponseSchema` composes the
// single-T `RepoMountHealthSchema`, whose `Input` slot is `unknown`, so a
// double-T response annotation would need an `as unknown as` bridge to express
// nothing extra. The rejected alternative was presence.ts's uniform-double-T
// file style, which its own `PresenceSubscribeRequestSchema` comment concedes
// is "for file-wide annotation uniformity, not a live tRPC-input requirement".
//
// None of the three request schemas needs an `as unknown as z.ZodType<T, T>`
// bridge. Every member composed below is either the double-T
// `RepoMountIdSchema` or a `z.ZodString` (`wireFreeFormString`,
// whose `Input` slot is `string`, not `unknown`), so no single-T member
// contributes an `unknown` input slot to poison the composed object's
// inference.

// --------------------------------------------------------------------------
// RepoAttach — `repo.attach` (mutation).
// --------------------------------------------------------------------------
//
// The envelope-admission action: attach is the ONLY way a path enters the
// machine's local trust envelope ("no path enters the envelope implicitly").
// A mount belongs to the machine, not to a session: the daemon stamps its own
// node id on the row, and a session reaches the mount by binding a workspace
// to it. A path that is not a git repository is refused.

/** The `repo.attach` input: the path to attach, as the user entered it. */
export interface RepoAttachRequest {
  localPath: string;
}
/** Wire schema for {@link RepoAttachRequest}. */
export const RepoAttachRequestSchema: z.ZodType<RepoAttachRequest, RepoAttachRequest> = z
  .object({
    // USER-ENTERED PATH, provenance only — persisted as
    // `repo_mounts.local_path` and never used as the canonical root
    // (trust-envelope enforcement and node-ownership routing key off
    // `canonical_root`, never `local_path`).
    //
    // Realized with the package's standard `wireFreeFormString` (length cap +
    // whitespace-only rejection + NUL-byte rejection). The NUL guard is the
    // load-bearing one on a PATH: an embedded NUL is a classic truncation
    // vector as well as the log-injection vector the helper documents.
    //
    // THREE CHECKS DELIBERATELY NOT MADE HERE, each for its own reason:
    //   • A `startsWith("/")` test would refuse every Windows path
    //     (`C:\repos\foo`), and Windows is a V1 tier; a cross-platform
    //     absoluteness rule is exactly the normalization assigns to the daemon
    //     resolver — which APPLIES that rule rather than relaxing it:
    //     `RepoRootResolver` refuses with typed `not_absolute` any input that
    //     does not name one COMPLETE location. That is three shapes, not one:
    //     a relative path, a `~`-prefixed path, and a driveless Windows root
    //     such as `\repos\foo` (which `path.win32.isAbsolute` calls absolute
    //     while it names no volume). Completing any of them would mean taking
    //     the missing piece from daemon-side state — its working directory,
    //     its home, its current drive — and the daemon's context is not the
    //     author's, so the root would be a guess. All three therefore fail LOUDLY;
    //     resolving them against the author's context belongs to the
    //     client/CLI layer, before the path reaches the wire. They stay
    //     REPRESENTABLE here anyway, because refusing them at parse time would
    //     mean spelling absoluteness in Zod for every platform, and that is
    //     the resolver's job. separately warns that attach must not assume the
    //     entered path is even the repo root.
    //   • Rejecting it here would refuse the legitimate
    //     `/home/me/../me/repo`. Traversal is a CONTAINMENT concern, checked
    //     post-resolution against the mount root by the validator scopes
    //     that check to `WorkspaceBind`'s `directory`, not to the
    //     envelope-ADMITTING attach path.
    //   • A filesystem probe belongs to the resolver, and a missing path is
    //     the typed `repo.root_resolution_failed` refusal, not a parse error.
    // ACCEPTED TRADE-OFF: the helper's `/\S/` guard refuses a whitespace-only
    // path, which is a technically legal POSIX filename. A path that is
    // nothing but spaces is far likelier to be a UI-submission bug than an
    // intended target, so the guard stays.
    localPath: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoAttachRequest.localPath"),
  })
  .strict();

/** The `repo.attach` result: the new mount and the root its path resolved to. */
export interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string;
}
/** Wire schema for {@link RepoAttachResponse}; single-T, since a response is not an input. */
export const RepoAttachResponseSchema: z.ZodType<RepoAttachResponse> = z
  .object({
    repoMountId: RepoMountIdSchema,
    // The mount's post-attach lifecycle position.
    state: RepoMountStateSchema,
    // The version-control system fixed at resolution time; the capability
    // projection keys off it downstream.
    vcsType: VcsTypeSchema,
    // RESOLVER OUTPUT — absolute and symlink-resolved, NEVER the echoed
    // `localPath` input. This is the value the trust envelope and
    // active-root uniqueness index key off. REQUIRED: an attach response
    // with no resolved root is unrepresentable, because resolution failure
    // ABORTS attach with typed `repo.root_resolution_failed` rather than
    // returning a partial success.
    canonicalRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoAttachResponse.canonicalRoot"),
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

/** One mount as `repo.mountRead` reports it, owned by the machine that attached it. */
export interface RepoMountReadResponse {
  id: RepoMountId;
  nodeId: NodeId;
  localPath: string;
  canonicalRoot: string;
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth;
  attachedAt: string;
}
/** Wire schema for {@link RepoMountReadResponse}; single-T, since a read is not an input. */
export const RepoMountReadResponseSchema: z.ZodType<RepoMountReadResponse> = z
  .object({
    // BARE `id`, NOT `repoMountId` — transcribed verbatim from the wire doc,
    // which uses the unqualified `id` on READ PROJECTIONS (the convention
    // `WorkspaceListResponse.workspaces[].id` follows too) and the qualified
    // name on the attach/detach MUTATION responses. The asymmetry is
    // deliberate: a projection names its own row's key `id`, while a mutation
    // response names the entity it acted on. Do not "fix" it to `repoMountId`.
    id: RepoMountIdSchema,
    // The machine that attached the mount, stamped by its daemon.
    nodeId: NodeIdSchema,
    // Provenance and resolved identity travel TOGETHER and independently (both
    // values are meaningful: the entered path is what the user recognizes, the
    // canonical root is what the system trusts). Attaching from a nested
    // subdirectory is the case that separates them.
    localPath: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoMountReadResponse.localPath"),
    canonicalRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoMountReadResponse.canonicalRoot"),
    vcsType: VcsTypeSchema,
    state: RepoMountStateSchema,
    // DERIVED projection — probed at read time, never a `repo_mounts` column.
    // REQUIRED: obliges this read to expose "current health", and on-read
    // probe floor means every health-reporting read carries a fresh verdict,
    // so there is no "health not computed" case to represent. Composes the
    // `RepoMountHealthSchema` rather than re-spelling `{status, checkedAt}`,
    // so the 2-value status union cannot drift between the two surfaces.
    health: RepoMountHealthSchema,
    // `repo_mounts.attached_at`. ISO 8601 with `{ offset: true }` — the
    // package-wide datetime convention (`checkedAt` above, `createdAt` in
    // session.ts).
    attachedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// RepoDetach — `repo.detach` (mutation).
// --------------------------------------------------------------------------
//
// Detach is REFUSED with typed `repo.detach_conflict` while any dependent
// workspace is `busy` (there is no force-detach in V1), so the refusal
// carries no shape here — it is an error envelope, not a response variant. On
// the success path the mount transitions to the TERMINAL `detached` state (no
// `detached -> attached` transition exists; re-attaching the same canonical
// root creates a NEW mount row) and every dependent workspace is archived by
// the cascade.

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
    archivedWorkspaceIds: z.array(WorkspaceIdSchema),
  })
  .strict();
