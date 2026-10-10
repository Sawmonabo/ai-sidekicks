// A transcript row's body, and the reads that fetch what a row did not carry: a row's large body or
// full output (`transcript.bodyRead`), and every file patch a tool call left out
// (`transcript.patchRead`). A body travels with its row unless it is large; a client asks for a
// large one only when the row's control is pressed, and for a patch when its diff is drawn. Both
// reads answer with the stored text, or `absent` when the row carries none.
import { z } from "zod";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "../event/declared-variants.js";
import {
  EVENT_FIELD_MAX_LEN,
  HydratedContentUnavailableReasonSchema,
  type HydratedContentUnavailableReason,
  type HydratedSessionEventContent,
} from "../event/envelope.js";
import { wireFreeFormString, FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";

import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";
import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";
import { countSchema } from "../internal/wire-scalars.js";
import { TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES } from "./limits.js";

/** A body that waits for its row's control: too large to travel with the row, and how large. */
export interface TranscriptLargeBody {
  readonly status: "large";
  /** The whole body's UTF-8 byte length, for the control to name before it is pressed. */
  readonly contentLength: number;
}

/**
 * What a row read from history carries of its body: the body itself, why there is none, or that
 * it is large and waits for `transcript.bodyRead`. An `available` body is at most
 * `TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES` JSON bytes.
 */
export type TranscriptRowContent = HydratedSessionEventContent | TranscriptLargeBody;

/** The `available` arm, its body bounded by `bodyMaxLength` characters. */
function availableContentSchema(bodyMaxLength: number) {
  return z
    .object({
      status: z.literal("available"),
      body: z.string().max(bodyMaxLength),
      contentLength: countSchema.optional(),
      contentTruncated: z.literal(true).optional(),
    })
    .strict();
}

const unavailableContentSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: HydratedContentUnavailableReasonSchema,
  })
  .strict();

/**
 * Parses a {@link TranscriptRowContent}. An inline body's JSON bytes bound its characters from
 * above, so the length check is a cheap necessary one; the producer measures the bytes.
 */
export const TranscriptRowContentSchema: z.ZodType<TranscriptRowContent> = z.discriminatedUnion(
  "status",
  [
    availableContentSchema(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES),
    unavailableContentSchema,
    z.object({ status: z.literal("large"), contentLength: countSchema }).strict(),
  ],
);

/**
 * An event's stored body as a read reports it: `absent` when none is stored, never an empty
 * `available` body, which would claim the agent said nothing. `contentLength` and
 * `contentTruncated` are echoed from the payload, never recomputed from `body`: a recomputed length
 * would equal a truncated body's own and hide that anything was cut.
 */
export function storedBodyContentOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  storedBody: string | undefined,
): HydratedSessionEventContent {
  if (storedBody === undefined) {
    return { status: "unavailable", reason: "absent" };
  }
  const storedLength = payload?.[CONTENT_LENGTH_PAYLOAD_KEY];
  return {
    status: "available",
    body: storedBody,
    ...(typeof storedLength === "number" ? { contentLength: storedLength } : {}),
    ...(payload?.[CONTENT_TRUNCATED_PAYLOAD_KEY] === true
      ? { contentTruncated: true as const }
      : {}),
  };
}

/**
 * The body a row carries, from the stored one: a body over `TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES`
 * JSON bytes becomes the `large` arm, sized by the stored `contentLength`, else by its own bytes.
 */
export function transcriptRowContentOf(stored: HydratedSessionEventContent): TranscriptRowContent {
  if (
    stored.status !== "available" ||
    jsonUtf8ByteLength(stored.body) <= TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES
  ) {
    return stored;
  }
  return {
    status: "large",
    contentLength: stored.contentLength ?? new TextEncoder().encode(stored.body).length,
  };
}

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
    availableContentSchema(CONTENT_PAYLOAD_PLAINTEXT_MAX).superRefine((available, issueContext) => {
      requireMemberToRideOneFrame(available.body, "body", issueContext);
    }),
    unavailableContentSchema,
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
