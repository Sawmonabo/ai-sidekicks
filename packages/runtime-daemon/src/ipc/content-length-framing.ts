// LSP-style `Content-Length: <bytes>\r\n\r\n<body>` framing on a byte stream, shared by the local
// IPC gateway and the PTY sidecar's stdio. Each caller supplies its own body limit; any framing
// violation throws, because a desynced stream cannot be resynchronized.

import { Buffer } from "node:buffer";

/** The framing header name: matched case-insensitively on receive, emitted in this casing. */
export const CONTENT_LENGTH_HEADER = "Content-Length";

/** Ends the header section (CRLFCRLF, as in LSP framing). */
export const HEADER_BODY_SEPARATOR = "\r\n\r\n";

/**
 * Largest accepted header section, in bytes before the separator. Without it a peer that never
 * sends the separator would grow the accumulator without bound; real headers are tens of bytes.
 */
export const MAX_HEADER_BYTES: number = 1024;

/**
 * Result of one `parseFrame` call against a connection's accumulating buffer. `frame !== null`
 * is a complete body, and `consumed` bytes must be dropped from the head of the accumulator.
 * `frame === null` with `consumed === 0` means the buffer holds no complete frame yet: a normal
 * case on a stream transport, not an error. Framing violations throw `FramingError` instead.
 */
export interface ParseFrameResult {
  /** The body bytes, or `null` until a whole frame has arrived. */
  readonly frame: Buffer | null;
  /** Bytes to drop from the buffer head when `frame !== null`, else 0. */
  readonly consumed: number;
}

/**
 * A framing or envelope violation. `code` is a stable string that `mapJsonRpcError` turns into the
 * numeric code and `data.type`, and the optional `fields` become `data.fields`.
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
 * Parse one `Content-Length: <bytes>\r\n\r\n<body>` frame from the head of `buffer`. The length
 * counts bytes, not characters, so a multi-byte UTF-8 body is sliced by byte count; the returned
 * slice is the verbatim body and JSON parsing is the caller's job.
 *
 * Returns `{ frame: null, consumed: 0 }` while the header or body is incomplete. Throws
 * `FramingError` for a missing, duplicate or non-numeric `Content-Length`, a declared length over
 * `maxBodyBytes`, or a header section that breaks the `<name>: <value>` grammar or exceeds
 * `MAX_HEADER_BYTES`.
 */
export function parseFrame(buffer: Buffer, maxBodyBytes: number): ParseFrameResult {
  const separatorIndex = buffer.indexOf(HEADER_BODY_SEPARATOR);
  // The header cap applies whether or not the delimiter has arrived. A peer that streams
  // megabytes of header without CRLFCRLF would otherwise pin the accumulator, and one that sends
  // megabytes of header followed by CRLFCRLF would otherwise be parsed in full. Real headers are
  // tens of bytes.
  if (separatorIndex === -1) {
    if (buffer.byteLength > MAX_HEADER_BYTES) {
      throw new FramingError(
        "header_too_long",
        `parseFrame: header section exceeded ${MAX_HEADER_BYTES} bytes without ${JSON.stringify(HEADER_BODY_SEPARATOR)} (likely framing desync)`,
      );
    }
    return { frame: null, consumed: 0 };
  }
  if (separatorIndex > MAX_HEADER_BYTES) {
    throw new FramingError(
      "header_too_long",
      `parseFrame: header section is ${separatorIndex} bytes (with delimiter present); exceeds ${MAX_HEADER_BYTES} byte cap`,
    );
  }

  const headerBytes = buffer.subarray(0, separatorIndex);
  const headerText = headerBytes.toString("ascii");
  const declaredLength = extractContentLength(headerText);

  if (declaredLength > maxBodyBytes) {
    // The gateway turns this into an `oversized_body` disconnect; `fields` feed `data.fields`.
    throw new FramingError(
      "oversized_body",
      `parseFrame: declared body length ${declaredLength} exceeds ${maxBodyBytes} byte limit`,
      { limit: maxBodyBytes, observed: declaredLength },
    );
  }

  const bodyStart = separatorIndex + Buffer.byteLength(HEADER_BODY_SEPARATOR, "ascii");
  const bodyEnd = bodyStart + declaredLength;
  if (buffer.byteLength < bodyEnd) {
    // The header is here but the body has not fully arrived; the caller keeps accumulating.
    return { frame: null, consumed: 0 };
  }

  const body = buffer.subarray(bodyStart, bodyEnd);
  // Copy: `subarray` is a view, and the caller drops head bytes from the accumulator.
  return { frame: Buffer.from(body), consumed: bodyEnd };
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
          `parseFrame: Content-Length value ${JSON.stringify(value)} is not a non-negative decimal integer`,
        );
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new FramingError(
          "malformed_content_length",
          `parseFrame: Content-Length value ${JSON.stringify(value)} is not finite or is negative`,
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
