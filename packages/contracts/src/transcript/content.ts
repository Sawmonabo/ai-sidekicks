// A transcript row's body as a row read and a body read report it, from what is stored: a body
// travels with its row unless it is large, when the row carries its size alone, and a body read
// answers the stored text one page at a time from any character boundary, or why there is none.
import { CONTENT_LENGTH_PAYLOAD_KEY } from "../generated/event/declared-variants.js";
import { PAGE_MAX_BYTES } from "../generated/jsonrpc/page.js";
import { TRANSCRIPT_ROW_BODY_INLINE_MAX_BYTES } from "../generated/transcript/limits.js";
import type { RefusalCode } from "../generated/jsonrpc/refusal.js";
import type { TranscriptBodyReadResponse } from "../generated/transcript/operations.js";
import type { BlockCutFailure, TranscriptRowContent } from "../generated/transcript/row.js";
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
 * Where one block of a prose body starts: in the stored body, as a UTF-8 byte offset, which decides
 * the part of a body read that carries it, and in the text the screen draws, as the UTF-16 offset
 * the wire carries.
 */
export interface BodyBlockStart {
  readonly storedOffset: number;
  readonly drawnOffset: number;
}

/**
 * What a body read carries of its body's markdown cut: nothing for a body that is not prose, the
 * starts of the whole body ascending, of which each part carries those that fall in it, or why the
 * cut failed, which every part says.
 */
export type BodyBlockCut =
  | { readonly kind: "notCut" }
  | { readonly kind: "starts"; readonly starts: readonly BodyBlockStart[] }
  | { readonly kind: "failed"; readonly failure: BlockCutFailure };

/**
 * Thrown for a `transcript.body.read` offset that is no place to resume from: inside a character,
 * or past the body's end.
 */
export class BodyReadOffsetRefusedError extends Error {
  readonly code: Extract<RefusalCode, "transcript.body.offsetInvalid"> =
    "transcript.body.offsetInvalid";
  /** The refused offset, as the client sent it. */
  readonly offset: number;
  /** The body's UTF-8 byte length. */
  readonly bodyLength: number;
  constructor(offset: number, bodyLength: number) {
    super(
      `offset ${String(offset)} is inside a character or past the body's ${String(bodyLength)} bytes`,
    );
    this.name = "BodyReadOffsetRefusedError";
    this.offset = offset;
    this.bodyLength = bodyLength;
  }
}

/**
 * The UTF-16 index in `text` of each of the ascending UTF-8 byte offsets `byteOffsets`, or
 * `undefined` for one inside a character or past the end.
 */
function utf16IndexesOf(text: string, byteOffsets: readonly number[]): (number | undefined)[] {
  const indexes: (number | undefined)[] = [];
  let index = 0;
  let byteOffset = 0;
  for (const wanted of byteOffsets) {
    while (byteOffset < wanted && index < text.length) {
      const codePoint = text.codePointAt(index) ?? 0;
      byteOffset += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
      index += codePoint < 0x10000 ? 1 : 2;
    }
    indexes.push(byteOffset === wanted ? index : undefined);
  }
  return indexes;
}

/** How many of the ascending `indexes` fall before `end`. */
function countBefore(indexes: readonly number[], end: number): number {
  let low = 0;
  let high = indexes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((indexes[middle] ?? end) < end) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Where the part of `body` that starts at UTF-16 index `start` ends: the furthest code point
 * boundary for which `fits` holds of the end and the stretch's JSON bytes; `fits` grows stricter
 * as the end moves on. One character's JSON and its one start fit a page, so a part short of the
 * end holds at least one character.
 */
function pageEnd(
  body: string,
  start: number,
  fits: (end: number, jsonBytes: number) => boolean,
): number {
  const fitsAt = (end: number): boolean => fits(end, jsonUtf8ByteLength(body.slice(start, end)));
  if (fitsAt(body.length)) {
    return body.length;
  }
  // The fitting ends form a prefix of the boundaries, so the last one is found by halving.
  let fitting = start;
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
    if (fitsAt(middle)) {
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
 * A row's body as `transcript.body.read` reports it, the part that starts at the UTF-8 byte
 * `offset`: `absent` when none is stored, never an empty `available` body, which would claim the
 * agent said nothing. A part holds as much of the body as fits one page and names the offset the
 * next part starts at, `null` on the last, so reading from each `nextOffset` joins the whole body.
 * The length is the payload's own. Each part carries the block starts of `blockCut` that fall in
 * it, four bytes each charged against its page, or the cut's failure. Throws
 * `BodyReadOffsetRefusedError` for an offset inside a character or past the end.
 */
export function storedBodyContentOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  storedBody: string | undefined,
  offset = 0,
  blockCut: BodyBlockCut = { kind: "notCut" },
): TranscriptBodyReadResponse {
  if (storedBody === undefined) {
    return { status: "unavailable", reason: "absent" };
  }
  const [start] = utf16IndexesOf(storedBody, [offset]);
  if (start === undefined) {
    throw new BodyReadOffsetRefusedError(offset, new TextEncoder().encode(storedBody).length);
  }
  const blockStarts = blockCut.kind === "starts" ? blockCut.starts : [];
  // The daemon's cut puts each start on a character boundary inside the body.
  const startIndexes = utf16IndexesOf(
    storedBody,
    blockStarts.map((blockStart) => blockStart.storedOffset),
  ).map((index) => index ?? storedBody.length);
  const firstStart = countBefore(startIndexes, start);
  const end = pageEnd(
    storedBody,
    start,
    (partEnd, jsonBytes) =>
      jsonBytes + 4 * (countBefore(startIndexes, partEnd) - firstStart) <= PAGE_MAX_BYTES,
  );
  const partStarts = blockStarts.slice(firstStart, countBefore(startIndexes, end));
  const body = storedBody.slice(start, end);
  const contentLength = echoedContentLengthOf(payload);
  return {
    status: "available",
    body,
    offset,
    nextOffset: end === storedBody.length ? null : offset + new TextEncoder().encode(body).length,
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(partStarts.length === 0 ? {} : { blockStarts: littleEndianDrawnOffsets(partStarts) }),
    ...(blockCut.kind === "failed" ? { blockCutFailure: blockCut.failure } : {}),
  };
}

/** The drawn offsets of `starts`, each a little-endian u32, as the wire's block starts carry them. */
function littleEndianDrawnOffsets(starts: readonly BodyBlockStart[]): Uint8Array {
  const bytes = new Uint8Array(4 * starts.length);
  const view = new DataView(bytes.buffer);
  starts.forEach((blockStart, index) => {
    view.setUint32(4 * index, blockStart.drawnOffset, true);
  });
  return bytes;
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
