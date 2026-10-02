// Repo-mount contracts: the branded `RepoMountId` and `WorkspaceId`, the repo and workspace enums,
// the derived `RepoMountHealth` projection, and the repo, workspace and worktree lifecycle event
// payload with its factories. The mount methods (`repo.attach`, `repo.mountRead`, `repo.detach`)
// are in `repo-folders.ts`. The other `repo.*` contract files import these definitions and never
// redefine them; this module imports none of them.
//
// This module imports nothing from `./event.js`, and nothing that reaches it through any chain of
// imports. `event.ts` imports `RepoWorkspaceLifecyclePayloadSchema` from here, and a cycle among
// eager module-scope Zod initializers throws `ReferenceError` at import time from every entry
// point, which `tsc` does not flag. Check the import chain of any new cross-module symbol.
import { z } from "zod";

import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The daemon-minted id of one repo mount. */
export type RepoMountId = string & { readonly __brand: "RepoMountId" };
/** Parses a {@link RepoMountId}. */
export const RepoMountIdSchema: z.ZodType<RepoMountId, RepoMountId> =
  brandedUuidIdSchema<RepoMountId>("RepoMountId");

/** The daemon-minted id of one workspace. */
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
/** Parses a {@link WorkspaceId}. */
export const WorkspaceIdSchema: z.ZodType<WorkspaceId, WorkspaceId> =
  brandedUuidIdSchema<WorkspaceId>("WorkspaceId");

/**
 * How a workspace uses its mount: `bound-root` works in the root already bound to it (the mount's
 * own checkout), `provisioned-worktree` in a worktree the daemon provisions for it.
 */
export type ExecutionMode = "bound-root" | "provisioned-worktree";
/** Wire schema for {@link ExecutionMode}. */
export const ExecutionModeSchema: z.ZodType<ExecutionMode> = z.enum([
  "bound-root",
  "provisioned-worktree",
]);

/**
 * A workspace's lifecycle state. `stale` means its path became unavailable and write runs are
 * blocked until repair; `busy` means a run holds it. Matches the `workspaces.state` CHECK
 * constraint.
 */
export type WorkspaceState = "preparing" | "ready" | "busy" | "stale" | "archived";
/** Wire schema for {@link WorkspaceState}. */
export const WorkspaceStateSchema: z.ZodType<WorkspaceState> = z.enum([
  "preparing",
  "ready",
  "busy",
  "stale",
  "archived",
]);

/**
 * A mount's lifecycle state. `detached` is terminal: re-attach creates a new mount row rather than
 * reviving the old one.
 */
export type RepoMountState = "attached" | "detached" | "archived";
/** Wire schema for {@link RepoMountState}. */
export const RepoMountStateSchema: z.ZodType<RepoMountState> = z.enum([
  "attached",
  "detached",
  "archived",
]);

/**
 * The version-control system behind a mount. `repo.attach` refuses a path that is not a git
 * repository, so every mount is `"git"`; the capability projection keys off this value.
 */
export type VcsType = "git";
/** Wire schema for {@link VcsType}. */
export const VcsTypeSchema: z.ZodType<VcsType> = z.enum(["git"]);

/**
 * A mount's health, derived on every read and never persisted. Each health-reporting read probes
 * the filesystem first, so there is no "unchecked" state. `unreachable` (not `stale`, which names a
 * workspace state) means the root cannot be probed and takes precedence over the other verdicts.
 * `identity_mismatch` means the root is reachable but its git common directory no longer equals the
 * identity recorded at attach (a mount with no recorded identity never projects it); re-attach,
 * which mints a new mount row, is the recovery. `checkedAt` is required so a reader can tell a
 * fresh probe from a cached one.
 */
export interface RepoMountHealth {
  status: "healthy" | "unreachable" | "identity_mismatch";
  checkedAt: string;
}
/** Wire schema for {@link RepoMountHealth}. */
export const RepoMountHealthSchema: z.ZodType<RepoMountHealth> = z
  .object({
    status: z.enum(["healthy", "unreachable", "identity_mismatch"]),
    checkedAt: isoDateTimeSchema,
  })
  .strict();

// One payload shape serves the nine lifecycle event types: the four that register into
// `SessionEventSchema` (`workspace.preparing`, `workspace.ready`, `workspace.stale`,
// `workspace.archived`) and the five `worktree.*` types.
// The subject is identified by which optional id the payload carries (`repoMountId`, `workspaceId`
// or `worktreeId`), and the schema requires no particular one, because the detach cascade's
// `workspace.archived` legitimately names both the mount and the workspace. Each emitter must
// populate the right ids.

// Must equal the envelope's `EVENT_FIELD_MAX_LEN`, since `actor` is the same wire field. It is
// restated because importing it from `./event.js` would close the module cycle in the header.
const REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN = 256;

/**
 * The payload of every lifecycle event, parameterized by the state vocabulary its emitting module
 * owns; every field but `state` is the same across the family. It is a type alias, not an
 * interface, so it has the implicit index signature `EventEnvelope.payload`
 * (`Record<string, unknown>`) needs. Optional fields are `key?: T | undefined` to match Zod's
 * inferred output under `exactOptionalPropertyTypes`; on the wire an absent key is absent.
 */
export type RepoWorkspaceLifecyclePayloadOf<TState extends string> = {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
  worktreeId?: string | undefined;
  state: TState;
  actor?: string | null | undefined;
};

/** The lifecycle payload for the workspace vocabulary this module emits. */
export type RepoWorkspaceLifecyclePayload = RepoWorkspaceLifecyclePayloadOf<WorkspaceState>;

/**
 * Builds the family payload schema over one emitter's state vocabulary; `worktree.ts` uses it for
 * the `worktree.*` events. The state is a parameter, not a union arm here, for three reasons:
 * adding the worktree states would make `repo.ts` import `worktree.ts`, which imports this file
 * (an eager cycle); one shared union would let a `workspace.archived` payload claim `merged`; and
 * every new emitter would have to edit this file. The result is the erased `z.ZodType`, which is
 * enough to parse and register; an emitter that needs different fields has a different family.
 */
export function buildRepoWorkspaceLifecyclePayloadSchema<TState extends string>(
  stateSchema: z.ZodType<TState>,
): z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState>> {
  return buildRepoWorkspaceLifecyclePayloadObject(stateSchema);
}

/**
 * The family payload with members of one event type's own added: `worktree.retired` names a kept
 * copy, and `worktree.created` names the copy a put-back came from. Family fields and the strict
 * posture are built exactly as {@link buildRepoWorkspaceLifecyclePayloadSchema} builds them.
 * `TExtension` names the added members and `extensionShape` holds one schema per member.
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
      // Required: every lifecycle event is appended to one session's log. It repeats the envelope's
      // `sessionId` so projectors can read the payload alone.
      sessionId: SessionIdSchema,
      repoMountId: RepoMountIdSchema.optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      // Same UUID predicate as the branded ids, so the runtime accept set matches; only the brand
      // is absent, and a consumer narrows at its own parse site.
      worktreeId: uuidTextFormSchema.optional(),
      // The subject's state after the transition: the one field that varies across the family.
      state: stateSchema,
      // Repeats the envelope's free-form actor (`user_id | agent_id | null`). `.nullable()` comes
      // after the string checks so they run only on strings; a system event uses `null` or omits
      // the key.
      actor: wireFreeFormString(
        REPO_WORKSPACE_LIFECYCLE_ACTOR_MAX_LEN,
        "RepoWorkspaceLifecyclePayload.actor",
      )
        .nullable()
        .optional(),
    })
    .strict();
}

/**
 * Parses a {@link RepoWorkspaceLifecyclePayload}. It is strict, so an unknown key is drift surfaced
 * at parse time, and it composes the workspace state schema so a change there propagates here.
 */
export const RepoWorkspaceLifecyclePayloadSchema: z.ZodType<RepoWorkspaceLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(WorkspaceStateSchema);
