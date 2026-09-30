// The reads that fetch what a transcript row did not carry: a row's large body or full output
// (`timeline.bodyRead`), and every file patch a tool call left out (`timeline.patchRead`). A
// surface asks only when its control is pressed or its diff is drawn. Both answer with the
// stored text or a closed reason it cannot be read: the body never existed, or this daemon
// cannot open it. A deleted session's rows are stubs no transcript draws, so "purged" is not a
// reason either read gives.
import { z } from "zod";

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "../event-declared-variants.js";
import {
  EVENT_FIELD_MAX_LEN,
  type HydratedContentUnavailableReason,
  type HydratedSessionEventContent,
} from "../event-envelope.js";
import { jsonUtf8ByteLength } from "../jsonrpc.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  type SessionId,
  FILE_PATH_MAX_LEN,
} from "../session.js";

import { TIMELINE_PAGE_MAX_BYTES } from "./operations.js";

/** Why stored text cannot be read back. */
export type StoredContentUnavailableReason = Exclude<HydratedContentUnavailableReason, "purged">;

/** Every {@link StoredContentUnavailableReason}, as a value. */
export const STORED_CONTENT_UNAVAILABLE_REASONS = [
  "absent",
  "master_key_unavailable",
  "wrapped_key_missing",
  "decrypt_failed",
] as const;

/** Parses a {@link StoredContentUnavailableReason}. */
export const StoredContentUnavailableReasonSchema: z.ZodType<StoredContentUnavailableReason> =
  z.enum(STORED_CONTENT_UNAVAILABLE_REASONS);

/**
 * Refuse stored text a reply could not carry inside one frame. A frame past the bound closes
 * the connection, so this keeps an oversized reply a failed read.
 */
const requireMemberToRideOneFrame = (
  member: unknown,
  memberName: string,
  issueContext: z.RefinementCtx,
): void => {
  const measuredBytes = jsonUtf8ByteLength(member);
  if (measuredBytes > TIMELINE_PAGE_MAX_BYTES) {
    issueContext.addIssue({
      code: "custom",
      path: [memberName],
      message:
        `${memberName} measures ${String(measuredBytes)} JSON bytes, over the ` +
        `${String(TIMELINE_PAGE_MAX_BYTES)}-byte bound one reply frame holds`,
    });
  }
};

// timeline.bodyRead

/**
 * The one row whose large body or full output a surface opens when its control
 * is pressed. `rowId` is the row's `id`, which is the id of the event the row
 * renders.
 */
export interface TimelineBodyReadRequest {
  sessionId: SessionId;
  rowId: string;
}

/** Parses a {@link TimelineBodyReadRequest}. */
export const TimelineBodyReadRequestSchema: z.ZodType<
  TimelineBodyReadRequest,
  TimelineBodyReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    rowId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelineBodyReadRequest.rowId"),
  })
  .strict();

/**
 * The row's body, or why it cannot be read. `contentLength` and
 * `contentTruncated` are echoed from the signed event, so a body kept as a
 * prefix still says how long the whole was.
 */
export type TimelineBodyReadResponse = HydratedSessionEventContent;

/** Parses a {@link TimelineBodyReadResponse}. */
export const TimelineBodyReadResponseSchema: z.ZodType<TimelineBodyReadResponse> =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        body: z.string().max(CONTENT_PAYLOAD_PLAINTEXT_MAX),
        contentLength: z.number().int().nonnegative().optional(),
        contentTruncated: z.literal(true).optional(),
      })
      .strict()
      .superRefine((available, issueContext) => {
        requireMemberToRideOneFrame(available.body, "body", issueContext);
      }),
    z
      .object({
        status: z.literal("unavailable"),
        reason: StoredContentUnavailableReasonSchema,
      })
      .strict(),
  ]);

// timeline.patchRead

/** The tool call whose left-out patches a diff needs. */
export interface TimelinePatchReadRequest {
  sessionId: SessionId;
  toolCallId: string;
}

/** Parses a {@link TimelinePatchReadRequest}. */
export const TimelinePatchReadRequestSchema: z.ZodType<
  TimelinePatchReadRequest,
  TimelinePatchReadRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    toolCallId: wireFreeFormString(EVENT_FIELD_MAX_LEN, "TimelinePatchReadRequest.toolCallId"),
  })
  .strict();

/** One file's patch, or why it cannot be read. */
export type TimelinePatchFile =
  | { path: string; patch: string }
  | { path: string; unavailable: StoredContentUnavailableReason };

/**
 * Every patch the call left out, in one reply, so a call with several missing
 * files is drawn from one read.
 */
export interface TimelinePatchReadResponse {
  files: TimelinePatchFile[];
}

const patchPathSchema = wireFreeFormString(FILE_PATH_MAX_LEN, "TimelinePatchFile.path");

/** Parses a {@link TimelinePatchReadResponse}. */
export const TimelinePatchReadResponseSchema: z.ZodType<TimelinePatchReadResponse> = z
  .object({
    files: z.array(
      z.union([
        z
          .object({ path: patchPathSchema, patch: z.string().max(CONTENT_PAYLOAD_PLAINTEXT_MAX) })
          .strict(),
        z
          .object({ path: patchPathSchema, unavailable: StoredContentUnavailableReasonSchema })
          .strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((response, issueContext) => {
    requireMemberToRideOneFrame(response.files, "files", issueContext);
  });
