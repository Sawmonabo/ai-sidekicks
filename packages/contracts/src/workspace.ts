// Workspace contracts: the `repo.*` pairs that bind a session's workspace to a mount and read
// what it can do (`repo.workspaceBind`, `repo.executionModeCapabilitiesRead` and
// `repo.workspaceList`). The ids and enums they compose live in repo/repo.ts, and the mount pairs
// in repo-folders.ts.
//
// This module imports nothing from `./event/session-event.js` and nothing whose import closure
// reaches it, for the module-cycle reason in the header of `repo/repo.ts`.
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
} from "./repo/repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session/session.js";

// These are daemon JSON-RPC methods only. Two conditional fields are obligations on the daemon, not
// refinements: `restrictions` names every mode absent from `availableModes`, and `lastError` is
// present only when the workspace went `stale` from a recorded failure.

/**
 * The longest reason the daemon writes for a verdict, such as why an execution mode is restricted
 * or why a worktree cannot be reused: a short authored summary, never captured git output.
 */
export const AUTHORED_REASON_MAX_LEN = 512;

/**
 * The longest `lastError` a workspace carries: captured git or provisioning output. The daemon
 * scrubs credentials before it truncates, since a cut secret is a fragment the scrubber misses.
 */
export const WORKSPACE_LAST_ERROR_MAX_LEN = 8192;

/**
 * The `repo.workspaceBind` input: the session, the attached mount, and the mode to bind in.
 * `directory` is relative to the mount root, and the daemon keeps it inside the mount once
 * symlinks resolve, which a `..` test here would miss.
 */
export interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string | undefined;
}
/** Wire schema for {@link WorkspaceBindRequest}. */
export const WorkspaceBindRequestSchema: z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest> = z
  .object({
    // The mount belongs to the machine, so the caller names the session.
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    // Required: an omitted mode must not read as a chosen one.
    executionMode: ExecutionModeSchema,
    directory: wireFreeFormString(FILE_PATH_MAX_LEN, "WorkspaceBindRequest.directory").optional(),
  })
  // The single-typed `ExecutionModeSchema` leaves the object's input type `unknown`.
  .strict() as unknown as z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest>;

/** The `repo.workspaceBind` result: the new workspace, its bound mode, and its lifecycle state. */
export interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}
/** Wire schema for {@link WorkspaceBindResponse}. */
export const WorkspaceBindResponseSchema: z.ZodType<WorkspaceBindResponse> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    executionMode: ExecutionModeSchema,
    // Not narrowed to `preparing`: a bind may answer from another state.
    state: WorkspaceStateSchema,
  })
  .strict();

/**
 * The `repo.executionModeCapabilitiesRead` input. A mount-scoped read asks what a workspace on
 * that mount could do before binding; a workspace-scoped read asks what this workspace may do now,
 * including restrictions from its state. Exactly one of the two ids is required.
 */
export interface WorkspaceExecutionModeCapabilitiesReadRequest {
  repoMountId?: RepoMountId | undefined;
  workspaceId?: WorkspaceId | undefined;
}
/** Wire schema for {@link WorkspaceExecutionModeCapabilitiesReadRequest}. */
export const WorkspaceExecutionModeCapabilitiesReadRequestSchema: z.ZodType<
  WorkspaceExecutionModeCapabilitiesReadRequest,
  WorkspaceExecutionModeCapabilitiesReadRequest
> = z
  .object({
    repoMountId: RepoMountIdSchema.optional(),
    workspaceId: WorkspaceIdSchema.optional(),
  })
  .strict()
  // Exactly one id: neither names a subject, and both would answer a pre-bind question with the
  // narrower per-workspace answer. An explicit `undefined` reads as an omitted key.
  .refine(
    (request) => {
      const scopedToMount = request.repoMountId !== undefined;
      const scopedToWorkspace = request.workspaceId !== undefined;
      return scopedToMount !== scopedToWorkspace;
    },
    {
      message:
        "WorkspaceExecutionModeCapabilitiesReadRequest MUST carry " +
        "exactly one of `repoMountId` (what could a workspace on this " +
        "mount do) or `workspaceId` (what may this workspace do now).",
    },
  );

/**
 * The `repo.executionModeCapabilitiesRead` result: the modes valid for the requested scope, the
 * default, and a reason for each mode that is not available.
 */
export interface WorkspaceExecutionModeCapabilitiesReadResponse {
  availableModes: ExecutionMode[];
  defaultMode: ExecutionMode;
  restrictions?: Partial<Record<ExecutionMode, string>> | undefined;
}
/** Wire schema for {@link WorkspaceExecutionModeCapabilitiesReadResponse}. */
export const WorkspaceExecutionModeCapabilitiesReadResponseSchema: z.ZodType<WorkspaceExecutionModeCapabilitiesReadResponse> =
  z
    .object({
      // May be empty: a fully restricted answer carries a reason per mode.
      availableModes: z.array(ExecutionModeSchema),
      // `provisioned-worktree` on a git mount, so a coding run works in a worktree of its own.
      defaultMode: ExecutionModeSchema,
      // Sparse: a reason per restricted mode, omitted entirely when nothing is restricted. It is
      // a partial record because an enum-keyed `z.record` requires every key to be present.
      restrictions: z
        .partialRecord(
          ExecutionModeSchema,
          wireFreeFormString(
            AUTHORED_REASON_MAX_LEN,
            "WorkspaceExecutionModeCapabilitiesReadResponse.restrictions",
          ),
        )
        .optional(),
    })
    .strict();

/** The `repo.workspaceList` input: a session's workspaces, optionally narrowed to one mount. */
export interface WorkspaceListRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId | undefined;
}
/** Wire schema for {@link WorkspaceListRequest}. */
export const WorkspaceListRequestSchema: z.ZodType<WorkspaceListRequest, WorkspaceListRequest> = z
  .object({
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema.optional(),
  })
  .strict();

/** The `repo.workspaceList` result: each workspace with its mode, state and execution root. */
export interface WorkspaceListResponse {
  workspaces: {
    id: WorkspaceId;
    repoMountId: RepoMountId;
    executionMode: ExecutionMode;
    state: WorkspaceState;
    fsRoot?: string | undefined;
    lastError?: string | undefined;
  }[];
}
const workspaceListItemSchema = z
  .object({
    // Bare `id`, as a read projection names its own row; a mutation response names the entity.
    id: WorkspaceIdSchema,
    repoMountId: RepoMountIdSchema,
    executionMode: ExecutionModeSchema,
    // The workspace's health is its lifecycle state, not the mount's `RepoMountHealth`.
    state: WorkspaceStateSchema,
    // Absent while the workspace is `preparing` and has no execution root yet.
    fsRoot: wireFreeFormString(
      FILE_PATH_MAX_LEN,
      "WorkspaceListResponse.workspaces[].fsRoot",
    ).optional(),
    // Present only when the workspace went `stale` from a recorded failure. An over-long value
    // would fail validation here and break every `repo.workspaceList` response, not one row.
    lastError: wireFreeFormString(
      WORKSPACE_LAST_ERROR_MAX_LEN,
      "WorkspaceListResponse.workspaces[].lastError",
    ).optional(),
  })
  .strict();

/** Wire schema for {@link WorkspaceListResponse}. */
export const WorkspaceListResponseSchema: z.ZodType<WorkspaceListResponse> = z
  .object({
    workspaces: z.array(workspaceListItemSchema),
  })
  .strict();
