// LocalIpcGateway — JSON-RPC 2.0 substrate with LSP-style Content-Length
// framing for the local daemon (Plan-007 Phase 2, T-007p-2-1).
//
// Spec coverage:
//   * Spec-007 §Wire Format (docs/specs/007-local-ipc-and-daemon-control.md
//     lines 50-56) — JSON-RPC 2.0 + `Content-Length: <byte-count>\r\n\r\n`
//     framing; max message size 1 MB; JSON via JSON.stringify/parse.
//   * Spec-007 §Required Behavior (line 43-46) — OS-local default transport
//     (Unix domain socket on Unix-like; named pipe on Windows).
//   * ADR-009 (docs/decisions/009-json-rpc-ipc-wire-format.md) — wire-
//     format decision rationale.
//
// Invariants this module owns at the substrate boundary (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 101-111):
//   * I-007-7 (schema validation runs before handler dispatch) — substrate-
//     side: the framing parser must reject malformed frames at the
//     boundary so handlers never see garbage payloads. Only well-formed
//     JSON-RPC envelopes reach dispatch.
//   * I-007-8 (handler-thrown errors map to JSON-RPC error codes with
//     sanitized payloads) — substrate-side: the error-emission path
//     (`sanitizeErrorMessage`) strips stack traces and absolute filesystem
//     paths from `error.message` before the envelope leaves the daemon.
//
// Plan citations:
//   * F-007p-2-11 — 1MB max-message-size hard-coded in the substrate.
//     Changes require a Phase 2 amendment + Spec-007 update.
//   * F-007p-2-12 — supervision hook surface
//     `{ onConnect(transport): void; onDisconnect(transport, reason): void;
//        onError(transport, err): void }` exported for Tier 4 desktop-shell
//     supervision consumer.
//
// What this module does NOT do (deferred to sibling tasks):
//   * `DaemonHello` / `DaemonHelloAck` version negotiation — T-007p-2-4
//     owns `protocol-negotiation.ts`.
//   * `LocalSubscription<T>` streaming primitive — T-007p-2-5 owns
//     `streaming-primitive.ts`.
//
// What this module CONSUMES from sibling tasks:
//   * `MethodRegistry` (cross-package interface from
//     `@ai-sidekicks/contracts/jsonrpc-registry.ts`; runtime
//     implementation from T-007p-2-3 in `./registry.ts`) — the gateway
//     accepts a `MethodRegistry` instance via constructor injection
//     (mandatory dependency, fail-loud at construction time). The
//     bootstrap orchestrator constructs
//     the registry, registers Phase 3 handlers against it, and then
//     constructs the gateway with the populated registry.
//   * `mapJsonRpcError` (T-007p-2-2 in `./jsonrpc-error-mapping.ts`) —
//     the gateway's single error-emission seam. Every throw that
//     surfaces a JSON-RPC error response on the wire flows through
//     this helper, which selects the JSON-RPC 2.0 numeric code and
//     applies I-007-8 sanitization. The gateway DOES NOT reach into
//     the discriminator branches itself — it only routes thrown values.
//
// `protocolVersion` ratified as ISO 8601 `YYYY-MM-DD` date-string at
// api-payload-contracts.md §Tier 1 (cont.): Plan-007 (BL-102 closed
// 2026-05-01). The substrate accepts the date-string form; non-conforming
// shapes are rejected at schema-validation before reaching the gateway.

import * as net from "node:net";

import type {
  HandlerContext,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  MethodRegistry,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { assertLoadedForBind } from "../bootstrap/index.js";
import { SecureDefaults } from "../bootstrap/secure-defaults.js";
import { mapJsonRpcError } from "./jsonrpc-error-mapping.js";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/**
 * 1 MB max message size per Spec-007 §Wire Format line 53 ("Maximum message
 * size: 1 MB") and F-007p-2-11 (substrate-side hard-coded constant).
 *
 * "1 MB" is interpreted as 1,000,000 bytes (decimal MB) following the
 * Spec-007 wording. The substrate enforces this on the BODY byte count
 * declared by the `Content-Length` header — the header bytes themselves
 * are not counted against the limit. Per F-007p-2-05, an oversized body
 * causes the connection to close with an error frame (T-007p-2-2 wires
 * the canonical error code; this substrate detects + signals the
 * boundary).
 *
 * Changing this constant requires a Phase 2 amendment + Spec-007 update
 * per F-007p-2-11.
 */
export const MAX_MESSAGE_BYTES = 1_000_000;

/**
 * The LSP-style framing header name. Lower-cased compare on receive
 * (HTTP-style header semantics) but always emitted with the canonical
 * casing on send.
 */
const CONTENT_LENGTH_HEADER = "Content-Length";

/**
 * Header/body separator per LSP / MCP framing convention (CRLFCRLF).
 * Embedded in headers only — never inside the body.
 */
const HEADER_BODY_SEPARATOR = "\r\n\r\n";

// --------------------------------------------------------------------------
// Supervision hooks (F-007p-2-12)
// --------------------------------------------------------------------------

/**
 * Per-connection transport handle. Opaque to consumers — the gateway owns
 * the underlying `net.Socket`. Supervision callers receive the handle to
 * correlate `onConnect` / `onDisconnect` / `onError` calls but should not
 * inspect or mutate it.
 *
 * `id` is a process-monotonic integer, assigned at `onConnect` time. It is
 * stable for the lifetime of the connection and is the only value
 * supervision consumers (Tier 4 desktop-shell) should key off.
 */
export interface SupervisionTransport {
  readonly id: number;
  readonly remoteFamily: "unix" | "pipe" | "tcp" | "unknown";
}

/**
 * Reasons a connection terminated. Closed string union — supervision
 * consumers can switch exhaustively. New reasons require a Phase 2
 * amendment.
 *
 *   * `"client_close"` — the peer closed cleanly (FIN / EOF received).
 *   * `"server_close"` — the gateway closed the connection deliberately
 *     (e.g. on `stop()`, on framing-violation rejection, on oversized-body).
 *   * `"transport_error"` — the underlying socket emitted an `error` event
 *     before close. The corresponding `onError` fires before this
 *     `onDisconnect`.
 *   * `"oversized_body"` — the declared `Content-Length` exceeded
 *     `MAX_MESSAGE_BYTES`. Per F-007p-2-05 the connection MUST close.
 *   * `"malformed_frame"` — the incoming buffer violated framing grammar
 *     (bad header, missing separator, non-numeric Content-Length, etc.).
 *     Per ADR-009 §Failure Mode Analysis row 2 the gateway closes the
 *     connection with a clear close code rather than attempting recovery.
 */
export type SupervisionDisconnectReason =
  | "client_close"
  | "server_close"
  | "transport_error"
  | "oversized_body"
  | "malformed_frame";

/**
 * Supervision callbacks per F-007p-2-12. Plan-007-remainder (Tier 4)
 * desktop-shell supervision consumer registers these to surface daemon
 * connection lifecycle in the renderer status surface.
 *
 * All three callbacks are SYNCHRONOUS — supervision is observation, not
 * mediation. A throwing callback is a programmer error; the gateway
 * forwards the throw via the underlying `net.Server` `error` event but
 * does NOT swallow it (silent supervision failure would defeat the
 * surface's purpose).
 */
export interface SupervisionHooks {
  onConnect(transport: SupervisionTransport): void;
  onDisconnect(transport: SupervisionTransport, reason: SupervisionDisconnectReason): void;
  onError(transport: SupervisionTransport, err: unknown): void;
}

// --------------------------------------------------------------------------
// Framing parser (exported for direct test by T-007p-2-6)
// --------------------------------------------------------------------------

/**
 * Result of a single `parseFrame` invocation against the per-connection
 * accumulating buffer.
 *
 *   * `frame !== null`: a complete frame body was extracted. `consumed`
 *     names the number of bytes the caller MUST drop from the head of
 *     its accumulator before the next parse attempt.
 *   * `frame === null` AND `consumed === 0`: the buffer does not yet
 *     contain a complete frame. The caller should keep accumulating
 *     bytes and re-attempt `parseFrame` when more arrive. This sentinel
 *     replaces a thrown "not yet ready" condition — partial buffers are
 *     a normal-path event, not an error.
 *
 * Errors (oversized declared length, malformed header, non-numeric
 * Content-Length, missing CRLFCRLF, etc.) throw `FramingError`; the
 * gateway converts the throw into a `malformed_frame` disconnect.
 */
export interface ParseFrameResult {
  /** Decoded body bytes, or `null` when the buffer doesn't yet contain
   *  a complete frame. */
  readonly frame: Buffer | null;
  /** Number of bytes consumed from the buffer head when `frame !== null`,
   *  or 0 when waiting for more bytes. */
  readonly consumed: number;
}

/**
 * Parser/encoder errors. Distinct subclass of `Error` so the gateway can
 * discriminate framing violations from arbitrary thrown values inside the
 * supervision/disconnect path. Carries a `code` string for test
 * introspection and an optional `fields` payload for the throw sites that
 * project structured detail through `mapJsonRpcError` into the JSON-RPC
 * envelope's `error.data.fields` per error-contracts.md §JSON-RPC Wire
 * Mapping (BL-103 closed 2026-05-01). The JSON-RPC numeric mapping
 * (`-32600` etc.) is T-2's surface and does NOT live here.
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
 * Parse a single LSP-style Content-Length-framed message from the head of
 * the supplied buffer.
 *
 * Frame grammar (Spec-007 §Wire Format line 52):
 *   `Content-Length: <byte-count>\r\n\r\n<body>`
 *
 * Multi-byte safety: `Content-Length` is BYTES, not characters. A UTF-8
 * body containing multi-byte sequences is sliced by byte count, not by
 * `String#length`. The returned `Buffer` slice is the verbatim body bytes;
 * JSON parsing is the caller's concern.
 *
 * Partial-buffer handling: returns `{ frame: null, consumed: 0 }` when the
 * buffer is too short to contain a complete header or body. This is the
 * normal path under stream-oriented transports (TCP / Unix domain socket /
 * named pipe) — the caller resumes accumulation.
 *
 * Throws `FramingError` on:
 *   * Header lacks `Content-Length` (per Spec-007 line 52, the only
 *     header the framing recognizes; future LSP-compatible additions
 *     would require a Phase 2 amendment).
 *   * Content-Length value is not a non-negative integer.
 *   * Declared length exceeds `MAX_MESSAGE_BYTES` (F-007p-2-11).
 *   * Header section contains bytes that violate the
 *     `<name>: <value>\r\n` grammar.
 */
export function parseFrame(buffer: Buffer): ParseFrameResult {
  const separatorIndex = buffer.indexOf(HEADER_BODY_SEPARATOR);
  // Header-section size cap (1 KB). Fires UNCONDITIONALLY whenever the
  // header section size is determinable:
  //
  //   * `separatorIndex === -1` — delimiter not yet seen; the header
  //     section so far is `buffer.byteLength` bytes. A peer streaming
  //     megabytes of header without ever sending CRLFCRLF would
  //     otherwise pin the accumulator indefinitely (in-flight desync).
  //   * `separatorIndex > 1024` — delimiter present but the header
  //     section itself exceeds 1 KB. Without this branch, a peer who
  //     prepends 10 MB of header bytes followed by CRLFCRLF bypasses
  //     the cap entirely — the parser would proceed to ASCII-decode
  //     and parse the multi-MB header block. The body cap
  //     (`MAX_MESSAGE_BYTES`) only governs the BODY per the file
  //     header comment at lines 84-88; the header cap closes the
  //     symmetric DoS surface implied by F-007p-2-11.
  //
  // The threshold is generous (1 KB) because legitimate Content-Length
  // headers are tens of bytes; a 1 KB header section accommodates many
  // future LSP-compatible headers without forcing a Phase 2 amendment.
  if (separatorIndex === -1) {
    if (buffer.byteLength > 1024) {
      throw new FramingError(
        "header_too_long",
        `parseFrame: header section exceeded 1024 bytes without ${JSON.stringify(HEADER_BODY_SEPARATOR)} (likely framing desync)`,
      );
    }
    return { frame: null, consumed: 0 };
  }
  if (separatorIndex > 1024) {
    throw new FramingError(
      "header_too_long",
      `parseFrame: header section is ${separatorIndex} bytes (with delimiter present); exceeds 1024 byte cap`,
    );
  }

  const headerBytes = buffer.subarray(0, separatorIndex);
  const headerText = headerBytes.toString("ascii");
  const declaredLength = extractContentLength(headerText);

  if (declaredLength > MAX_MESSAGE_BYTES) {
    // F-007p-2-11 / F-007p-2-05: oversized-body rejection. Throw at the
    // parser boundary; the gateway converts to `oversized_body`
    // disconnect. The structured `fields` payload feeds
    // `data.fields: { limit, observed }` per error-contracts.md
    // §JSON-RPC Wire Mapping (`transport.message_too_large` row, HTTP
    // 413 semantic — distinct from Spec-001's HTTP-429 quota code
    // `resource.limit_exceeded`).
    throw new FramingError(
      "oversized_body",
      `parseFrame: declared body length ${declaredLength} exceeds ${MAX_MESSAGE_BYTES} byte limit`,
      { limit: MAX_MESSAGE_BYTES, observed: declaredLength },
    );
  }

  const bodyStart = separatorIndex + Buffer.byteLength(HEADER_BODY_SEPARATOR, "ascii");
  const bodyEnd = bodyStart + declaredLength;
  if (buffer.byteLength < bodyEnd) {
    // The header is here but the body bytes haven't all arrived yet.
    // Wait for more data; do not advance the consumer's cursor.
    return { frame: null, consumed: 0 };
  }

  const body = buffer.subarray(bodyStart, bodyEnd);
  // Defensive copy: `subarray` returns a view over the same backing
  // ArrayBuffer. The caller will drop the head bytes from the
  // accumulator after consuming, which would invalidate the view.
  // Buffer.from(view) copies into a fresh allocation.
  return { frame: Buffer.from(body), consumed: bodyEnd };
}

/**
 * Encode a JSON-RPC envelope into a Content-Length-framed wire frame.
 *
 * The body is JSON.stringify()-ed; the Content-Length header carries the
 * UTF-8 BYTE count of the body (not character count). The returned
 * `Buffer` is ready to write to the underlying transport.
 *
 * Throws `FramingError` if the encoded body exceeds `MAX_MESSAGE_BYTES` —
 * outbound-side enforcement of F-007p-2-11. A daemon-side bug that built
 * an oversized envelope would otherwise reach the wire and trip the peer's
 * inbound check, leaving the daemon's logs without provenance.
 */
export function encodeFrame(envelope: JsonRpcMessage): Buffer {
  // JSON.stringify is the documented serialization per Spec-007 line 55
  // ("JSON via JSON.stringify/JSON.parse. No binary serialization.").
  const bodyText = JSON.stringify(envelope);
  const bodyBytes = Buffer.from(bodyText, "utf8");
  const declaredLength = bodyBytes.byteLength;

  if (declaredLength > MAX_MESSAGE_BYTES) {
    throw new FramingError(
      "oversized_body",
      `encodeFrame: encoded body length ${declaredLength} exceeds ${MAX_MESSAGE_BYTES} byte limit`,
      { limit: MAX_MESSAGE_BYTES, observed: declaredLength },
    );
  }

  const header = `${CONTENT_LENGTH_HEADER}: ${declaredLength}${HEADER_BODY_SEPARATOR}`;
  const headerBytes = Buffer.from(header, "ascii");
  return Buffer.concat([headerBytes, bodyBytes]);
}

/**
 * Extract and validate the `Content-Length` header value from the header
 * section. Case-insensitive name match (HTTP/LSP convention); strict
 * decimal-integer value check.
 *
 * Throws `FramingError` if no `Content-Length` header is present, the
 * value is non-numeric, or any header line violates `<name>: <value>`
 * grammar. The strict grammar refuses partial / interleaved framing —
 * any deviation triggers a `malformed_frame` disconnect rather than a
 * silent best-effort recovery.
 */
function extractContentLength(headerText: string): number {
  // Header lines are CRLF-terminated per LSP. Reject lone-LF terminators
  // (lenient parsing here would mask peer bugs that the spec guards
  // against).
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
      // Empty line in mid-header is a grammar violation. The CRLFCRLF
      // separator is the canonical "end of headers" marker; an empty
      // line before that is malformed.
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
      // Reject duplicate Content-Length headers per the strict-grammar
      // contract above. A peer sending two Content-Length headers with
      // different values is the request-smuggling shape — silently
      // picking last-wins would let the parser slice a body of one
      // length from a buffer carrying the OTHER length, leaving the
      // remainder to be reinterpreted as a fresh frame on the next
      // iteration. Refuse at the boundary; supervision converts the
      // throw into a `malformed_frame` disconnect.
      if (declaredLength !== null) {
        throw new FramingError(
          "malformed_content_length",
          `parseFrame: duplicate ${CONTENT_LENGTH_HEADER} header (request-smuggling shape)`,
        );
      }
      // Strict decimal-integer check. Reject leading +/-, leading zeros
      // beyond a single zero, hex, scientific notation, or whitespace
      // inside the value.
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
    // Other header names are ignored (forward-compatibility hook).
    // LSP / MCP frame grammars permit `Content-Type` etc.; we don't
    // enforce them at Tier 1 and don't reject unknown header names.
  }
  if (declaredLength === null) {
    throw new FramingError(
      "missing_content_length",
      `parseFrame: header section did not include ${CONTENT_LENGTH_HEADER}`,
    );
  }
  return declaredLength;
}

// --------------------------------------------------------------------------
// Error-message sanitization (I-007-8)
// --------------------------------------------------------------------------

/**
 * Strip stack traces, absolute filesystem paths, and other internals from
 * an arbitrary thrown value before it leaves the daemon as a JSON-RPC
 * `error.message` string.
 *
 * I-007-8 (canonical text in plan §Invariants lines 107-111): "Stack
 * traces and secrets MUST never leak through the response." This helper
 * is the substrate-side enforcement seam — every error-emission path
 * passes its thrown value through here before constructing the
 * `JsonRpcErrorResponse` envelope.
 *
 * What this function does:
 *   * For an `Error` instance: extracts `.message` ONLY (never `.stack`).
 *   * For a non-Error throw (`throw "boom"` / `throw 42` / `throw null`):
 *     coerces via `String(value)` into a printable form.
 *   * Replaces Unix absolute filesystem paths (`/foo/bar.ts:line:col`)
 *     with the literal `<redacted-path>`.
 *   * Replaces UNC paths (`\\host\share\path...`) with the literal
 *     `<redacted-path>`. Share/path segments tolerate internal spaces
 *     (e.g. `\\fs\Shared Drive\config.json`); the host segment does not.
 *   * Replaces Windows absolute filesystem paths (`C:\foo\bar.ts`) with
 *     the literal `<redacted-path>`. Path segments tolerate internal
 *     spaces (e.g. `C:\Program Files\App\bin.exe` — the canonical
 *     Windows install prefix).
 *   * Caps the output length to `SANITIZED_MESSAGE_MAX_LEN` (8 KB) — a
 *     thrown value carrying a megabyte-long string would otherwise inflate
 *     the response envelope past the 1 MB max-message limit.
 *
 * What this function does NOT do:
 *   * It does not strip secrets that don't match the path patterns
 *     (e.g. a leaked API key in a string literal). The handler author is
 *     responsible for not putting secrets in error messages in the first
 *     place; the path-redaction is a defense-in-depth backstop, not a
 *     guarantee.
 *   * It does not interpret the JSON-RPC error code — code selection is
 *     T-007p-2-2's surface.
 *
 * Trade-off (over-redaction posture): because Windows / UNC path
 * segments may contain internal spaces, the regex CANNOT distinguish
 * `C:\Foo and more prose` (intent: drive + segment + prose) from
 * `C:\Program Files` (intent: drive + multi-word segment) — both end
 * in non-path characters that the regex's bounded character class
 * accepts. The boundary is reached at the next character outside
 * `[A-Za-z0-9_. -]` (quote, semicolon, slash, etc.). Trailing prose
 * after a Windows / UNC path with no such delimiter MAY be over-
 * redacted as part of the path. This is consistent with I-007-8's
 * security posture: over-redaction is a cosmetic defect; under-
 * redaction is a security defect.
 *
 * Non-throwing contract: this function MUST NOT throw for any input.
 * If string conversion of a non-Error / non-string thrown value fails
 * (e.g. an object whose `toString` itself throws — `String(value)`
 * invokes `ToPrimitive` which calls `toString`), the fallback returns
 * a safe placeholder string `"<unprintable thrown value>"`. The
 * I-007-8 enforcement seam is the boundary between arbitrary user-
 * thrown values and the wire — a hostile or buggy handler that
 * engineers a poisoned thrown object MUST NOT crash the daemon (a DoS
 * surface otherwise: `--unhandled-rejections=throw` would terminate
 * the process). The fallback string is itself path-shape-free and
 * stack-shape-free so it cannot leak internals through the redaction
 * regexes.
 */
export function sanitizeErrorMessage(value: unknown): string {
  let raw: string;
  if (value instanceof Error) {
    // Deliberately read `.message` only — `.stack` would leak filesystem
    // paths, function names, and module structure.
    raw = value.message;
  } else if (typeof value === "string") {
    raw = value;
  } else {
    // `String(null)` => "null", `String(undefined)` => "undefined",
    // `String({})` => "[object Object]" — all printable, none leaking
    // structured internals. JSON.stringify would be richer but could
    // include user-supplied structured fields we don't want on the wire.
    //
    // `String(value)` invokes `ToPrimitive` which calls `value.toString()`
    // for objects — a misbehaving handler can `throw { toString() { throw
    // ... } }`, which would otherwise escape this function and become an
    // unhandled rejection at the `mapJsonRpcError` call site. The
    // I-007-8 enforcement seam MUST be non-throwing for arbitrary input
    // (see JSDoc "Non-throwing contract" above); fall back to a safe
    // placeholder if conversion throws.
    try {
      raw = String(value);
    } catch {
      raw = "<unprintable thrown value>";
    }
  }

  // Unix absolute paths with optional `:line:col` suffix. The character
  // class is conservative: alphanumerics, `_`, `.`, `-`, `/` only. Stop
  // at whitespace, quotes, or any character that wouldn't legitimately
  // appear in a sane filesystem path. Order: Unix first because its
  // leading-`/` anchor cannot collide with UNC's leading `\\` or the
  // Windows-drive `[A-Za-z]:\` anchor, and the regex is the most
  // common-case match by far.
  let sanitized = raw.replace(/(?:\/[A-Za-z0-9_.-]+)+(?::\d+(?::\d+)?)?/g, "<redacted-path>");
  // UNC paths: `\\host\share\path...`. Host segment is hostname-shape
  // (alphanumerics, `_`, `.`, `-` — no spaces in hostnames), but the
  // share + path segments after the first separator can contain spaces
  // (e.g. `\\fileserver\share\Program Files\bin.exe`). Run BEFORE the
  // drive-letter Windows branch because UNC's `\\` prefix is not
  // matched by `[A-Za-z]:\`, but explicit ordering documents the intent.
  // Optional `:line:col` suffix kept consistent with the other branches.
  sanitized = sanitized.replace(
    /\\\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_. -]+)+(?::\d+(?::\d+)?)?/g,
    "<redacted-path>",
  );
  // Windows absolute paths: drive letter, colon, backslash, then path
  // body. Path segments allow internal spaces (e.g. `C:\Program Files\`
  // — the canonical Windows install prefix). The character class keeps
  // `-` LAST to avoid range interpretation. Optional `:line:col` suffix
  // kept distinct from the drive-letter colon (the regex anchors on
  // `[A-Za-z]:\` to discriminate).
  sanitized = sanitized.replace(
    /[A-Za-z]:\\(?:[A-Za-z0-9_. -]+\\?)+(?::\d+(?::\d+)?)?/g,
    "<redacted-path>",
  );

  if (sanitized.length > SANITIZED_MESSAGE_MAX_LEN) {
    return `${sanitized.slice(0, SANITIZED_MESSAGE_MAX_LEN - "…[truncated]".length)}…[truncated]`;
  }
  return sanitized;
}

/**
 * Cap on the sanitized error-message length. 8 KB is well above any
 * legitimate human-readable error message; the cap exists to prevent a
 * pathological thrown string from inflating the response envelope past
 * `MAX_MESSAGE_BYTES`. Centralized here (rather than in `error.ts`) so
 * the substrate's I-007-8 enforcement does not depend on the project-
 * wide error envelope's length cap, which is a separate contract.
 */
export const SANITIZED_MESSAGE_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// Internal: per-connection state
// --------------------------------------------------------------------------

interface ConnectionState {
  readonly transport: SupervisionTransport;
  readonly socket: net.Socket;
  /** Per-connection accumulator. Each connection has its own buffer; the
   *  parser does NOT share state across sockets. */
  buffer: Buffer;
  /** Set true after the gateway has emitted onDisconnect for this
   *  connection so a stray socket event late in teardown doesn't fire
   *  a duplicate. */
  disposed: boolean;
}

let nextTransportId = 1;
function allocTransportId(): number {
  return nextTransportId++;
}

function detectFamily(
  socket: net.Socket,
  listenPath: string,
): SupervisionTransport["remoteFamily"] {
  // For Unix domain sockets and Windows named pipes, `socket.remoteFamily`
  // is empty/undefined; we discriminate via the listening path. Windows
  // named pipes use the `\\?\pipe\<name>` or `\\.\pipe\<name>` shape.
  if (listenPath.startsWith("\\\\.\\pipe\\") || listenPath.startsWith("\\\\?\\pipe\\")) {
    return "pipe";
  }
  if (socket.remoteFamily === "IPv4" || socket.remoteFamily === "IPv6") {
    return "tcp";
  }
  // Default: assume Unix domain socket (path-style address that's not a
  // Windows pipe). The "unknown" branch is a catch-all for future
  // transport families we add at Tier 4.
  return "unix";
}

// --------------------------------------------------------------------------
// LocalIpcGateway
// --------------------------------------------------------------------------

/**
 * Configuration for `LocalIpcGateway`. Exact-optional discipline: omit
 * fields rather than assigning `undefined` (matches
 * `exactOptionalPropertyTypes: true`).
 *
 * `registry` is the MANDATORY method-namespace registry (per T-007p-2-2:
 * the `MethodRegistry` instance is INJECTED, not constructed inside the
 * gateway. Do NOT make the gateway own registry construction). Constructor injection — the bootstrap
 * orchestrator constructs the registry, registers Phase 3 / downstream
 * handlers against it, and only THEN constructs the gateway with the
 * populated registry. Failing-loud at construction time (rather than at
 * first dispatch) makes a misconfigured bootstrap detectable before any
 * listener binds.
 *
 * `hooks` is the OPTIONAL supervision surface per F-007p-2-12 — Tier 4
 * desktop-shell consumer passes them in; Tier 1 callers may omit if they
 * don't need lifecycle notifications.
 */
export interface LocalIpcGatewayOptions {
  readonly registry: MethodRegistry;
  readonly hooks?: SupervisionHooks;
}

/**
 * The gateway is INSTANTIABLE (not a module-singleton like
 * `SecureDefaults`). It owns I/O resources — a `net.Server`, per-connection
 * sockets, accumulating buffers — that have explicit lifecycle. Multiple
 * gateway instances per process are not anticipated for V1, but the
 * instantiable shape lets tests construct an isolated instance per case
 * without a `__resetForTest()` hook proliferation, and it leaves the
 * door open to Tier 4 surfaces (HTTP listener, TLS listener) sharing a
 * single process.
 *
 * Recommendation alternative considered: module-singleton matching
 * `SecureDefaults`. Why instantiable wins: the bootstrap singletons
 * (`SecureDefaults`, `SecureDefaultOverrideEmitter`) are CONFIGURATION
 * surfaces — one validated bind config per process, one audit-event
 * dedupe set per process. The gateway is an I/O surface — a `net.Server`
 * with a per-instance lifecycle. Mapping I/O onto module-singleton state
 * forces a `__resetForTest()` that the I/O domain doesn't naturally need.
 *
 * Trade-off accepted: callers must pass the `LocalIpcGateway` instance
 * to dispatch consumers (T-007p-2-2 wires the registry into a specific
 * gateway), where a singleton would let any module call a static
 * dispatch method. The trade is small — Tier 1 has exactly one consumer
 * (the bootstrap orchestrator), which can plumb the instance once.
 */
export class LocalIpcGateway {
  // Per-instance state. The gateway encapsulates everything; nothing
  // leaks to module scope.
  readonly #registry: MethodRegistry;
  readonly #hooks: SupervisionHooks | null;
  #server: net.Server | null;
  #connections: Map<number, ConnectionState>;
  #started: boolean;

  constructor(options: LocalIpcGatewayOptions) {
    // Constructor injection — the registry is MANDATORY (T-007p-2-2:
    // fail-loud at construction time). A `null`-valued / missing
    // registry is a programmer error in the bootstrap orchestrator;
    // we don't attempt graceful degradation.
    this.#registry = options.registry;
    this.#hooks = options.hooks ?? null;
    this.#server = null;
    this.#connections = new Map();
    this.#started = false;
  }

  /**
   * Bind the gateway's listener to the OS-local socket / named pipe path
   * declared in `SecureDefaults.effectiveSettings()`.
   *
   * Sequence:
   *   1. `assertLoadedForBind()` — I-007-1 enforcement; throws if
   *      `SecureDefaults.load(config)` has not yet completed (Phase 1's
   *      orchestrator-throw seam).
   *   2. Read `SecureDefaults.effectiveSettings()` for the bind path.
   *   3. Construct `net.createServer` with the per-connection handler
   *      below; wire supervision callbacks.
   *   4. `server.listen(path)`.
   *
   * Returns a Promise that resolves when the listener is bound. Rejects
   * on bind failure (e.g. EADDRINUSE) — the caller is responsible for
   * surfacing the failure to the operator.
   *
   * Idempotency: calling `start()` a second time on a started gateway
   * throws. The gateway is single-shot per instance — call `stop()` then
   * construct a new instance to re-listen.
   */
  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("LocalIpcGateway.start: gateway already started");
    }

    // I-007-1 (canonical text in plan §Invariants lines 65-69):
    // `SecureDefaults.load(config)` MUST run before any daemon listener
    // binds. Phase 1's `assertLoadedForBind()` is the seam this gateway
    // hooks. Calling it FIRST means a misconfigured bootstrap surfaces
    // as a synchronous throw before any I/O resource is allocated.
    assertLoadedForBind();

    const settings = SecureDefaults.effectiveSettings();
    const listenPath = settings.localIpcPath;

    const server = net.createServer((socket) => {
      this.#onSocketConnect(socket, listenPath);
    });

    server.on("error", (err) => {
      // Server-level errors (bind failure, post-listen socket failure)
      // surface through supervision's onError with a synthetic transport
      // handle (id 0, no per-connection context). The throw flow is
      // documented for the desktop-shell consumer.
      if (this.#hooks !== null) {
        this.#hooks.onError({ id: 0, remoteFamily: "unknown" }, err);
      }
    });

    // Promise wrap around `server.listen` so callers can `await start()`
    // and get either a successful listen or a structured failure. The
    // `listening` and `error` events are mutually exclusive on first
    // bind per Node's net docs.
    //
    // State-mutation ordering: `#server` and `#started` are assigned
    // AFTER `await` resolves, NOT before. If `listen` rejects (EADDRINUSE,
    // EACCES, etc.), the rejection propagates and the instance stays in
    // the pre-call state — a subsequent `start()` retry is permitted
    // (rather than throwing "gateway already started" against a
    // never-bound listener). The persistent `server.on("error", ...)`
    // listener above is unaffected; supervision still fires for the
    // failed-bind error event.
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.removeListener("error", onListenError);
        resolve();
      };
      const onListenError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onListenError);
      server.listen(listenPath);
    });

    this.#server = server;
    this.#started = true;
  }

  /**
   * Tear down the listener and all open connections. Idempotent — calling
   * `stop()` on an unstarted or already-stopped gateway is a no-op (in
   * contrast to `start()`'s strict single-shot semantic). The asymmetry
   * is deliberate: shutdown paths must be safe to call from error
   * handlers that don't know the gateway state.
   *
   * Each open connection emits `onDisconnect(transport, "server_close")`
   * before its socket is destroyed.
   */
  async stop(): Promise<void> {
    if (!this.#started || this.#server === null) {
      return;
    }

    // Snapshot the connection list — `#onSocketEnd` mutates the map
    // during iteration if we don't snapshot first.
    const connections = Array.from(this.#connections.values());
    for (const conn of connections) {
      this.#emitDisconnect(conn, "server_close");
      conn.socket.destroy();
    }
    this.#connections.clear();

    const server = this.#server;
    this.#server = null;
    this.#started = false;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== null && err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // ------------------------------------------------------------------------
  // Per-connection wiring
  // ------------------------------------------------------------------------

  #onSocketConnect(socket: net.Socket, listenPath: string): void {
    const transport: SupervisionTransport = {
      id: allocTransportId(),
      remoteFamily: detectFamily(socket, listenPath),
    };
    const state: ConnectionState = {
      transport,
      socket,
      buffer: Buffer.alloc(0),
      disposed: false,
    };
    this.#connections.set(transport.id, state);

    if (this.#hooks !== null) {
      this.#hooks.onConnect(transport);
    }

    socket.on("data", (chunk: Buffer) => {
      this.#onSocketData(state, chunk);
    });
    socket.on("end", () => {
      this.#emitDisconnect(state, "client_close");
    });
    socket.on("close", () => {
      // `close` fires after `end` or after `error`. The disposed flag
      // suppresses the duplicate disconnect notification.
      this.#emitDisconnect(state, "client_close");
    });
    socket.on("error", (err) => {
      // Disposed-flag gate maintains the supervision contract documented
      // on `SupervisionDisconnectReason["transport_error"]` — every
      // `onError(transport, ...)` is followed by exactly ONE
      // `onDisconnect(transport, reason)` for the same transport id.
      // Node permits a trailing socket `error` event after `close` (e.g.
      // ECONNRESET observed during teardown after a clean `end`); without
      // this gate, the `onError` would fire on a transport id already
      // declared dead while the subsequent `#emitDisconnect` is suppressed
      // by the same disposed flag — supervision would observe a dangling
      // `onError` it cannot correlate to a lifecycle event.
      if (state.disposed) {
        return;
      }
      if (this.#hooks !== null) {
        this.#hooks.onError(transport, err);
      }
      this.#emitDisconnect(state, "transport_error");
    });
  }

  #onSocketData(state: ConnectionState, chunk: Buffer): void {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    // Drain as many complete frames as the buffer contains. A single
    // chunk MAY carry multiple frames (TCP / Unix domain socket has no
    // message boundaries); per-iteration `parseFrame` extracts one and
    // we loop until the parser signals "wait for more".
    for (;;) {
      let result: ParseFrameResult;
      try {
        result = parseFrame(state.buffer);
      } catch (err) {
        // Malformed framing per I-007-7 substrate-side enforcement: the
        // boundary REJECTS the frame; downstream dispatch never sees
        // it. Per ADR-009 §Failure Mode Analysis row 2 + the
        // T-007p-2-2 task contract, the gateway emits a JSON-RPC
        // error response with id=null (per §5: id MUST be null when
        // id detection failed) AND THEN closes the connection. The
        // wire is structurally desynced — the peer cannot recover by
        // reading more bytes — so we send the response best-effort
        // and tear down the transport.
        const reason: SupervisionDisconnectReason =
          err instanceof FramingError && err.code === "oversized_body"
            ? "oversized_body"
            : "malformed_frame";
        try {
          if (this.#hooks !== null) {
            this.#hooks.onError(state.transport, err);
          }
        } finally {
          // I/O tear-down MUST run regardless of supervision-hook
          // behavior. Per F-007p-2-12, hook throws propagate (programmer
          // error); the I/O guarantee that a desynced socket is torn
          // down is INDEPENDENT of supervision health. Without this
          // finally, a throwing onError would skip `#sendEnvelope` /
          // `#emitDisconnect` / `socket.destroy()`, leaving the socket
          // open with a corrupt accumulator — every subsequent `data`
          // event would re-enter `#onSocketData` against the desynced
          // buffer and re-throw on the same boundary.
          //
          // Best-effort emit: the `#sendEnvelope` may fail (e.g. socket
          // already broken); we don't care because we're about to
          // destroy the socket anyway. Use the id=null path per
          // JSON-RPC §5. `mapJsonRpcError` is non-throwing (its
          // sanitization seam is non-throwing per the I-007-8 contract).
          this.#sendEnvelope(state, mapJsonRpcError(err, null));
          this.#emitDisconnect(state, reason);
          state.socket.destroy();
        }
        return;
      }
      if (result.frame === null) {
        // Need more bytes. Wait for the next `data` event.
        return;
      }
      // Drop the consumed bytes from the head of the accumulator.
      state.buffer = state.buffer.subarray(result.consumed);
      this.#dispatchFrame(state, result.frame);
    }
  }

  #dispatchFrame(state: ConnectionState, body: Buffer): void {
    // Step 1: parse the JSON body. Failures wrap as a `FramingError`
    // with the synthetic `"invalid_json"` code so the single
    // `mapJsonRpcError` discriminator handles every parse-failure
    // shape uniformly. This is the JSON-RPC §5.1 -32700 path.
    //
    // I-007-7 substrate-side: malformed JSON inside an otherwise-well-
    // framed body is a parse error. Emit a parse-error response (id
    // null per spec §5.1 when id detection failed) and CONTINUE
    // serving the connection — JSON-level corruption of a single
    // message does NOT require closing the transport (the framing
    // layer succeeded; the next frame may parse cleanly).
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8")) as unknown;
    } catch (err) {
      const wrapped = new FramingError(
        "invalid_json",
        err instanceof Error ? err.message : String(err),
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
      return;
    }

    // Step 2: discriminate the envelope shape. The substrate's only
    // structural requirements at this layer are "is it a JSON-RPC
    // envelope at all?" — full param-schema validation runs INSIDE
    // the registry's dispatch (T-3) per I-007-7 (canonical text in
    // plan §Invariants lines 101-105).
    //
    // Envelope-shape failures wrap as a `FramingError` with the
    // synthetic `"invalid_envelope"` code so they map to JSON-RPC
    // -32600 Invalid Request per spec §5.1 ("The JSON sent is not a
    // valid Request object").
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const wrapped = new FramingError(
        "invalid_envelope",
        "invalid JSON-RPC envelope: not an object",
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
      return;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope["jsonrpc"] !== JSONRPC_VERSION) {
      const wrapped = new FramingError(
        "invalid_envelope",
        `invalid JSON-RPC envelope: jsonrpc must equal ${JSONRPC_VERSION}`,
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, extractIdSafely(envelope)));
      return;
    }
    // A request envelope per JSON-RPC §4 MUST carry a `method` field.
    // Reject missing/non-string method as a -32600 Invalid Request.
    const methodCandidate = envelope["method"];
    if (typeof methodCandidate !== "string") {
      const wrapped = new FramingError(
        "invalid_envelope",
        "invalid JSON-RPC envelope: method must be a string",
      );
      this.#sendEnvelope(state, mapJsonRpcError(wrapped, extractIdSafely(envelope)));
      return;
    }

    // Step 3: notification vs request discrimination. Per JSON-RPC
    // §4.1, a notification is a request without an `id` field — the
    // ABSENCE of the field (not its value) is what discriminates
    // "no response expected" from "response expected". The server
    // MUST NOT reply to a notification per spec.
    //
    // Note: `extractIdSafely` returns `null` for BOTH "id field
    // missing" AND "id field present but invalid"; we cannot use it
    // for this discrimination. The `"id" in envelope` check is the
    // only correct test.
    const isNotification = !("id" in envelope);
    // I-007-7 substrate-side: when `id` IS present but its runtime
    // type is not `string | number | null` (per JSON-RPC §4 +
    // contracts/jsonrpc.ts:74 `JsonRpcId`), the envelope is a
    // malformed Request and MUST be rejected as -32600 BEFORE
    // handler dispatch. Without this gate, an envelope like
    // `{"id": {}}` / `{"id": []}` / `{"id": true}` would slip
    // through the `"id" in envelope` check (id present), the
    // handler would run, and `extractIdSafely` would coerce the
    // bad id to `null` for the response — silently swallowing a
    // wire-protocol violation. Mirrors the method-validation
    // precedent above (lines 941-948): same shape, different field.
    // Per JSON-RPC §5: when id cannot be detected/recovered, the
    // error response id MUST be Null.
    if (!isNotification) {
      const idCandidate = envelope["id"];
      if (
        typeof idCandidate !== "string" &&
        typeof idCandidate !== "number" &&
        idCandidate !== null
      ) {
        const wrapped = new FramingError(
          "invalid_envelope",
          "invalid JSON-RPC envelope: id must be string, number, or null",
        );
        this.#sendEnvelope(state, mapJsonRpcError(wrapped, null));
        return;
      }
    }
    const requestId: JsonRpcId = isNotification ? null : extractIdSafely(envelope);
    const params = envelope["params"];

    // Step 4: dispatch through the registry. The registry's
    // `dispatch()` returns a `Promise<unknown>` that resolves with
    // the handler's result on success or rejects with a
    // `RegistryDispatchError` on registry-detected failure (or
    // arbitrary thrown value on handler failure). Both shapes flow
    // through `mapJsonRpcError` for the wire envelope.
    //
    // Async handling: `#onSocketData`'s outer loop continues draining
    // synchronously (each `#dispatchFrame` call kicks off a
    // dispatch and returns immediately); the dispatch's resolution
    // writes back later via `#sendEnvelope`. Multiple in-flight
    // dispatches per connection are permitted — JSON-RPC carries no
    // ordering guarantee beyond request-response id-correlation.
    const ctx: HandlerContext = { transportId: state.transport.id };
    this.#registry.dispatch(methodCandidate, params, ctx).then(
      (result: unknown) => {
        if (isNotification) {
          // Per JSON-RPC §4.1: notifications MUST NOT receive a
          // response. The handler ran (its side-effects took); we
          // simply don't emit anything.
          return;
        }
        const response: JsonRpcResponse = {
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          result,
        };
        this.#sendEnvelope(state, response);
      },
      (err: unknown) => {
        if (isNotification) {
          // Per JSON-RPC §4.1: notifications are one-way. The
          // handler threw, but we MUST NOT emit a response. Surface
          // via supervision so the operator can correlate notification-
          // handler bugs with their causes; the response wire stays
          // silent.
          //
          // Disposed-flag gate mirrors the socket `error` listener
          // pattern at lines 799-804: the supervision contract is
          // "every onError(transport, ...) is followed by exactly one
          // onDisconnect(transport, reason) for the same transport id".
          // If the peer disconnected before the notification handler
          // resolved, `state.disposed` is already set and `onDisconnect`
          // already fired — surfacing onError now would leave a
          // dangling onError supervision cannot correlate.
          if (state.disposed) return;
          if (this.#hooks !== null) {
            this.#hooks.onError(state.transport, err);
          }
          return;
        }
        // I-007-8 enforcement happens INSIDE `mapJsonRpcError` —
        // every error.message is sanitized before the envelope is
        // built. We do not reach into the discriminator here.
        // Note: the request-path resolution callbacks do NOT need
        // explicit disposed gates — `#sendEnvelope` is disposed-aware
        // (early-return at the top of the method), so an in-flight
        // dispatch resolving after disconnect is dropped silently.
        this.#sendEnvelope(state, mapJsonRpcError(err, requestId));
      },
    );
  }

  // ------------------------------------------------------------------------
  // Outbound emission
  // ------------------------------------------------------------------------

  /**
   * Internal hook for emitting any JSON-RPC envelope on the connection.
   * Single emission seam — every outbound success response, error
   * response, and (post-T-5) streaming notification flows through here
   * so future supervision/log hooks can intercept outbound traffic
   * uniformly.
   *
   * Error envelopes reach this helper via `mapJsonRpcError` (T-007p-2-2's
   * single sanitization + numeric-code-mapping seam). Success envelopes
   * are constructed inline at the dispatch resolution site. T-007p-2-5
   * will route streaming-notification envelopes through the same helper.
   */
  #sendEnvelope(state: ConnectionState, envelope: JsonRpcResponse | JsonRpcErrorResponse): void {
    if (state.disposed) {
      return;
    }
    let frame: Buffer;
    try {
      frame = encodeFrame(envelope);
    } catch (err) {
      // Outbound oversize / encode failure. We cannot send a response
      // (the response itself is what failed to encode); surface to
      // supervision and disconnect.
      //
      // try/finally mirrors the framing-error catch in `#onSocketData`:
      // I/O tear-down MUST run regardless of supervision-hook behavior.
      // A throwing onError would otherwise skip `#emitDisconnect` and
      // `socket.destroy()`, leaving the socket open and the connection
      // map entry leaked.
      try {
        if (this.#hooks !== null) {
          this.#hooks.onError(state.transport, err);
        }
      } finally {
        this.#emitDisconnect(state, "server_close");
        state.socket.destroy();
      }
      return;
    }
    state.socket.write(frame);
  }

  #emitDisconnect(state: ConnectionState, reason: SupervisionDisconnectReason): void {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    this.#connections.delete(state.transport.id);
    if (this.#hooks !== null) {
      this.#hooks.onDisconnect(state.transport, reason);
    }
  }
}

// --------------------------------------------------------------------------
// Helpers (private)
// --------------------------------------------------------------------------

/**
 * Best-effort extraction of the request `id` for echo into an error
 * envelope. Per JSON-RPC 2.0 §5.1: "If there was an error in detecting
 * the id in the Request object (e.g. Parse error / Invalid Request), it
 * MUST be Null." This helper returns `null` for any non-conforming `id`
 * value; the caller does not need to discriminate.
 */
function extractIdSafely(envelope: Record<string, unknown>): JsonRpcId {
  const candidate = envelope["id"];
  if (typeof candidate === "string" || typeof candidate === "number" || candidate === null) {
    return candidate;
  }
  return null;
}
