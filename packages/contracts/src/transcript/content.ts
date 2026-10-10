// A transcript row's body, and the contracts of the reads for what a row does not carry: a row's
// large body or full output (`transcript.bodyRead`), and every file patch a tool call left out
// (`transcript.patchRead`). A body travels with its row unless it is large, when the row carries
// its size alone. Both reads answer with the stored text, or `absent` when the row carries none.
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

/** A body too large to travel with its row: the arm carries its size alone. */
export interface TranscriptLargeBody {
  readonly status: "large";
  /** The whole body's UTF-8 byte length, as the stored event states it. */
  readonly contentLength: number;
  /** Present when the stored body is a prefix of a longer one the producer cut. */
  readonly contentTruncated?: true | undefined;
}

/**
 * What a row read from history carries of its body: the body itself, why there is none, or the
 * size alone of a large one. An `available` body serializes to at most
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
 * Parses a {@link TranscriptRowContent}. The character bound is a cheap first check, since a
 * body's JSON bytes are never fewer than its characters; the refinement measures the bytes.
 */
export const TranscriptRowContentSchema: z.ZodType<TranscriptRowContent> = z.discriminatedUnion(
  "status",
  [
    availableContentSchema(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES).superRefine(
      (available, issueContext) => {
        const byteLength = jsonUtf8ByteLength(available.body);
        if (byteLength > TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES) {
          issueContext.addIssue({
            code: "custom",
            path: ["body"],
            message:
              `a body that travels with its row takes at most ` +
              `${String(TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES)} JSON bytes; this one takes ` +
              `${String(byteLength)}, so it belongs on the large arm`,
          });
        }
      },
    ),
    unavailableContentSchema,
    z
      .object({
        status: z.literal("large"),
        contentLength: countSchema,
        contentTruncated: z.literal(true).optional(),
      })
      .strict(),
  ],
);

/**
 * The length and truncation mark a stored event's payload states for its body, echoed rather than
 * recomputed: a length measured from a cut body would equal its own and hide that anything was cut.
 */
function echoedBodyFactsOf(payload: Readonly<Record<string, unknown>> | undefined): {
  readonly contentLength?: number;
  readonly contentTruncated?: true;
} {
  const storedLength = payload?.[CONTENT_LENGTH_PAYLOAD_KEY];
  return {
    ...(typeof storedLength === "number" ? { contentLength: storedLength } : {}),
    ...(payload?.[CONTENT_TRUNCATED_PAYLOAD_KEY] === true
      ? { contentTruncated: true as const }
      : {}),
  };
}

/**
 * An event's stored body as a read reports it: `absent` when none is stored, never an empty
 * `available` body, which would claim the agent said nothing. The length and truncation mark are
 * the payload's own.
 */
export function storedBodyContentOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  storedBody: string | undefined,
): HydratedSessionEventContent {
  if (storedBody === undefined) {
    return { status: "unavailable", reason: "absent" };
  }
  return { status: "available", body: storedBody, ...echoedBodyFactsOf(payload) };
}

/**
 * A stored body as a row read finds it: its UTF-8 size, and its text when that size still lets it
 * travel with its row (at most `TRANSCRIPT_ROW_BODY_INLINE_MAX_UTF8_BYTES`).
 */
export interface StoredRowBody {
  readonly byteLength: number;
  readonly body?: string | undefined;
}

/**
 * The body a row carries, from what the read found stored: none is `absent`; a body whose JSON
 * takes more than `TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES` bytes, or whose text was not read, is the
 * `large` arm, sized by the payload's `contentLength`, else by its stored bytes.
 */
export function transcriptRowContentOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  stored: StoredRowBody | undefined,
): TranscriptRowContent {
  if (stored === undefined) {
    return { status: "unavailable", reason: "absent" };
  }
  if (
    stored.body !== undefined &&
    jsonUtf8ByteLength(stored.body) <= TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES
  ) {
    return storedBodyContentOf(payload, stored.body);
  }
  const { contentLength, contentTruncated } = echoedBodyFactsOf(payload);
  return {
    status: "large",
    contentLength: contentLength ?? stored.byteLength,
    ...(contentTruncated === undefined ? {} : { contentTruncated }),
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
