// The reads that fetch what a transcript row did not carry: a row's large body or full output
// (`transcript.bodyRead`), and every file patch a tool call left out (`transcript.patchRead`). A
// client asks only when the row's control is pressed or its diff is drawn. Both answer with the
// stored text, or `absent` when the row carries none.
import { z } from "zod";

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "../../event/declared-variants.js";
import {
  EVENT_FIELD_MAX_LEN,
  HydratedContentUnavailableReasonSchema,
  type HydratedContentUnavailableReason,
  type HydratedSessionEventContent,
} from "../../event/envelope.js";
import { jsonUtf8ByteLength } from "../../jsonrpc/jsonrpc.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "../../session/session.js";

import { TRANSCRIPT_PAGE_MAX_BYTES } from "../operations.js";
import { countSchema } from "../../internal/wire-scalars.js";

/** Refuse stored text over the page budget, so an oversized reply is a failed read. */
const requireMemberToRideOneFrame = (
  member: unknown,
  memberName: string,
  issueContext: z.RefinementCtx,
): void => {
  const measuredBytes = jsonUtf8ByteLength(member);
  if (measuredBytes > TRANSCRIPT_PAGE_MAX_BYTES) {
    issueContext.addIssue({
      code: "custom",
      path: [memberName],
      message:
        `${memberName} measures ${String(measuredBytes)} JSON bytes, over the ` +
        `${String(TRANSCRIPT_PAGE_MAX_BYTES)}-byte page budget`,
    });
  }
};

// transcript.bodyRead

/**
 * The one row whose large body or full output a client opens when its control is pressed.
 * `rowId` is the row's `id`, the id of the event the row renders.
 */
export interface TranscriptBodyReadRequest {
  sessionId: SessionId;
  rowId: string;
}

/** Parses a {@link TranscriptBodyReadRequest}. */
export const TranscriptBodyReadRequestSchema: z.ZodType<
  TranscriptBodyReadRequest,
  TranscriptBodyReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    rowId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptBodyReadRequest.rowId"),
  })
  .strict();

/**
 * The row's body, or why it cannot be read. `contentLength` and
 * `contentTruncated` are echoed from the signed event, so a body kept as a
 * prefix still says how long the whole was.
 */
export type TranscriptBodyReadResponse = HydratedSessionEventContent;

/** Parses a {@link TranscriptBodyReadResponse}. */
export const TranscriptBodyReadResponseSchema: z.ZodType<TranscriptBodyReadResponse> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        body: z.string().max(CONTENT_PAYLOAD_PLAINTEXT_MAX),
        contentLength: countSchema.optional(),
        contentTruncated: z.literal(true).optional(),
      })
      .strict()
      .superRefine((available, issueContext) => {
        requireMemberToRideOneFrame(available.body, "body", issueContext);
      }),
    z
      .object({
        status: z.literal("unavailable"),
        reason: HydratedContentUnavailableReasonSchema,
      })
      .strict(),
  ]);

// transcript.patchRead

/** The tool call whose left-out patches a diff needs. */
export interface TranscriptPatchReadRequest {
  sessionId: SessionId;
  toolCallId: string;
}

/** Parses a {@link TranscriptPatchReadRequest}. */
export const TranscriptPatchReadRequestSchema: z.ZodType<
  TranscriptPatchReadRequest,
  TranscriptPatchReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    toolCallId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TranscriptPatchReadRequest.toolCallId"),
  })
  .strict();

/** One file's patch, or why it cannot be read. */
export type TranscriptPatchFile =
  | { path: string; patch: string }
  | { path: string; unavailable: HydratedContentUnavailableReason };

/**
 * Every patch the call left out, in one reply, so a call with several missing
 * files is drawn from one read.
 */
export interface TranscriptPatchReadResponse {
  files: TranscriptPatchFile[];
}

const patchPathSchema = wireFreeFormString(FILE_PATH_MAX_LEN, "TranscriptPatchFile.path");

/** Parses a {@link TranscriptPatchReadResponse}. */
export const TranscriptPatchReadResponseSchema: z.ZodType<TranscriptPatchReadResponse> = z
  .object({
    files: z.array(
      z.union([
        z
          .object({ path: patchPathSchema, patch: z.string().max(CONTENT_PAYLOAD_PLAINTEXT_MAX) })
          .strict(),
        z
          .object({ path: patchPathSchema, unavailable: HydratedContentUnavailableReasonSchema })
          .strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((response, issueContext) => {
    requireMemberToRideOneFrame(response.files, "files", issueContext);
  });
