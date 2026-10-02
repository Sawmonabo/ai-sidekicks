// Clone contracts: `repo.clone` makes a project from a repository URL, and its card follows the
// clone live: git's progress, the question git asks and the person's answer, a failure with git's
// last line, cancel, and pulling large files afterwards.
//
// This module imports nothing from `./event.js` and nothing whose imports reach it, which would
// close an eager module cycle.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";
import { ProjectIdSchema, type ProjectId } from "./project.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "./session.js";

/** The longest repository URL `repo.clone` takes. */
export const REPO_CLONE_URL_MAX_LEN = 2048;
/** The longest line of git's own words the clone card carries. */
export const REPO_CLONE_LINE_MAX_LEN = 1024;
/** The longest answer to one of git's questions. */
export const REPO_CLONE_ANSWER_MAX_LEN = 4096;

/**
 * `repo.clone`: the repository's URL, the folder the clone goes into when it is not the machine's
 * clone folder, and the project whose failed or canceled clone this runs again. The reply names
 * the project, made at once and marked `cloning`; the clone ends in the ordinary attach.
 */
export interface RepoCloneRequest {
  url: string;
  parentFolder?: string | undefined;
  projectId?: ProjectId | undefined;
}
/** Wire schema for {@link RepoCloneRequest}. */
export const RepoCloneRequestSchema: z.ZodType<RepoCloneRequest, RepoCloneRequest> = z
  .object({
    url: wireFreeFormString(REPO_CLONE_URL_MAX_LEN, "RepoCloneRequest.url"),
    parentFolder: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoCloneRequest.parentFolder").optional(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();

/**
 * The refusal `repo.clone` answers before any clone starts: the address is neither https nor ssh,
 * or the destination folder is not empty. Nothing is made.
 */
export const REPO_CLONE_REFUSED_CODE = "repo.clone_refused" as const;
/** The type of {@link REPO_CLONE_REFUSED_CODE}. */
export type RepoCloneRefusedCode = typeof REPO_CLONE_REFUSED_CODE;

/** Why a clone was refused before it started. */
export type RepoCloneRefusedReason = "unsupported_address" | "destination_not_empty";
/** Every {@link RepoCloneRefusedReason}. */
export const REPO_CLONE_REFUSED_REASONS: readonly RepoCloneRefusedReason[] = Object.freeze([
  "unsupported_address",
  "destination_not_empty",
]);

/** The details a `repo.clone_refused` refusal carries. */
export interface RepoCloneRefusedDetails {
  reason: RepoCloneRefusedReason;
}
/** Wire schema for {@link RepoCloneRefusedDetails}. */
export const RepoCloneRefusedDetailsSchema: z.ZodType<RepoCloneRefusedDetails> = z
  .object({ reason: z.enum(REPO_CLONE_REFUSED_REASONS) })
  .strict();

/** The `repo.clone` result: the project the clone fills. */
export interface RepoCloneResponse {
  projectId: ProjectId;
}
/** Wire schema for {@link RepoCloneResponse}. */
export const RepoCloneResponseSchema: z.ZodType<RepoCloneResponse> = z
  .object({ projectId: ProjectIdSchema })
  .strict();

/** The project a clone-card request is about. */
export interface RepoCloneProjectRequest {
  projectId: ProjectId;
}
/**
 * Wire schema for {@link RepoCloneProjectRequest}: `repo.cloneSubscribe`, `repo.cloneCancel` and
 * `repo.largeFilesPull` each take only the project.
 */
export const RepoCloneProjectRequestSchema: z.ZodType<
  RepoCloneProjectRequest,
  RepoCloneProjectRequest
> = z.object({ projectId: ProjectIdSchema }).strict();

/** The `repo.cloneSubscribe` acknowledgement. */
export type RepoCloneSubscribeResponse = SubscribeAckResponse;
/** Wire schema for {@link RepoCloneSubscribeResponse}. */
export const RepoCloneSubscribeResponseSchema: z.ZodType<RepoCloneSubscribeResponse> =
  SubscribeAckResponseSchema;

/** One question git is waiting on, minted when git's askpass program asks it. */
export type CloneQuestionId = string & { readonly __brand: "CloneQuestionId" };
/** Parses a {@link CloneQuestionId}. */
export const CloneQuestionIdSchema: z.ZodType<CloneQuestionId, CloneQuestionId> =
  brandedUuidIdSchema<CloneQuestionId>("CloneQuestionId");

/** Git's progress in its own words, `Receiving objects` at 42 percent. */
export interface RepoCloneProgress {
  phase: string;
  percent: number | null;
}
/**
 * A question git asked (a user name, a password or token, a key's passphrase, or whether to trust
 * a host's key), in git's own words. `masked` is true for a password or a passphrase.
 */
export interface RepoCloneQuestion {
  questionId: CloneQuestionId;
  prompt: string;
  masked: boolean;
}

/**
 * One `repo.cloneSubscribe` emission, the clone card's whole state.
 *
 * - `cloning` and `pulling_large_files` carry git's latest progress and the question it is waiting
 *   on, if any.
 * - `large_files_missing`: the clone finished, but the repository keeps large files in Git LFS,
 *   which is not installed, so they arrived as placeholders.
 * - `failed` names the step that failed and git's last error line; the line is null only when the
 *   service restarted during the clone and git left none.
 * - `canceled` and `done` end the card.
 */
export type RepoCloneStatus =
  | {
      projectId: ProjectId;
      state: "cloning" | "pulling_large_files";
      progress: RepoCloneProgress | null;
      question: RepoCloneQuestion | null;
    }
  | {
      projectId: ProjectId;
      state: "failed";
      step: "clone" | "large_files";
      failureLine: string | null;
    }
  | { projectId: ProjectId; state: "large_files_missing" | "canceled" | "done" };
/** Wire schema for {@link RepoCloneStatus}; git sends a whole percent. */
export const RepoCloneStatusSchema: z.ZodType<RepoCloneStatus> = z.discriminatedUnion("state", [
  z
    .object({
      projectId: ProjectIdSchema,
      state: z.enum(["cloning", "pulling_large_files"]),
      progress: z
        .object({
          phase: wireFreeFormString(REPO_CLONE_LINE_MAX_LEN, "RepoCloneStatus.progress.phase"),
          percent: z.number().int().min(0).max(100).nullable(),
        })
        .strict()
        .nullable(),
      question: z
        .object({
          questionId: CloneQuestionIdSchema,
          prompt: wireFreeFormString(REPO_CLONE_LINE_MAX_LEN, "RepoCloneStatus.question.prompt"),
          masked: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      projectId: ProjectIdSchema,
      state: z.literal("failed"),
      step: z.enum(["clone", "large_files"]),
      failureLine: wireFreeFormString(
        REPO_CLONE_LINE_MAX_LEN,
        "RepoCloneStatus.failureLine",
      ).nullable(),
    })
    .strict(),
  z
    .object({
      projectId: ProjectIdSchema,
      state: z.enum(["large_files_missing", "canceled", "done"]),
    })
    .strict(),
]);

/**
 * `repo.cloneAnswer`: the answer to one of git's questions. The daemon hands it to git's askpass
 * program and nowhere else; it is never stored, logged or echoed on any reply or event, and a
 * transport that logs request bodies must redact `answer`.
 *
 * An empty answer is lawful (an empty passphrase). A line break or a NUL byte is refused: the
 * askpass program prints the answer as one line, so either would cut it short or smuggle a second.
 */
export interface RepoCloneAnswerRequest {
  projectId: ProjectId;
  questionId: CloneQuestionId;
  answer: string;
}
/** Wire schema for {@link RepoCloneAnswerRequest}. */
export const RepoCloneAnswerRequestSchema: z.ZodType<
  RepoCloneAnswerRequest,
  RepoCloneAnswerRequest
> = z
  .object({
    projectId: ProjectIdSchema,
    questionId: CloneQuestionIdSchema,
    answer: z
      .string()
      .max(REPO_CLONE_ANSWER_MAX_LEN)
      .refine((answer) => !/[\r\n\0]/u.test(answer), {
        message: "RepoCloneAnswerRequest.answer is one line with no NUL byte.",
      }),
  })
  .strict();

/** `repo.cloneFolderRead` takes nothing. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RepoCloneFolderReadRequest {}
/** Wire schema for {@link RepoCloneFolderReadRequest}. */
export const RepoCloneFolderReadRequestSchema: z.ZodType<
  RepoCloneFolderReadRequest,
  RepoCloneFolderReadRequest
> = z.object({}).strict();

/**
 * Where a clone goes, and why: the folder the person set, else the folder holding the most recently
 * attached project, else the home folder. The session picker and Settings › Projects both read
 * this one answer.
 */
export interface RepoCloneFolderReadResponse {
  folder: string;
  source: "setting" | "lastProject" | "home";
}
/** Wire schema for {@link RepoCloneFolderReadResponse}. */
export const RepoCloneFolderReadResponseSchema: z.ZodType<RepoCloneFolderReadResponse> = z
  .object({
    folder: wireFreeFormString(FILE_PATH_MAX_LEN, "RepoCloneFolderReadResponse.folder"),
    source: z.enum(["setting", "lastProject", "home"]),
  })
  .strict();
