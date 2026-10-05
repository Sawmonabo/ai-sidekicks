/**
 * The sidecar's wire framing: a `Content-Length` header, a blank line, then a JSON body. Inbound
 * frames are parsed by the shared `parseFrame` under `MAX_FRAME_BODY_BYTES`; this module holds the
 * sidecar's body limit, its payload decode failure and the outbound serializer.
 */

import { Buffer } from "node:buffer";
import type { Envelope } from "../host/protocol.js";

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
 * Canonical RFC 4648 section 4 base64. `Buffer.from(s, "base64")` silently skips bad characters
 * and padding, which would corrupt `DataFrame.bytes`, so input is validated first.
 */
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether the text is well-formed base64 with correct padding. */
export function isStrictBase64(s: string): boolean {
  return s.length % 4 === 0 && BASE64_PATTERN.test(s);
}

/** Encodes an envelope as `Content-Length: <bytes>\r\n\r\n<json>`; the write side is uncapped. */
export function serializeFrame(envelope: Envelope): Buffer {
  const payload: Buffer = Buffer.from(JSON.stringify(envelope), "utf8");
  const header: Buffer = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, payload]);
}
