/**
 * The sidecar's wire framing: a `Content-Length` header, a blank line, then a JSON body. Parses
 * frames out of a byte stream with hard size limits, and serializes outbound frames.
 */

import { Buffer } from "node:buffer";
import type { Envelope } from "./pty-host-protocol.js";

/**
 * A sidecar frame the daemon cannot decode: bad JSON, a non-object, an unknown `kind` (ignoring it
 * would hang its request) or non-canonical base64. Always fatal; `decodeCause` avoids shadowing
 * `Error.cause`.
 */
export class SidecarFrameDecodeError extends Error {
  public readonly decodeCause:
    | "json-parse"
    | "non-object-envelope"
    | "unknown-kind"
    | "invalid-base64";

  public constructor(
    decodeCause: "json-parse" | "non-object-envelope" | "unknown-kind" | "invalid-base64",
    message: string,
  ) {
    super(message);
    this.name = "SidecarFrameDecodeError";
    this.decodeCause = decodeCause;
  }
}

/** Largest accepted frame body (8 MiB); matches `MAX_FRAME_BODY_BYTES` in `framing.rs`. */
export const MAX_FRAME_BODY_BYTES: number = 8 * 1024 * 1024;

/**
 * Largest accepted header section (bytes before `\r\n\r\n`); without it a peer that never sends
 * the delimiter would grow the buffer without bound. `framing.rs` caps each header line at 1 KiB.
 */
export const MAX_HEADER_BYTES: number = 1024;

/**
 * Canonical RFC 4648 section 4 base64. `Buffer.from(s, "base64")` silently skips bad characters
 * and padding, which would corrupt `DataFrame.bytes`, so input is validated first.
 */
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether the text is well-formed base64 with correct padding. */
export function isStrictBase64(s: string): boolean {
  return s.length % 4 === 0 && BASE64_PATTERN.test(s);
}

/**
 * Incremental Content-Length frame parser: `feed` chunks, then call `nextFrame` until it returns
 * `incomplete`. Malformed input is returned as an `error` result and is fatal to the supervisor
 * (no resync).
 */
export class ContentLengthParser {
  private buffer: Buffer = Buffer.alloc(0);

  public feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Returns the next `frame`, `incomplete` (feed more bytes), or an unrecoverable `error`. */
  public nextFrame():
    | { kind: "frame"; body: Buffer }
    | { kind: "incomplete" }
    | { kind: "error"; message: string } {
    // Without a terminator, wait for more bytes unless the buffer is already over the header cap.
    const headerEnd: number = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        return {
          kind: "error",
          message:
            `header section exceeded ${MAX_HEADER_BYTES} bytes without ` +
            `"\\r\\n\\r\\n" terminator (likely framing desync)`,
        };
      }
      return { kind: "incomplete" };
    }
    if (headerEnd > MAX_HEADER_BYTES) {
      return {
        kind: "error",
        message:
          `header section is ${headerEnd} bytes (with delimiter present); ` +
          `exceeds ${MAX_HEADER_BYTES} byte cap`,
      };
    }

    const headerBytes: Buffer = this.buffer.subarray(0, headerEnd);
    const bodyStart: number = headerEnd + 4;

    // Header names are case-insensitive.
    const headerText: string = headerBytes.toString("utf8");
    const lines: string[] = headerText.split("\r\n");
    let contentLength: number | null = null;
    for (const line of lines) {
      const colonIdx: number = line.indexOf(":");
      if (colonIdx === -1) {
        return {
          kind: "error",
          message: `header line missing ':' separator: ${JSON.stringify(line)}`,
        };
      }
      const name: string = line.slice(0, colonIdx).trim().toLowerCase();
      const value: string = line.slice(colonIdx + 1).trim();
      if (name === "content-length") {
        if (contentLength !== null) {
          // A duplicate Content-Length is a request-smuggling shape; `framing.rs` rejects it too.
          return {
            kind: "error",
            message: "duplicate Content-Length header (request-smuggling shape)",
          };
        }
        // Digits only: `parseInt` would read "12junk" as 12 and let the two sides slice different
        // lengths. Stricter than `framing.rs`, whose `parse::<usize>()` also accepts a leading `+`.
        if (!/^\d+$/.test(value)) {
          return {
            kind: "error",
            message: `Content-Length value is not a strict non-negative integer: ${JSON.stringify(value)}`,
          };
        }
        contentLength = Number(value);
      }
      // Other headers (e.g., Content-Type) are accepted and ignored.
    }

    if (contentLength === null) {
      return { kind: "error", message: "missing Content-Length header" };
    }
    if (contentLength > MAX_FRAME_BODY_BYTES) {
      return {
        kind: "error",
        message: `frame body ${contentLength} bytes exceeds MAX_FRAME_BODY_BYTES (${MAX_FRAME_BODY_BYTES})`,
      };
    }

    if (this.buffer.length < bodyStart + contentLength) {
      return { kind: "incomplete" };
    }

    const body: Buffer = this.buffer.subarray(bodyStart, bodyStart + contentLength);
    // Copy the remainder: a `subarray` view would keep the whole original allocation alive.
    this.buffer = Buffer.from(this.buffer.subarray(bodyStart + contentLength));
    return { kind: "frame", body };
  }
}

/** Encodes an envelope as `Content-Length: <bytes>\r\n\r\n<json>`; the write side is uncapped. */
export function serializeFrame(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}
