// Folder contracts — the folders the service can reach and where each came
// from (`repo.mountList`), browsing the machine's folders from another device
// by token (`repo.folderList`), and the refusal for a folder the service cannot
// reach.
//
// IMPORT DIRECTION IS ONE-WAY: this module imports nothing from `./event.js`
// and nothing whose import closure reaches it (the transitive rule repo.ts's
// header documents). Every module imported below is closure-clean.
import { z } from "zod";

import { ProjectIdSchema, type ProjectId } from "./project.js";
import { RepoMountIdSchema, type RepoMountId } from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session.js";
import { WorktreeIdSchema, type WorktreeId } from "./worktree.js";

// --------------------------------------------------------------------------
// A folder's origin — what a folder the service can reach is, and whose.
// --------------------------------------------------------------------------

/**
 * Where a folder the service can reach came from, carrying the ids its removal
 * act takes:
 * - `attached`: a project's folder, attached by the person; removing it is the
 *   project's detach.
 * - `managed`: a chat's own workspace, which the daemon made and registered as
 *   a mount. It names the one chat that owns it and has no removal act of its
 *   own: it goes only when that session is purged.
 * - `worktree`: a worktree the app made, listed under its project; removing it
 *   is the worktree's retire.
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

// --------------------------------------------------------------------------
// Folders — `repo.mountList` and `repo.folderList`.
// --------------------------------------------------------------------------

/**
 * One folder the service can reach, with how many sessions use it. A project's
 * worktrees follow their project's folder; a worktree on the other side's disk
 * of a Windows computer with WSL is marked `onOtherSideDisk`.
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
    usingSessionCount: z.number().int().nonnegative(),
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
/** The most entries one `repo.folderList` reply carries. */
export const FOLDER_LIST_ENTRY_LIMIT = 500;

/**
 * A folder the service listed, as another device names it. The service mints
 * one per folder it lists and keeps it in memory for ten minutes, so a device
 * acts only on what the service showed it and no path string comes from
 * another device.
 */
export type FolderToken = string & { readonly __brand: "FolderToken" };
/** Parses a {@link FolderToken}. Opaque to every client. */
export const FolderTokenSchema: z.ZodType<FolderToken, FolderToken> = z
  .string()
  .min(1)
  .max(FOLDER_TOKEN_MAX_LEN)
  .brand<"FolderToken">() as unknown as z.ZodType<FolderToken, FolderToken>;

/**
 * `repo.folderList`: the folder to show (the service account's home folder when
 * absent), the text that narrows its folders, and whether hidden folders are
 * listed.
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
 * The `repo.folderList` result: the folder in view as the service writes its
 * path, the path's segments from the top down (the last is the folder in view),
 * at most {@link FOLDER_LIST_ENTRY_LIMIT} of its folders, and `more` when the
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
    entries: z
      .array(
        z
          .object({
            name: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoFolderListResponse.entries[].name"),
            folderToken: FolderTokenSchema,
            isRepository: z.boolean(),
          })
          .strict(),
      )
      .max(FOLDER_LIST_ENTRY_LIMIT),
    more: z.boolean(),
  })
  .strict();

/**
 * The refusal `repo.attach` answers when the service cannot reach the folder
 * picked, such as a folder in another WSL distribution than the one the service
 * runs in.
 */
export type RepoFolderUnreachableCode = "repo.folder_unreachable";
/** The code of {@link RepoFolderUnreachableCode}. */
export const REPO_FOLDER_UNREACHABLE_CODE: RepoFolderUnreachableCode = "repo.folder_unreachable";
