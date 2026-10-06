// Repo-mount contracts: the branded `RepoMountId` and `WorkspaceId`, the repo and workspace enums,
// the derived `RepoMountHealth` projection, and the repo, workspace and worktree lifecycle event
// payload with its factories. The mount methods (`repo.attach`, `repo.mountRead`, `repo.detach`)
// are in `repo/folders.ts`. The other `repo.*` contract files import these definitions and never
// redefine them; this module imports none of them.
//
// This module imports nothing that reaches `../event/session.js`: `event/session.ts`
// imports the lifecycle payload schema from here, and a cycle among module-scope Zod initializers
// throws at import time, which `tsc` does not flag.
import { z } from "zod";

import { EVENT_FIELD_MAX_LEN } from "../event/version.js";
import { brandedUuidIdSchema, uuidTextFormSchema } from "../internal/branded.js";
import { wireFreeFormString } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { isoDateTimeSchema } from "../internal/wire-scalars.js";

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
 * A mount's health, probed on every read and never stored. `unreachable` means the root cannot be
 * probed and outranks the rest; `identity_mismatch` means the root's git common directory is not
 * the one recorded at attach, and re-attaching is the recovery.
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

// One payload shape serves the `workspace.*` and `worktree.*` lifecycle events. The subject is
// whichever optional id the payload carries, and none is required, because a detach's
// `workspace.archived` names both the mount and the workspace.

/**
 * The payload of every lifecycle event, over the state vocabulary of the module that emits it;
 * every field but `state` is shared. A type alias, so it has the index signature an event payload
 * needs.
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
 * Builds the lifecycle payload schema over one emitter's state vocabulary; `worktree/lifecycle.ts`
 * uses it for the `worktree.*` events. The state is a parameter so a `workspace.*` payload can
 * never claim a worktree state.
 */
export function buildRepoWorkspaceLifecyclePayloadSchema<TState extends string>(
  stateSchema: z.ZodType<TState>,
): z.ZodType<RepoWorkspaceLifecyclePayloadOf<TState>> {
  return buildRepoWorkspaceLifecyclePayloadObject(stateSchema);
}

/**
 * The lifecycle payload with members of one event type's own added: `worktree.retired` names a
 * kept copy, and `worktree.created` names the copy a put-back came from.
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
      // Repeats the envelope's `sessionId` so a projector can read the payload alone.
      sessionId: SessionIdSchema,
      repoMountId: RepoMountIdSchema.optional(),
      workspaceId: WorkspaceIdSchema.optional(),
      worktreeId: uuidTextFormSchema.optional(),
      // The subject's state after the transition.
      state: stateSchema,
      // Repeats the envelope's actor; a system event sends `null` or leaves it out.
      actor: wireFreeFormString(EVENT_FIELD_MAX_LEN, "RepoWorkspaceLifecyclePayload.actor")
        .nullable()
        .optional(),
    })
    .strict();
}

/** Parses a {@link RepoWorkspaceLifecyclePayload}; an unknown key is refused. */
export const RepoWorkspaceLifecyclePayloadSchema: z.ZodType<RepoWorkspaceLifecyclePayload> =
  buildRepoWorkspaceLifecyclePayloadSchema(WorkspaceStateSchema);
