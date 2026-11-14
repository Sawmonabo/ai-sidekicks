// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Converting a chat to a project: the request, the copy's outcome, the `session.converted` payload, the read of the files the copy skipped, and the details of a refused or incomplete conversion.

import type { Place } from "../place.js";
import type { RepoMountId } from "../repo/mount.js";
import type { SessionId } from "./id.js";

/**
 * Why one of the workspace's files was not copied.
 */
export type SessionConvertSkipReason =
  | "repositoryHasFile"
  | "repositoryPathNotAFolder"
  | "link"
  | "specialFile";
/**
 * Where the next `session.conversion.skippedFile.list` page starts: base64url without padding,
 * at least one character and at most four for each UTF-16 unit of the longest path. The daemon
 * writes it and owns its format; a client passes it back unchanged with the same session.
 */
export type SessionConvertSkippedFileCursor = string & {
  readonly __brand: "SessionConvertSkippedFileCursor";
};
/**
 * One page of the files a conversion did not copy, in the order of their path keys, split on
 * `hasMore`. A path key is the path's stable bytes compared byte by byte: on macOS and Linux the
 * path's own bytes, on Windows its UTF-16 units as two little-endian bytes each, so the order
 * follows no text collation and a client keeps it as given.
 */
export type SessionConversionSkippedFileListResponse =
  | {
      /**
       * The files, in the order of their path keys.
       *
       * @minItems 1
       * @maxItems 256
       */
      files: [SessionConvertSkippedFile, ...SessionConvertSkippedFile[]];
      /**
       * More files follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: SessionConvertSkippedFileCursor;
    }
  | {
      /**
       * The files, in the order of their path keys.
       *
       * @maxItems 256
       */
      files: SessionConvertSkippedFile[];
      /**
       * No files follow.
       */
      hasMore: false;
    };
/**
 * Why a `session.conversion.refused` refusal turned the convert away; a session that is not a chat
 * is refused with no reason.
 */
export type SessionConversionRefusedReason =
  | "noManagedWorkspace"
  | "idempotencyKeyReused"
  | "conversionUnfinished"
  | "folderInAnotherPlace";

/**
 * Converts a chat to a project. `path` is the folder the person typed; it travels as data and the
 * daemon checks it, reusing the machine's mount for that folder or attaching one, and refusing a
 * folder that is not a git repository. The path is read in the chat's own place: a Linux path in
 * the chat's distribution, a drive path or its `/mnt/<drive>` form on Windows; a folder in another
 * place is refused with `session.conversion.refused`.
 */
export interface SessionConvertRequest {
  /**
   * The chat.
   */
  sessionId: SessionId;
  /**
   * The folder.
   */
  path: string;
  /**
   * The key that makes a repeated convert one conversion.
   */
  clientIdempotencyKey: string;
}
/**
 * One file the conversion did not copy, by its path relative to the workspace, and why.
 */
export interface SessionConvertSkippedFile {
  /**
   * The path; any name the filesystem holds, a name of spaces alone included.
   */
  path: string;
  /**
   * Why it was not copied.
   */
  reason: SessionConvertSkipReason;
}
/**
 * How many of the workspace's files were copied into the repository and how many were not. A
 * file not copied stays in the chat's workspace, which the session keeps, and nothing is merged.
 */
export interface SessionConvertResponse {
  /**
   * Files copied.
   */
  copiedCount: number;
  /**
   * Files not copied, each read with its reason through `session.conversion.skippedFile.list`.
   */
  skippedCount: number;
}
/**
 * The `session.converted` payload: the project the chat became, and the copy's outcome.
 */
export interface SessionConvertedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The repository it now works in.
   */
  repoMountId: RepoMountId;
  /**
   * Files copied.
   */
  copiedCount: number;
  /**
   * Files not copied.
   */
  skippedCount: number;
}
/**
 * The `session.conversion.skippedFile.list` input: the converted session and, past the first page,
 * the previous page's `nextCursor`.
 */
export interface SessionConversionSkippedFileListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Continue from this cursor.
   */
  afterCursor?: SessionConvertSkippedFileCursor;
  /**
   * The most files on one page; the default is the most.
   */
  limit?: number;
}
/**
 * The details of a `session.conversion.refused` refusal: its reason, the mount of the stopped
 * conversion a `conversionUnfinished` names, and the chat's place a `folderInAnotherPlace` names.
 */
export interface SessionConversionRefusedDetails {
  /**
   * Why; absent for a session that is not a chat.
   */
  reason?: SessionConversionRefusedReason;
  /**
   * The mount the stopped conversion copies into.
   */
  repoMountId?: RepoMountId;
  /**
   * The chat's place.
   */
  place?: Place;
}
/**
 * The details of a `session.conversion.incomplete` failure: what the conversion did before it
 * stopped. The session still reads as a chat.
 */
export interface SessionConversionIncompleteDetails {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The mount the repository is attached as.
   */
  repoMountId: RepoMountId;
  /**
   * Files copied into it so far.
   */
  copiedCount: number;
  /**
   * Files not copied so far.
   */
  skippedCount: number;
  /**
   * Whether the session was bound to the project.
   */
  isBound: boolean;
}

export { validateSessionConvertedPayload } from "../checks/session/convert.js";
