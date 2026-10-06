// LSP-style `Content-Length: <bytes>\r\n\r\n<body>` framing on a byte stream: the one framing the
// daemon's socket, its clients and the PTY sidecar's stdio share. Each reader supplies its own body
// limit; any framing violation throws, because a desynced stream cannot be resynchronized. Bytes
// are plain `Uint8Array`s, so every runtime can use it; a Node `Buffer` is one.

import { MAX_MESSAGE_BYTES, type JsonRpcMessage } from "./jsonrpc/message.js";

// The framing header name: matched case-insensitively on receive, emitted in this casing.
const CONTENT_LENGTH_HEADER = "Content-Length";

// Ends the header section (CRLFCRLF, as in LSP framing).
const HEADER_BODY_SEPARATOR = "\r\n\r\n";

// Encoding keeps no state between calls, so every frame shares one encoder.
const UTF8_ENCODER = new TextEncoder();

const SEPARATOR_BYTES: Uint8Array = UTF8_ENCODER.encode(HEADER_BODY_SEPARATOR);

/**
 * Largest accepted header section, in bytes before the separator. Without it a peer that never
 * sends the separator would grow the accumulator without bound; real headers are tens of bytes.
 */
const MAX_HEADER_BYTES: number = 1024;

/**
 * Result of one `parseFrame` call: a complete body and the bytes to drop from the head of the
 * accumulator, or `{ frame: null, consumed: 0 }` while no whole frame has arrived.
 */
export interface ParseFrameResult {
  /** A copy of the body bytes, or `null` until a whole frame has arrived. */
  readonly frame: Uint8Array | null;
  /** Bytes to drop from the head of the accumulator when `frame !== null`, else 0. */
  readonly consumed: number;
}

/**
 * A framing or envelope violation. `code` is a stable string the daemon's error mapping turns into
 * the numeric code and `data.type`, and the optional `fields` become `data.fields`.
 */
export class FramingError extends Error {
  readonly code: string;
  readonly fields?: Record<string, unknown>;
  constructor(code: string, message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "FramingError";
    this.code = code;
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}

/**
 * Parses one frame from the head of `bytes`, or answers `{ frame: null, consumed: 0 }` until it is
 * whole. Throws `FramingError` on any framing violation.
 */
export function parseFrame(bytes: Uint8Array, maxBodyBytes: number): ParseFrameResult {
  // The length counts bytes, not characters, so a multi-byte UTF-8 body is sliced by byte count;
  // the body is copied verbatim and decoding it is the caller's job.
  const separatorIndex = indexOfSeparator(bytes);
  // The header cap applies whether or not the delimiter has arrived. A peer that streams
  // megabytes of header without CRLFCRLF would otherwise pin the accumulator, and one that sends
  // megabytes of header followed by CRLFCRLF would otherwise be parsed in full.
  if (separatorIndex === -1) {
    if (bytes.byteLength > MAX_HEADER_BYTES) {
      throw new FramingError(
        "header_too_long",
        `parseFrame: header section exceeded ${MAX_HEADER_BYTES} bytes without ` +
          `${JSON.stringify(HEADER_BODY_SEPARATOR)} (likely framing desync)`,
      );
    }
    return { frame: null, consumed: 0 };
  }
  if (separatorIndex > MAX_HEADER_BYTES) {
    throw new FramingError(
      "header_too_long",
      `parseFrame: header section is ${separatorIndex} bytes (with delimiter present); ` +
        `exceeds ${MAX_HEADER_BYTES} byte cap`,
    );
  }

  const headerText = String.fromCharCode(...bytes.subarray(0, separatorIndex));
  const declaredLength = extractContentLength(headerText);

  if (declaredLength > maxBodyBytes) {
    // The gateway turns this into an `oversized_body` disconnect; `fields` feed `data.fields`.
    throw new FramingError(
      "oversized_body",
      `parseFrame: declared body length ${declaredLength} exceeds ${maxBodyBytes} byte limit`,
      { limit: maxBodyBytes, observed: declaredLength },
    );
  }

  const bodyStart = separatorIndex + SEPARATOR_BYTES.byteLength;
  const bodyEnd = bodyStart + declaredLength;
  if (bytes.byteLength < bodyEnd) {
    // The header is here but the body has not fully arrived; the caller keeps accumulating.
    return { frame: null, consumed: 0 };
  }

  // Copy: `subarray` is a view, and the caller drops head bytes from the accumulator.
  return { frame: new Uint8Array(bytes.subarray(bodyStart, bodyEnd)), consumed: bodyEnd };
}

// The accumulator's first size, enough for most frames; it doubles when a frame outgrows it.
const ACCUMULATOR_FIRST_BYTES: number = 64 * 1024;

/**
 * The bytes one stream has received and not yet framed, copied a bounded number of times however
 * many reads a frame takes; once drained, a buffer a large frame grew goes back to its first size.
 */
export class FrameAccumulator {
  // `append` copies a chunk in place, moving the unframed bytes only when the chunk does not fit
  // behind them.
  readonly #maxBodyBytes: number;
  // The unframed bytes are `#bytes[#readOffset, #writeOffset)`.
  #bytes: Uint8Array = new Uint8Array(ACCUMULATOR_FIRST_BYTES);
  #readOffset = 0;
  #writeOffset = 0;

  /** `maxBodyBytes` is the largest frame body this stream accepts. */
  constructor(maxBodyBytes: number) {
    this.#maxBodyBytes = maxBodyBytes;
  }

  /** Adds received bytes behind the ones not yet framed. */
  append(chunk: Uint8Array): void {
    if (this.#bytes.byteLength - this.#writeOffset < chunk.byteLength) {
      const pendingBytes = this.#writeOffset - this.#readOffset;
      const neededBytes = pendingBytes + chunk.byteLength;
      if (neededBytes > this.#bytes.byteLength) {
        let capacity = this.#bytes.byteLength * 2;
        while (capacity < neededBytes) {
          capacity *= 2;
        }
        const grown = new Uint8Array(capacity);
        grown.set(this.#bytes.subarray(this.#readOffset, this.#writeOffset));
        this.#bytes = grown;
      } else {
        this.#bytes.copyWithin(0, this.#readOffset, this.#writeOffset);
      }
      this.#readOffset = 0;
      this.#writeOffset = pendingBytes;
    }
    this.#bytes.set(chunk, this.#writeOffset);
    this.#writeOffset += chunk.byteLength;
  }

  /**
   * Takes the next complete frame's body off the head, or answers `null` until one has arrived.
   * Throws `FramingError` as `parseFrame` does; the stream is then desynced and is to be closed.
   */
  nextFrame(): Uint8Array | null {
    const result = parseFrame(
      this.#bytes.subarray(this.#readOffset, this.#writeOffset),
      this.#maxBodyBytes,
    );
    if (result.frame === null) {
      return null;
    }
    this.#readOffset += result.consumed;
    if (this.#readOffset === this.#writeOffset) {
      this.#readOffset = 0;
      this.#writeOffset = 0;
      if (this.#bytes.byteLength > ACCUMULATOR_FIRST_BYTES) {
        this.#bytes = new Uint8Array(ACCUMULATOR_FIRST_BYTES);
      }
    }
    return result.frame;
  }
}

/**
 * Encode a JSON-RPC envelope as a Content-Length frame; the header carries the body's UTF-8 byte
 * count. Throws `FramingError("oversized_body")` past `MAX_MESSAGE_BYTES`, so an oversized message
 * fails at its sender with provenance instead of tripping the peer's inbound check.
 */
export function encodeFrame(envelope: JsonRpcMessage): Uint8Array {
  const bodyBytes = UTF8_ENCODER.encode(JSON.stringify(envelope));
  const declaredLength = bodyBytes.byteLength;

  if (declaredLength > MAX_MESSAGE_BYTES) {
    throw new FramingError(
      "oversized_body",
      `encodeFrame: encoded body length ${declaredLength} exceeds ${MAX_MESSAGE_BYTES} byte limit`,
      { limit: MAX_MESSAGE_BYTES, observed: declaredLength },
    );
  }

  const headerBytes = UTF8_ENCODER.encode(
    `${CONTENT_LENGTH_HEADER}: ${declaredLength}${HEADER_BODY_SEPARATOR}`,
  );
  const frame = new Uint8Array(headerBytes.byteLength + declaredLength);
  frame.set(headerBytes, 0);
  frame.set(bodyBytes, headerBytes.byteLength);
  return frame;
}

// The index of the first CRLFCRLF in `bytes`, or -1.
function indexOfSeparator(bytes: Uint8Array): number {
  const last = bytes.byteLength - SEPARATOR_BYTES.byteLength;
  for (let start = 0; start <= last; start += 1) {
    let isMatch = true;
    for (let offset = 0; offset < SEPARATOR_BYTES.byteLength; offset += 1) {
      if (bytes[start + offset] !== SEPARATOR_BYTES[offset]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      return start;
    }
  }
  return -1;
}

/**
 * Extract the `Content-Length` value from the header section: name matched case-insensitively,
 * value a strict decimal integer. Throws `FramingError` when it is missing or duplicate, or when a
 * header line breaks the `<name>: <value>` grammar; any deviation ends in a disconnect, never a
 * best-effort recovery.
 */
function extractContentLength(headerText: string): number {
  // Lone-LF line terminators are rejected: lenient parsing would mask peer bugs.
  if (headerText.length > 0 && headerText.includes("\n") && !headerText.includes("\r\n")) {
    throw new FramingError(
      "malformed_header",
      "parseFrame: header section uses LF line terminator; expected CRLF per LSP framing",
    );
  }
  const lines = headerText.length === 0 ? [] : headerText.split("\r\n");
  let declaredLength: number | null = null;
  for (const line of lines) {
    if (line.length === 0) {
      // The CRLFCRLF separator ends the headers, so an earlier empty line is malformed.
      throw new FramingError("malformed_header", "parseFrame: empty line within header section");
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      throw new FramingError(
        "malformed_header",
        `parseFrame: header line missing ':' separator: ${JSON.stringify(line)}`,
      );
    }
    const name = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (name.length === 0) {
      throw new FramingError(
        "malformed_header",
        `parseFrame: header line has empty name: ${JSON.stringify(line)}`,
      );
    }
    if (name.toLowerCase() === CONTENT_LENGTH_HEADER.toLowerCase()) {
      // Duplicate Content-Length headers are a request-smuggling shape: taking the last would
      // slice one length from a buffer carrying the other, and the remainder would be read as a
      // fresh frame.
      if (declaredLength !== null) {
        throw new FramingError(
          "malformed_content_length",
          `parseFrame: duplicate ${CONTENT_LENGTH_HEADER} header (request-smuggling shape)`,
        );
      }
      // Digits only: no sign, hex, exponent or inner whitespace.
      if (!/^\d+$/.test(value)) {
        throw new FramingError(
          "malformed_content_length",
          `parseFrame: Content-Length value ${JSON.stringify(value)} is not a non-negative ` +
            `decimal integer`,
        );
      }
      const parsed = Number.parseInt(value, 10);
      // Hundreds of digits parse to `Infinity`.
      if (!Number.isFinite(parsed)) {
        throw new FramingError(
          "malformed_content_length",
          `parseFrame: Content-Length value ${JSON.stringify(value)} is not finite`,
        );
      }
      declaredLength = parsed;
    }
    // Other header names (such as `Content-Type`) are ignored.
  }
  if (declaredLength === null) {
    throw new FramingError(
      "missing_content_length",
      `parseFrame: header section did not include ${CONTENT_LENGTH_HEADER}`,
    );
  }
  return declaredLength;
}
