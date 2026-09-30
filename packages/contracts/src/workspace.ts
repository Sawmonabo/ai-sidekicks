// Workspace contracts: the three `repo.*` pairs that bind a session's workspace to a mount and
// read what it can do (`repo.workspaceBind`, `repo.executionModeCapabilitiesRead` and
// `repo.workspaceList`). The ids and enums they compose live in repo.ts, and the mount pairs in
// repo-folders.ts.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js` and nothing whose
// import closure reaches it (see the header of `repo.ts`).
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

// These are daemon JSON-RPC methods only, with no control-plane sibling. Requests are typed
// `z.ZodType<T, T>`, responses `z.ZodType<T>`, and both directions are validated.
//
// The two conditional fields carry no cross-field refinement, on purpose: `restrictions` names
// every mode absent from `availableModes`, and `lastError` is present only when the workspace went
// `stale` from a recorded failure. The surface that produces them owns those rules; a refinement
// here would reject shapes the wire allows. The one true shape rule, exactly one of `repoMountId`
// or `workspaceId` on the capabilities read, is a refinement below.

/** The longest per-mode reason in `WorkspaceExecutionModeCapabilitiesReadResponse.restrictions`. */
export const EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN = 512;

/**
 * The longest `lastError` a workspace list item carries. It is generous because the value is
 * captured git or provisioning output, and a cap smaller than what the daemon stored would make
 * the whole list response fail validation. The daemon must scrub credentials from a detail and
 * then truncate it to this length before persisting it; truncating first could cut a secret in
 * half and leave a fragment the scrubber no longer matches.
 */
export const WORKSPACE_LAST_ERROR_MAX_LEN = 8192;

/**
 * The `repo.workspaceBind` input: the session, the attached mount, and the mode to bind in. It
 * names the mount by `repoMountId` only, since every workspace belongs to a mount.
 * `directory` is relative to the mount root; keeping it inside the mount is checked after
 * symlinks resolve, not by this schema (a `..` test here would miss a symlink escape).
 */
export interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string | undefined;
}
// Cast to the double-typed form: `ExecutionModeSchema` is single-typed, so the composed object's
// input type would otherwise be `unknown` for `executionMode`.
/** Wire schema for {@link WorkspaceBindRequest}. */
export const WorkspaceBindRequestSchema: z.ZodType<WorkspaceBindRequest, WorkspaceBindRequest> = z
  .object({
    // The mount belongs to the machine, so the caller names the session.
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    // Required with no default: a default is a transform, which would make input and output differ.
    executionMode: ExecutionModeSchema,
    // No length cap tighter than the path limit: the schema cannot see the mount root's length.
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
// Rejects both-present and neither-present: neither has no subject, and both would silently
// answer a pre-bind question with the narrower per-workspace answer. A defined-value count is used
// so an explicit `undefined` reads as an omitted key.
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

/**
 * The `repo.executionModeCapabilitiesRead` result: the modes valid for the requested scope, the
 * default, and a reason for each mode that is not available.
 */
export interface WorkspaceExecutionModeCapabilitiesReadResponse {
  availableModes: ExecutionMode[];
  defaultMode: ExecutionMode;
  restrictions?: Partial<Record<ExecutionMode, string>> | undefined;
}
/** Validates a `repo.executionModeCapabilitiesRead` result; single-typed, since it is a read. */
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
            EXECUTION_MODE_RESTRICTION_REASON_MAX_LEN,
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
    // Session-scoped: a session may hold several mounts on several nodes.
    sessionId: SessionIdSchema,
    // A filter, not a second identifier: omission lists every workspace in the session.
    repoMountId: RepoMountIdSchema.optional(),
  })
  .strict();

/** The `repo.workspaceList` result: each workspace with its mode, state and execution root. */
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
// The item is a local const so the field list is not buried inside a call argument.
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
  // The item is closed as well as the envelope, so drift at either level is rejected.
  .strict();

/** Validates a `repo.workspaceList` result; single-typed, since it is a read. */
export const WorkspaceListResponseSchema: z.ZodType<WorkspaceListResponse> = z
  .object({
    workspaces: z.array(workspaceListItemSchema),
  })
  .strict();
