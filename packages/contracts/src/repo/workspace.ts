// Workspace contracts: the `repo.*` pairs that bind a session's workspace to a mount and list
// them (`repo.workspaceBind` and `repo.workspaceList`). The ids and enums they compose live in
// repo/mount.ts, and the mount pairs in repo/folders.ts.
//
// This module imports nothing from `../event/session.js` and nothing whose import closure
// reaches it, for the module-cycle reason in the header of `repo/mount.ts`.
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
} from "./mount.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";

// These are daemon JSON-RPC methods only. `lastError` is an obligation on the daemon, not a
// refinement: it is present only when the workspace went `stale` from a recorded failure.

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
  .strict();

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
