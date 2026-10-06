// Folder contracts: the folders the service can reach and where each came from (`repo.mountList`),
// browsing the machine's folders from another device by token (`repo.folderList`), one folder's
// attach, read and detach (`repo.attach`, `repo.mountRead`, `repo.detach`), and the refusal for a
// folder the service cannot reach.
//
// This module imports nothing from `../event/session.js` and nothing whose imports reach it,
// which would close an eager module cycle.
import { z } from "zod";

import { NodeIdSchema, type NodeId } from "../runtime-node/id.js";
import { PROJECT_NAME_MAX_LEN, ProjectIdSchema, type ProjectId } from "../project.js";
import {
  RepoMountHealthSchema,
  RepoMountIdSchema,
  RepoMountStateSchema,
  VcsTypeSchema,
  WorkspaceIdSchema,
  type RepoMountHealth,
  type RepoMountId,
  type RepoMountState,
  type VcsType,
  type WorkspaceId,
} from "./mount.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import { WorktreeIdSchema, type WorktreeId } from "../worktree/lifecycle.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * Where a folder the service can reach came from, carrying the ids its removal act takes:
 * - `attached`: a project's folder, attached by the person; removing it is the project's detach.
 * - `managed`: a chat's own workspace, which the daemon made and registered as a mount. It names
 *   the one chat that owns it and has no removal act of its own: it goes only when that session is
 *   purged.
 * - `worktree`: a worktree the app made, listed under its project; removing it is the worktree's
 *   retire.
 */
export type RepoMountOrigin =
  | { kind: "attached"; repoMountId: RepoMountId; projectId: ProjectId }
  | { kind: "managed"; repoMountId: RepoMountId; sessionId: SessionId }
  | { kind: "worktree"; worktreeId: WorktreeId; projectId: ProjectId };
/** Wire schema for {@link RepoMountOrigin}. */
export const RepoMountOriginSchema: z.ZodType<RepoMountOrigin> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attached"),
      repoMountId: RepoMountIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("managed"),
      repoMountId: RepoMountIdSchema,
      sessionId: SessionIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worktree"),
      worktreeId: WorktreeIdSchema,
      projectId: ProjectIdSchema,
    })
    .strict(),
]);

/**
 * One folder the service can reach, with how many sessions use it. A project's worktrees follow
 * their project's folder; a worktree on the other side's disk of a Windows computer with WSL is
 * marked `onOtherSideDisk`.
 */
export interface RepoMountListEntry {
  path: string;
  origin: RepoMountOrigin;
  usingSessionCount: number;
  onOtherSideDisk: boolean;
}
/** Wire schema for {@link RepoMountListEntry}. */
export const RepoMountListEntrySchema: z.ZodType<RepoMountListEntry> = z
  .object({
    path: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoMountListEntry.path"),
    origin: RepoMountOriginSchema,
    usingSessionCount: countSchema,
    onOtherSideDisk: z.boolean(),
  })
  .strict();

/** `repo.mountList` takes nothing: it lists every folder the service can reach. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RepoMountListRequest {}
/** Wire schema for {@link RepoMountListRequest}. */
export const RepoMountListRequestSchema: z.ZodType<RepoMountListRequest, RepoMountListRequest> = z
  .object({})
  .strict();

/** The `repo.mountList` result. */
export interface RepoMountListResponse {
  mounts: RepoMountListEntry[];
}
/** Wire schema for {@link RepoMountListResponse}. */
export const RepoMountListResponseSchema: z.ZodType<RepoMountListResponse> = z
  .object({ mounts: z.array(RepoMountListEntrySchema) })
  .strict();

/** The longest folder token the daemon mints. */
export const FOLDER_TOKEN_MAX_LEN = 256;

/**
 * A folder the service listed, as another device names it. The service mints one per folder it
 * lists and keeps it in memory for ten minutes, so a device acts only on what the service showed
 * it and no path string comes from another device.
 */
export type FolderToken = string & { readonly __brand: "FolderToken" };
/** Parses a {@link FolderToken}. Opaque to every client. */
export const FolderTokenSchema: z.ZodType<FolderToken, FolderToken> = z
  .string()
  .min(1)
  .max(FOLDER_TOKEN_MAX_LEN)
  .brand<"FolderToken">() as unknown as z.ZodType<FolderToken, FolderToken>;

/**
 * `repo.folderList`: the folder to show (the service account's home folder when absent), the text
 * that narrows its folders, and whether hidden folders are listed.
 */
export interface RepoFolderListRequest {
  folderToken?: FolderToken | undefined;
  filter?: string | undefined;
  showHidden?: boolean | undefined;
}
/** Wire schema for {@link RepoFolderListRequest}. */
export const RepoFolderListRequestSchema: z.ZodType<RepoFolderListRequest, RepoFolderListRequest> =
  z
    .object({
      folderToken: FolderTokenSchema.optional(),
      filter: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFolderListRequest.filter").optional(),
      showHidden: z.boolean().optional(),
    })
    .strict();

/** One folder in a listing: its name, its token, and whether it is a git repository. */
export interface RepoFolderListEntry {
  name: string;
  folderToken: FolderToken;
  isRepository: boolean;
}
/** One step of the path to the folder in view, pressable to go back to it. */
export interface RepoFolderPathSegment {
  name: string;
  folderToken: FolderToken;
}

/**
 * The `repo.folderList` result: the folder in view as the service writes its path, the path's
 * segments from the top down (the last is the folder in view), its folders, and `more` when the
 * filter would narrow further.
 */
export interface RepoFolderListResponse {
  path: string;
  segments: RepoFolderPathSegment[];
  entries: RepoFolderListEntry[];
  more: boolean;
}
/** Wire schema for {@link RepoFolderListResponse}. */
export const RepoFolderListResponseSchema: z.ZodType<RepoFolderListResponse> = z
  .object({
    path: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFolderListResponse.path"),
    segments: z
      .array(
        z
          .object({
            name: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFolderListResponse.segments[].name"),
            folderToken: FolderTokenSchema,
          })
          .strict(),
      )
      .min(1),
    entries: z.array(
      z
        .object({
          name: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFolderListResponse.entries[].name"),
          folderToken: FolderTokenSchema,
          isRepository: z.boolean(),
        })
        .strict(),
    ),
    more: z.boolean(),
  })
  .strict();

// Attach is the only way a path enters the machine's trust envelope. A mount belongs to the
// machine, not to a session: the daemon stamps its own node id on the row, and a session reaches
// the mount by binding a workspace to it. A path that is not a git repository is refused.

/**
 * The `repo.attach` input, one of two arms:
 * - `{localPath}`: a path on the machine the service runs on, from a client on that machine.
 * - `{folderToken}`: from another device, a token `repo.folderList` minted for a folder it listed,
 *   so no path string comes from another device.
 */
export type RepoAttachRequest = { localPath: string } | { folderToken: FolderToken };
/** Wire schema for {@link RepoAttachRequest}: exactly one of the two arms. */
export const RepoAttachRequestSchema: z.ZodType<RepoAttachRequest, RepoAttachRequest> = z.union([
  z
    .object({
      // The path as entered, kept as provenance; the trust envelope keys off the resolved canonical
      // root. Absoluteness, traversal and existence are deliberately not checked here: an
      // absoluteness test would refuse some Windows spellings, so the resolver applies the
      // platform's rule and refuses a relative, `~`-prefixed or driveless path; a traversal test
      // would refuse the lawful `/home/me/../me/repo`, and containment is checked at bind; a
      // missing path is the resolver's typed refusal. The NUL guard in `wireFreeFormString` is the
      // one that matters, since an embedded NUL truncates a path.
      localPath: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoAttachRequest.localPath"),
    })
    .strict(),
  z.object({ folderToken: FolderTokenSchema }).strict(),
]);

/** The `repo.attach` result: the new mount and the root its path resolved to. */
export interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string;
}
/** Wire schema for {@link RepoAttachResponse}. */
export const RepoAttachResponseSchema: z.ZodType<RepoAttachResponse> = z
  .object({
    repoMountId: RepoMountIdSchema,
    state: RepoMountStateSchema,
    vcsType: VcsTypeSchema,
    // The resolver's absolute, symlink-resolved root, never the entered path. A resolution failure
    // aborts the attach with `repo.root_resolution_failed` instead of a partial success.
    canonicalRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoAttachResponse.canonicalRoot"),
  })
  .strict();

/** `repo.mountRead`: the mount to read. */
export interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
/** Wire schema for {@link RepoMountReadRequest}. */
export const RepoMountReadRequestSchema: z.ZodType<RepoMountReadRequest, RepoMountReadRequest> = z
  .object({ repoMountId: RepoMountIdSchema })
  .strict();

/** One session using a folder. */
export interface RepoMountUser {
  sessionId: SessionId;
}

/**
 * One mount as `repo.mountRead` reports it, with a freshly probed health verdict. `displayName`
 * is its project's name, absent on a chat's own workspace, which belongs to no project.
 */
export interface RepoMountReadResponse {
  id: RepoMountId;
  nodeId: NodeId;
  /** The path as entered; it differs from `canonicalRoot` when entered inside or via a link. */
  localPath: string;
  canonicalRoot: string;
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth;
  attachedAt: string;
  origin: RepoMountOrigin;
  displayName?: string | undefined;
  usedBy: RepoMountUser[];
}
/** Wire schema for {@link RepoMountReadResponse}. */
export const RepoMountReadResponseSchema: z.ZodType<RepoMountReadResponse> = z
  .object({
    id: RepoMountIdSchema,
    nodeId: NodeIdSchema,
    localPath: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoMountReadResponse.localPath"),
    canonicalRoot: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoMountReadResponse.canonicalRoot"),
    vcsType: VcsTypeSchema,
    state: RepoMountStateSchema,
    health: RepoMountHealthSchema,
    attachedAt: isoDateTimeSchema,
    origin: RepoMountOriginSchema,
    displayName: wireFreeFormString(
      PROJECT_NAME_MAX_LEN,
      "RepoMountReadResponse.displayName",
    ).optional(),
    usedBy: z.array(z.object({ sessionId: SessionIdSchema }).strict()),
  })
  .strict();

/** `repo.detach`: the project's folder to remove. */
export interface RepoDetachRequest {
  repoMountId: RepoMountId;
}
/** Wire schema for {@link RepoDetachRequest}. */
export const RepoDetachRequestSchema: z.ZodType<RepoDetachRequest, RepoDetachRequest> = z
  .object({ repoMountId: RepoMountIdSchema })
  .strict();

/**
 * The `repo.detach` result. Detaching is a project's `Delete`: the mount turns `detached` for good,
 * every dependent workspace is archived, the project record is forgotten with its setup steps, and
 * the project's sessions are archived and stay readable. Nothing on disk is touched.
 *
 * `forgottenProjectId` names the project this call forgot, and is null when the mount was already
 * detached. The call is refused with `repo.detach_conflict`, whose `runningSessionId` names the
 * session running there, while a dependent workspace is busy.
 */
export interface RepoDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  archivedWorkspaceIds: WorkspaceId[];
  archivedSessionIds: SessionId[];
  forgottenProjectId: ProjectId | null;
}
/** Wire schema for {@link RepoDetachResponse}. */
export const RepoDetachResponseSchema: z.ZodType<RepoDetachResponse> = z
  .object({
    repoMountId: RepoMountIdSchema,
    state: RepoMountStateSchema,
    archivedWorkspaceIds: z.array(WorkspaceIdSchema),
    archivedSessionIds: z.array(SessionIdSchema),
    forgottenProjectId: ProjectIdSchema.nullable(),
  })
  .strict();

/**
 * The refusal `repo.attach` answers when the service cannot reach the folder picked, such as a
 * folder in another WSL distribution than the one the service runs in.
 */
export const REPO_FOLDER_UNREACHABLE_CODE = "repo.folder_unreachable" as const;
/**
 * The type of {@link REPO_FOLDER_UNREACHABLE_CODE}.
 *
 * @consumedBy the handler that returns the `repo.folder_unreachable` error
 */
export type RepoFolderUnreachableCode = typeof REPO_FOLDER_UNREACHABLE_CODE;
