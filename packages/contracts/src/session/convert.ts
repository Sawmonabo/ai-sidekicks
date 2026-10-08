// Converting a chat to a project: the request, the copy's outcome and the `session.converted`
// payload. Kept apart from the session directory because the session event union imports the
// payload and the directory imports that union.
import { z } from "zod";

import { RepoMountIdSchema, type RepoMountId } from "../repo/mount.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { countSchema } from "../internal/wire-scalars.js";
import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";

/**
 * `session.convert` named a session that is not a chat, a chat with no managed workspace to
 * convert (`data.fields.reason` `no_managed_workspace`), a key another session's conversion holds
 * (`idempotency_key_reused`), or a folder other than the one a chat's stopped conversion copies
 * into (`conversion_unfinished`, with that conversion's `repoMountId`); nothing is attached or
 * copied.
 */
export const SESSION_CONVERT_REFUSED_CODE = "session.convert_refused" as const;

/**
 * A conversion that stopped after the repository was attached. `data.fields` names what was done:
 * `sessionId`, `repoMountId`, `copiedCount`, `skippedCount`, `isBound`; the session still reads
 * as a chat.
 */
export const SESSION_CONVERT_INCOMPLETE_CODE = "session.convert_incomplete" as const;

/**
 * Converts a chat to a project. `path` is the folder the person typed; it travels as data and the
 * daemon checks it, reusing the machine's mount for that folder or attaching one, and refusing a
 * folder that is not a git repository.
 */
export interface SessionConvertRequest {
  sessionId: SessionId;
  path: string;
  clientIdempotencyKey: string;
}
/** Parses a {@link SessionConvertRequest}. */
export const SessionConvertRequestSchema: z.ZodType<SessionConvertRequest, SessionConvertRequest> =
  z
    .object({
      sessionId: SessionIdSchema,
      path: wireFreeFormString(FILE_PATH_MAX_LEN, "SessionConvertRequest.path"),
      clientIdempotencyKey: z.uuid(),
    })
    .strict();

/**
 * Why one of the workspace's files was not copied: the repository already holds its path, a
 * folder on its path is a file or a link in the repository, or the workspace's entry is a link or
 * a special file (a pipe, a socket, a device), none of which is copied.
 */
export type SessionConvertSkipReason =
  | "repository_has_file"
  | "repository_path_not_a_folder"
  | "link"
  | "special_file";
const SessionConvertSkipReasonSchema: z.ZodType<SessionConvertSkipReason> = z.enum([
  "repository_has_file",
  "repository_path_not_a_folder",
  "link",
  "special_file",
]);

/** One file the conversion did not copy, by its path relative to the workspace, and why. */
export interface SessionConvertSkippedFile {
  path: string;
  reason: SessionConvertSkipReason;
}
const SessionConvertSkippedFileSchema: z.ZodType<SessionConvertSkippedFile> = z
  .object({
    // Any name the filesystem holds, a name of spaces alone included.
    path: z.string().min(1).max(FILE_PATH_MAX_LEN),
    reason: SessionConvertSkipReasonSchema,
  })
  .strict();

/**
 * How many of the workspace's files were copied into the repository and how many were not; each
 * file not copied is read with its reason through `session.convertSkippedFileList`. A file not
 * copied stays in the chat's workspace, which the session keeps, and nothing is merged.
 */
export interface SessionConvertResponse {
  copiedCount: number;
  skippedCount: number;
}
const sessionConvertOutcomeFields = {
  copiedCount: countSchema,
  skippedCount: countSchema,
};
/** Parses a {@link SessionConvertResponse}. */
export const SessionConvertResponseSchema: z.ZodType<SessionConvertResponse> = z
  .object(sessionConvertOutcomeFields)
  .strict();

/** The `session.converted` payload: the project the chat became, and the copy's outcome. */
export interface SessionConvertedPayload extends SessionConvertResponse {
  sessionId: SessionId;
  repoMountId: RepoMountId;
}
/** Parses a {@link SessionConvertedPayload}. */
export const SessionConvertedPayloadSchema: z.ZodType<SessionConvertedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    repoMountId: RepoMountIdSchema,
    ...sessionConvertOutcomeFields,
  })
  .strict();

/** The most skipped files one `session.convertSkippedFileList` page carries, and its default. */
export const SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX = 256;

// The longest skipped-file cursor accepted: the daemon's encoding of a path, at most four
// characters for each of the path's UTF-16 units.
const SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN = FILE_PATH_MAX_LEN * 4;

/**
 * Where the next `session.convertSkippedFileList` page starts. The daemon writes it and owns its
 * format; a client passes it back unchanged with the same session.
 */
export type SessionConvertSkippedFileCursor = string & {
  readonly __brand: "SessionConvertSkippedFileCursor";
};
/** Parses a {@link SessionConvertSkippedFileCursor}; a bounded base64url string. */
export const SessionConvertSkippedFileCursorSchema: z.ZodType<
  SessionConvertSkippedFileCursor,
  SessionConvertSkippedFileCursor
> = z
  .string()
  .min(1)
  .max(SESSION_CONVERT_SKIPPED_FILE_CURSOR_MAX_LEN)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .brand<"SessionConvertSkippedFileCursor">() as unknown as z.ZodType<
  SessionConvertSkippedFileCursor,
  SessionConvertSkippedFileCursor
>;

/**
 * The `session.convertSkippedFileList` input: the converted session and, past the first page, the
 * previous page's `nextCursor`. `limit` caps the files on one page, at most
 * {@link SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX}, which is also the default.
 */
export interface SessionConvertSkippedFileListRequest {
  sessionId: SessionId;
  afterCursor?: SessionConvertSkippedFileCursor | undefined;
  limit?: number | undefined;
}
/** Parses a {@link SessionConvertSkippedFileListRequest}. */
export const SessionConvertSkippedFileListRequestSchema: z.ZodType<
  SessionConvertSkippedFileListRequest,
  SessionConvertSkippedFileListRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: SessionConvertSkippedFileCursorSchema.optional(),
    limit: z.number().int().positive().max(SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX).optional(),
  })
  .strict();

/**
 * One page of the files a conversion did not copy, in path order. A continuing page carries at
 * least one file and the cursor to continue from; a session never converted, or one that copied
 * every file, answers an empty last page.
 */
export type SessionConvertSkippedFileListResponse =
  | {
      files: [SessionConvertSkippedFile, ...SessionConvertSkippedFile[]];
      hasMore: true;
      nextCursor: SessionConvertSkippedFileCursor;
    }
  | { files: SessionConvertSkippedFile[]; hasMore: false };
/**
 * Parses a {@link SessionConvertSkippedFileListResponse}: a page carries at most
 * {@link SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX} files and fits the shared page budget.
 */
export const SessionConvertSkippedFileListResponseSchema: z.ZodType<SessionConvertSkippedFileListResponse> =
  z
    .discriminatedUnion("hasMore", [
      z
        .object({
          files: z.tuple([SessionConvertSkippedFileSchema], SessionConvertSkippedFileSchema),
          hasMore: z.literal(true),
          nextCursor: SessionConvertSkippedFileCursorSchema,
        })
        .strict(),
      z
        .object({ files: z.array(SessionConvertSkippedFileSchema), hasMore: z.literal(false) })
        .strict(),
    ])
    .superRefine((page, issueContext) => {
      if (page.files.length > SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX) {
        issueContext.addIssue({
          code: "custom",
          path: ["files"],
          message: `a page carries at most ${String(SESSION_CONVERT_SKIPPED_FILE_PAGE_LIMIT_MAX)} files, not ${String(page.files.length)}`,
        });
      }
      requireMemberToRideOneFrame(page.files, "files", issueContext);
    });
