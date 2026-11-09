// A transcript row's body as a row read and a body read report it, from what is stored: a body
// travels with its row unless it is large, when the row carries its size alone, and a body read
// answers the stored text one page at a time, or why there is none.
import { CONTENT_LENGTH_PAYLOAD_KEY } from "../generated/event/declared-variants.js";
import { PAGE_MAX_BYTES } from "../generated/jsonrpc/page.js";
import { TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES } from "../generated/transcript/limits.js";
import type { TranscriptBodyReadResponse } from "../generated/transcript/operations.js";
import type { TranscriptRowContent } from "../generated/transcript/row.js";
import { jsonUtf8ByteLength } from "../jsonrpc/byte-length.js";

/**
 * The length a stored event's payload states for its body, echoed rather than recomputed, so a
 * reader that loaded only part of the body still reports the whole body's length. Only a whole
 * number from 0 to 2^53 − 1 is a length.
 */
function echoedContentLengthOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const length = payload?.[CONTENT_LENGTH_PAYLOAD_KEY];
  return Number.isSafeInteger(length) && (length as number) >= 0 ? (length as number) : undefined;
}

/**
 * Where the first part of `body` ends, in UTF-16 code units: the furthest code point boundary
 * whose stretch's JSON fits one page. One character's JSON fits a page, so a part short of the
 * end holds at least one character.
 */
function firstPageEnd(body: string): number {
  if (jsonUtf8ByteLength(body) <= PAGE_MAX_BYTES) {
    return body.length;
  }
  // The fitting ends form a prefix of the boundaries, so the last one is found by halving.
  let fitting = 0;
  let over = body.length;
  while (over - fitting > 1) {
    let middle = fitting + Math.floor((over - fitting) / 2);
    // Never between the two halves of a surrogate pair: past the pair, or before it.
    if (isLowSurrogate(body.charCodeAt(middle))) {
      if (middle + 1 < over) {
        middle += 1;
      } else if (middle - 1 > fitting) {
        middle -= 1;
      } else {
        break;
      }
    }
    if (jsonUtf8ByteLength(body.slice(0, middle)) <= PAGE_MAX_BYTES) {
      fitting = middle;
    } else {
      over = middle;
    }
  }
  return fitting;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * A row's body as `transcript.body.read` reports its first part: `absent` when none is stored,
 * never an empty `available` body, which would claim the agent said nothing. A part holds as much
 * of the body as fits one page and names the UTF-8 byte offset the next part starts at, `null` on
 * the last. The length is the payload's own.
 */
export function storedBodyContentOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  storedBody: string | undefined,
): TranscriptBodyReadResponse {
  if (storedBody === undefined) {
    return { status: "unavailable", reason: "absent" };
  }
  const end = firstPageEnd(storedBody);
  const contentLength = echoedContentLengthOf(payload);
  return {
    status: "available",
    body: storedBody.slice(0, end),
    offset: 0,
    nextOffset:
      end === storedBody.length ? null : new TextEncoder().encode(storedBody.slice(0, end)).length,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

/** A stored body as a row read finds it: its UTF-8 length, and its text when it was read. */
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
  const contentLength = echoedContentLengthOf(payload);
  if (
    stored.body !== undefined &&
    jsonUtf8ByteLength(stored.body) <= TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES
  ) {
    return {
      status: "available",
      body: stored.body,
      ...(contentLength === undefined ? {} : { contentLength }),
    };
  }
  return { status: "large", contentLength: contentLength ?? stored.byteLength };
}
