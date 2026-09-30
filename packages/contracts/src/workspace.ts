// Workspace contracts — the three `repo.*` pairs that bind a session's
// workspace to a mount and read what it can do: `repo.workspaceBind`,
// `repo.executionModeCapabilitiesRead` and `repo.workspaceList`. The ids and
// enums they compose live in repo.ts, and the mount pairs in repo-folders.ts.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js`
// and nothing whose import closure reaches it (the transitive rule repo.ts's
// header documents). Every module imported below is closure-clean.
import { z } from "zod";

import {
  ExecutionModeSchema,
  RepoMountIdSchema,
  WorkspaceIdSchema,
  WorkspaceStateSchema,
  type ExecutionMode,
  type RepoMountId,
  type WorkspaceId,
  type WorkspaceState,
} from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session.js";

// ==========================================================================
// Wire surfaces — WorkspaceBind / WorkspaceExecutionModeCapabilitiesRead /
// WorkspaceList.
// ==========================================================================
//
// The three request/response pairs for the WORKSPACE half of the six
// `repo.*` methods — `repo.workspaceBind` (mutation),
// `repo.executionModeCapabilitiesRead` (query), `repo.workspaceList` (query)
// completing the mount half in repo-folders.ts.
//
// Field sets are transcribed and satisfy three requirements: `WorkspaceBind` "must
// accept repo mount or directory root plus intended execution mode from the
// canonical mode set"; `WorkspaceExecutionModeCapabilitiesRead` "must expose which
// execution modes are currently valid for the bound repo mount or workspace";
// `WorkspaceList` "must expose workspace health and current binding state". Every
// shape composes the enums and branded ids rather than re-spelling them —
// canonical-origin rule.
//
// The TRANSPORT and TYPING notes on repo-folders.ts's mount pairs govern these three unchanged:
// daemon JSON-RPC only (no control-plane tRPC sibling), requests double-T
// `z.ZodType<T, T>`, responses single-T `z.ZodType<T>`, and validates BOTH
// directions. The one departure is `WorkspaceBindRequestSchema`, which needs
// the `as unknown as` bridge the three requests did not; its own comment
// carries the mechanism.
//
// NO CROSS-FIELD REFINEMENTS ON THE TWO CONDITIONAL FIELDS — a deliberate
// boundary, not an omission. Two conditional relationships are real:
// `restrictions` names every mode absent from `availableModes`, and `lastError`
// is present iff the workspace went `stale` from a recorded failure. Both are
// plain-optional in the canonical wire doc, and both are EMITTER obligations
// discharged at the `.parse()` boundary of the surface that produces them — the same
// stance the family-shared lifecycle payload in repo.ts takes on which subject id
// each event type populates. Spelling them as refinements here would reject
// shapes the wire doc permits and would make the test vacuous, since the
// schema would be asserting what the test exists to prove. The ONE cross-field
// rule that is genuinely a shape constraint — exactly one of `repoMountId` /
// `workspaceId` on the capabilities read — is a refinement below, because the
// wire doc mandates it there by name.

// Bound on the per-mode reason strings in
// `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions`. 512 is this
// package's SHORT-HUMAN-REASON class, which is the right class here: these
// values are short daemon-authored explanations, never captured subprocess
// output.
export const EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN = 512;

// DELIBERATELY a different, far more generous class than the restriction reason
// above: `lastError` records the detail of a FAILED mode switch ("an error detail
// recorded in the workspace's metadata"), which in practice is captured
// git/provisioning output, not a curated sentence. The cap must be generous because
// the two sides fail asymmetrically: an over-sized cap costs bytes on a rare
// failure row, while an under-sized one makes a LAWFUL daemon list response
// unrepresentable — validates responses too, so the daemon could not report the
// failure it just recorded. That asymmetry is what picks the generous side. 8192
// matches the package's error-message class (`ERROR_MESSAGE_MAX_LEN` in error.ts)
// rather than the far larger single-item `DRIVER_FAILURE_DETAIL_MAX_LEN`, because
// this field MULTIPLIES across a list projection.
//
// TWO PHASE-2 OBLIGATIONS, IN THIS ORDER, named here because this is where the
// bound is defined and the contract layer can discharge neither. Both fall on
// — named by task because "the emitter" in this file means the workspace-event
// emitter, which never writes this field.
//
//   1. SCRUB. A failing git operation against an authenticated remote can
//      echo a token-bearing remote URL into stderr; a cap this generous
//      carries it verbatim into unencrypted `workspaces.metadata` and
//      re-broadcasts it on every `repo.workspaceList` read. Captured
//      provisioning output MUST be credential-scrubbed before it is persisted.
//   2. TRUNCATE, to this constant, at PERSIST time. The cap is not only a wire
//      bound: nothing else in the model enforces it — `workspaces.metadata` carries
//      no length CHECK — so an unbounded stderr capture persists intact and then
//      fails response validation on the way out. Because validates responses too,
//      that makes every subsequent `repo.workspaceList` call unrepresentable, not
//      just the one row: a single verbose provisioning failure takes down the whole
//      list surface until the row is repaired.
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
// Bind names an attached mount by `repoMountId` and by nothing else, and the
// session the new workspace belongs to. There is deliberately NO
// `localPath` arm: `workspaces.repo_mount_id` is NOT NULL, there is no
// mount-less workspace, and a second identifying field here would reopen
// exactly the second envelope-admission door closed ("no path enters the
// envelope implicitly").

/** The `repo.workspaceBind` input: the session, the attached mount, and the mode to bind in. */
export interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string | undefined;
}
// The `as unknown as z.ZodType<T, T>` bridge — the one departure from the
// bridge-free request stance, and it is structural, not stylistic. Every
// member the requests compose is either double-T (`SessionIdSchema`,
// `RepoMountIdSchema`) or a `z.ZodString`, so none contributes
// an `unknown` input slot. `ExecutionModeSchema` is SINGLE-T (declared
// `z.ZodType<ExecutionMode>` in repo.ts — its `Input` slot defaults to `unknown`),
// and `$ZodTypeInternals` declares `Input` covariant, so the composed object's
// input infers `executionMode: unknown`, which is not assignable to the
// double-T annotation's `WorkspaceBindRequest`, hence the bridge.
/** Wire schema for {@link WorkspaceBindRequest}. */
export const WorkspaceBindRequestSchema: z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest> = z
  .object({
    // The mount belongs to the machine, so the session comes from the caller;
    // the daemon refuses a session that does not exist.
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    // REQUIRED, with no `.default()`: binding is representable only with an
    // EXPLICIT mode from the canonical set. `.default()` is also a transform,
    // so Input would stop equalling Output and the double-T annotation this
    // file's typing note relies on would no longer be truthful.
    executionMode: ExecutionModeSchema,
    // MOUNT-ROOT-RELATIVE subdirectory — a subtree of the mount's canonical
    // root, never an absolute path. OPTIONAL: omission binds the mount root
    // itself.
    //
    // CONTAINMENT IS NOT CHECKED HERE, and `../../etc` is representable on
    // this field on purpose. A `..`-rejecting regex here would be
    // simultaneously insufficient (a symlink inside the mount escapes the
    // envelope without a single `..`) and over-broad (`docs/../packages`
    // names a legitimate subtree), so it would trade a sound post-resolution
    // check for a bypassable pre-resolution one — the same reasoning that
    // keeps traversal off `RepoAttachRequest.localPath` in repo-folders.ts.
    //
    // The cap is the one path bound. The honest bound on a relative segment is
    // the same PATH_MAX ceiling: what the filesystem actually bounds is the
    // joined `canonicalRoot + directory`, and the schema cannot see the root's
    // length at parse time, so any tighter number would be invented.
    directory: wireFreeFormString(FILE_PATH_MAX_LEN, "WorkspaceBindRequest.directory").optional(),
  })
  .strict() as unknown as z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest>;

/** The `repo.workspaceBind` result: the new workspace, its bound mode, and its lifecycle state. */
export interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}
/** Validates a `repo.workspaceBind` result; single-T, since a response is not an input surface. */
export const WorkspaceBindResponseSchema: z.ZodType<WorkspaceBindResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    // Echoed back from the request so the caller sees the mode the daemon
    // actually bound. Composes the full taxonomy, not a narrowing.
    executionMode: ExecutionModeSchema,
    // The workspace's post-bind lifecycle position, `preparing` until its
    // root is prepared. Composes the full 5-value `WorkspaceStateSchema` and
    // is NOT narrowed to that literal: the
    // wire doc types the field `WorkspaceState` with no narrowing, and a
    // narrowing would be re-typed (a wire break) the first time a bind
    // legitimately answers from another state — the same stance
    // `RepoAttachResponse.state` takes in repo-folders.ts.
    state: WorkspaceStateSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// WorkspaceExecutionModeCapabilitiesRead —
// `repo.executionModeCapabilitiesRead` (query).
// --------------------------------------------------------------------------
//
// TWO SCOPES, ONE METHOD. A MOUNT-scoped read answers "what could a workspace
// on this mount do" — the pre-bind question, whose answer is the static matrix
// keyed on `vcs_type`. A WORKSPACE-scoped read answers "what may THIS
// workspace do now" — the post-bind question, whose answer additionally
// reflects per-workspace state (a `stale` workspace restricts its modes,
// which blocks new write runs until repair). The two are not interchangeable,
// which is why the request must name exactly one.

export interface WorkspaceExecutionModeCapabilitiesReadRequest {
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
}
// EXACTLY-ONE is a STRICT refinement, rejecting both-present AND
// neither-present. Both degenerate shapes are real hazards, not theoretical:
// neither-present has no subject at all and could only be answered by
// inventing one, and both-present is ambiguous in a way that resolves SILENTLY
// — a handler picking `workspaceId` when the caller meant the mount would
// return the narrower per-workspace answer to a pre-bind question, which is
// the "capability gap exposed explicitly, never silently substituted" mandate
// failing in the other direction.
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
      // canonical wire doc states no non-empty constraint, and the pairing of
      // `availableModes` with `restrictions` makes a fully restricted answer —
      // empty list, a reason per mode — well formed rather than a shape error.
      // V1's static matrix never emits one, so this is headroom for a later
      // probe-derived matrix, not a case in the current model. Mutable
      // `ExecutionMode[]`, matching the wire doc's spelling.
      availableModes: z.array(ExecutionModeSchema),
      // The mode to bind with when the caller states no preference:
      // `provisioned-worktree` on a git mount, so a coding run works in a worktree of its
      // own rather than in the main checkout.
      defaultMode: ExecutionModeSchema,
      // SPARSE map — a reason per RESTRICTED mode; unrestricted modes are
      // omitted entirely, and the whole field is omitted when nothing is
      // restricted. Carries the explicit-gap mandate: every mode absent from
      // `availableModes` is expected to appear here with a reason (the
      // presence half is the obligation, per the note above; the SHAPE half —
      // that a reason is expressible per mode and keyed to the canonical
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
      // string — branding or narrowing it would silently falsify the
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
    // several nodes, and the list is the session's whole workspace roster.
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
// anonymous `Array<{…}>` spelling. Nothing else consumes this shape, so
// exporting a
// `WorkspaceSummary` would pre-commit every downstream importer to a symbol
// no consumer asked for. Consumers that need the element type
// spell `WorkspaceListResponse["workspaces"][number]`. The in-file precedent
// for an inline nested object type is `SessionReadResponse.timelineCursors`.
//
// The SCHEMA is a module-local, unexported const rather than an inline
// `z.array(z.object({…}))`, matching event.ts's `sessionCreatedPayloadSchema`
// and presence.ts's `PresenceDeviceSchema`: nesting a
// forty-line object two levels inside a call argument buries the field list.
// Unexported, so it adds no public surface and needs no
// `isolatedDeclarations` annotation — the outer schema's
// `z.ZodType<WorkspaceListResponse>` annotation is what checks the composition.
const workspaceListItemSchema = z
  .object({
    // BARE `id`, the read-projection convention — the same asymmetry
    // `RepoMountReadResponse.id` documents in repo-folders.ts (a projection names its own
    // row's key `id`; a mutation response names the entity it acted on, hence
    // `WorkspaceBindResponse.workspaceId`). Do not "fix" it.
    id: WorkspaceIdSchema,
    // REQUIRED — `workspaces.repo_mount_id` is NOT NULL mount-first funnel,
    // so every workspace names its mount and a mount-less list item is a
    // state the model never produces.
    repoMountId: RepoMountIdSchema,
    // Together, `executionMode` + `fsRoot` are the "current binding state"
    // obliges this list to expose.
    executionMode: ExecutionModeSchema,
    // The "workspace health" half of the same requirement. `state` is the
    // health surface here — NOT `RepoMountHealth`, which is the MOUNT's
    // reachability projection and belongs to `repo.mountRead`. A workspace's
    // health is its lifecycle position: `stale` is the availability-loss
    // verdict requires every daemon read surface to expose.
    state: WorkspaceStateSchema,
    // Optional because a `preparing` workspace has no execution root yet;
    // the root is filled in when it is prepared.
    fsRoot: wireFreeFormString(
      FILE_PATH_MAX_LEN,
      "WorkspaceListResponse.workspaces[].fsRoot",
    ).optional(),
    // The `metadata.lastError` detail recorded when a mode switch fails (the
    // key lives in the `workspaces.metadata` JSON blob, surfaced here rather
    // than leaking the whole blob). Present iff the workspace went `stale`
    // from a RECORDED failure: a workspace that went stale from a vanished
    // path with no captured detail carries none, which is why the emitter
    // owns the pairing and the schema does not refine it.
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
  // wire shape is closed at both levels. A top-level-only guard would let
  // item-level drift through unnoticed.
  .strict();

// Single-T — a read projection, never an input surface.
export const WorkspaceListResponseSchema: z.ZodType<WorkspaceListResponse> = z
  .object({
    workspaces: z.array(workspaceListItemSchema),
  })
  .strict();
