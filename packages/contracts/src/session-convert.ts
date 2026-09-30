// Converting a chat to a project: the request, the copy's outcome and the `session.converted`
// payload. Kept apart from the session directory because the session event union imports the
// payload and the directory imports that union.
import { z } from "zod";

import { RepoMountIdSchema, type RepoMountId } from "./repo.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "./session.js";

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
 * How many of the workspace's files were copied into the repository, and which were not
 * because the repository already holds that path: those stay in the chat's workspace, which
 * the session keeps, and nothing is merged. Paths are relative to the workspace.
 */
export interface SessionConvertResponse {
  copiedCount: number;
  skippedPaths: string[];
}
const sessionConvertOutcomeFields = {
  copiedCount: z.number().int().nonnegative(),
  skippedPaths: z.array(
    wireFreeFormString(FILE_PATH_MAX_LEN, "SessionConvertResponse.skippedPaths"),
  ),
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
