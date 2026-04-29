// W-007p-2-T2..T6 + T10 — LocalIpcGateway test suite (T-007p-2-6).
//
// Spec coverage:
//   * Spec-007 §Wire Format (docs/specs/007-local-ipc-and-daemon-control.md
//     lines 50-56) — JSON-RPC 2.0 + LSP-style Content-Length framing;
//     1 MB max-message-size.
//   * Spec-007 §Required Behavior (lines 43-47) — OS-local default
//     transport (Unix domain socket on Unix-like; named pipe on Windows).
//   * ADR-009 (docs/decisions/009-json-rpc-ipc-wire-format.md) — wire-
//     format decision rationale per F-007p-2-08 (header citation
//     required on the gateway test file).
//
// W-tests covered here (per Plan-007 §Phase 2 lines 374-382):
//   * W-007p-2-T2 — Transport: Unix domain socket round-trip
//   * W-007p-2-T3 — Transport: Windows named pipe round-trip
//                   (it.skipIf(process.platform !== "win32") — Tier 1
//                   conservative; the OS-local socket in vitest CI is
//                   Linux per the matrix).
//   * W-007p-2-T4 — Transport: gated loopback fallback (Tier 1
//                   conservative gate, per F-007p-2-09). The
//                   `transport.unavailable` envelope code surface does
//                   not exist at the gateway layer today —
//                   `SecureDefaults.load` refuses non-loopback at
//                   config-time with `invalid_bind_address`. Use
//                   `it.todo` per the task contract authorization for
//                   absent surfaces; the test ID is preserved so the
//                   audit trace remains complete.
//   * W-007p-2-T5 — 1MB max-message-size enforcement (per F-007p-2-05).
//                   Body > 1MB → connection close + `-32600` error
//                   frame, per Plan-007 line 377. The mapping is wired
//                   at `jsonrpc-error-mapping.ts:175-199` (oversized_body
//                   → -32600 InvalidRequest per Plan-007:268).
//   * W-007p-2-T6 — Content-Length framing parser correctness:
//                   single message, multi-message buffer,
//                   partial-buffer wait, malformed framing.
//   * W-007p-2-T10 — Handler-thrown error mapping (I-007-8): unhandled
//                    handler exception → `-32603` with sanitized
//                    message; no stack/secret leak.
//
// Reset discipline: every `it()` runs in a `beforeEach` that calls
// `SecureDefaults.__resetForTest()` then `bootstrap({...})`. Vitest
// shares the Node process across cases, and `SecureDefaults` is a
// module singleton; without the reset, a test that loaded one socket
// path would poison the next. Each gateway-binding test allocates a
// FRESH socket path under `os.tmpdir()` so parallel test workers
// never collide on the same `sun_path`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  Handler,
  HandlerContext,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcResponse,
  ZodType,
} from "@ai-sidekicks/contracts";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts";

import { bootstrap } from "../../bootstrap/index.js";
import { SecureDefaults } from "../../bootstrap/secure-defaults.js";
import {
  encodeFrame,
  FramingError,
  LocalIpcGateway,
  MAX_MESSAGE_BYTES,
  parseFrame,
  sanitizeErrorMessage,
  SANITIZED_MESSAGE_MAX_LEN,
  type SupervisionHooks,
} from "../local-ipc-gateway.js";
import { JsonRpcErrorCode } from "../jsonrpc-error-mapping.js";
import { MethodRegistryImpl } from "../registry.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

/**
 * Daemon's `package.json` deliberately does NOT depend on `zod` (every
 * runtime-daemon source file routes `ZodType` as a TYPE-ONLY import via
 * `@ai-sidekicks/contracts`). The test surface must follow the same
 * posture: build a duck-typed schema mock that satisfies `ZodType<T>` via
 * a `safeParse` shape-match. The mock returns `{ success: true, data }`
 * for any input — sufficient for the gateway-layer tests below, all of
 * which exercise framing/transport/dispatch wiring rather than schema
 * validation specifically. Tests that need a REJECTING schema construct
 * a tailored mock inline.
 */
function passthroughSchema<T>(): ZodType<T> {
  return {
    safeParse: (v: unknown): { success: true; data: T } => ({
      success: true,
      data: v as T,
    }),
  } as unknown as ZodType<T>;
}

/**
 * Allocate a fresh ephemeral OS-local socket path under `os.tmpdir()`.
 * Linux's `sun_path` field is bounded to 107 bytes; we keep the path
 * short with a randomized suffix so parallel workers never collide.
 */
function ephemeralSocketPath(label: string): string {
  // Math.random keyed seed is acceptable here: the only contract is
  // "uniqueness across this run + parallel workers"; cryptographic
  // randomness is not required.
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `aisk-test-${label}-${suffix}.sock`);
}

/**
 * Connect a `net.Socket` to the gateway listener and accumulate the
 * incoming bytes until the test's matcher is satisfied. Returns a
 * helper bundle so tests can drive the socket's send + verify flows.
 */
interface ClientHelper {
  readonly socket: net.Socket;
  readonly received: Buffer[];
  readonly waitForBytes: (predicate: (acc: Buffer) => boolean) => Promise<Buffer>;
  readonly close: () => Promise<void>;
}

function makeClient(socketPath: string): Promise<ClientHelper> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const received: Buffer[] = [];
    const waiters: Array<{
      readonly predicate: (acc: Buffer) => boolean;
      readonly resolve: (value: Buffer) => void;
    }> = [];
    sock.on("data", (chunk: Buffer) => {
      received.push(chunk);
      const acc = Buffer.concat(received);
      // Walk waiters newest-first so a later predicate that matches
      // the current acc fires before earlier predicates that might
      // be staler.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w !== undefined && w.predicate(acc)) {
          waiters.splice(i, 1);
          w.resolve(acc);
        }
      }
    });
    sock.once("connect", () => {
      const helper: ClientHelper = {
        socket: sock,
        received,
        waitForBytes(predicate) {
          return new Promise((res) => {
            const acc = Buffer.concat(received);
            if (predicate(acc)) {
              res(acc);
              return;
            }
            waiters.push({ predicate, resolve: res });
          });
        },
        close() {
          if (sock.destroyed) {
            return Promise.resolve();
          }
          return new Promise<void>((res) => {
            sock.once("close", () => {
              res();
            });
            sock.end();
          });
        },
      };
      resolve(helper);
    });
    sock.once("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Decode a single JSON-RPC envelope from an accumulated buffer that
 * contains AT LEAST ONE complete frame. Throws if the buffer doesn't
 * decode (test misuse / framing regression).
 */
function decodeOneFrame(acc: Buffer): unknown {
  const result = parseFrame(acc);
  if (result.frame === null) {
    throw new Error(
      `decodeOneFrame: buffer did not contain a complete frame (length=${acc.byteLength})`,
    );
  }
  const text = result.frame.toString("utf8");
  return JSON.parse(text);
}

// ----------------------------------------------------------------------------
// Per-test reset
// ----------------------------------------------------------------------------

beforeEach(() => {
  SecureDefaults.__resetForTest();
});

afterEach(() => {
  SecureDefaults.__resetForTest();
});

// ----------------------------------------------------------------------------
// W-007p-2-T6 — parseFrame / encodeFrame correctness (synchronous)
// ----------------------------------------------------------------------------
//
// These cases exercise the framing parser directly without binding the
// listener. They run synchronously; no socket is opened. The spec calls
// out four scenarios:
//   * single message
//   * multi-message buffer
//   * partial-buffer wait
//   * malformed framing → connection close (the connection-close branch is
//     covered in W-007p-2-T5/T10 via the gateway path; here we assert the
//     parser-throw shape that the gateway converts into the disconnect).

describe("W-007p-2-T6 — Content-Length framing parser correctness", () => {
  it("decodes a single complete frame and reports byte-correct `consumed`", () => {
    const envelope = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: {} };
    const frame = encodeFrame(envelope);
    const result = parseFrame(frame);
    expect(result.frame).not.toBeNull();
    expect(result.consumed).toBe(frame.byteLength);
    if (result.frame === null) {
      // Type-narrow for TS; the assertion above already failed if so.
      throw new Error("unreachable");
    }
    expect(JSON.parse(result.frame.toString("utf8"))).toStrictEqual(envelope);
  });

  it("decodes the first frame from a multi-message buffer and consumes only its bytes", () => {
    const env1 = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { a: 1 } };
    const env2 = { jsonrpc: JSONRPC_VERSION, id: 2, method: "x.y", params: { b: 2 } };
    const buf = Buffer.concat([encodeFrame(env1), encodeFrame(env2)]);
    const r1 = parseFrame(buf);
    expect(r1.frame).not.toBeNull();
    if (r1.frame === null) throw new Error("unreachable");
    expect(JSON.parse(r1.frame.toString("utf8"))).toStrictEqual(env1);
    // Re-parse the remainder.
    const remainder = buf.subarray(r1.consumed);
    const r2 = parseFrame(remainder);
    expect(r2.frame).not.toBeNull();
    if (r2.frame === null) throw new Error("unreachable");
    expect(JSON.parse(r2.frame.toString("utf8"))).toStrictEqual(env2);
  });

  it("returns `{ frame: null, consumed: 0 }` for a partial buffer (header only)", () => {
    const result = parseFrame(Buffer.from("Content-Length: 100\r\n", "ascii"));
    expect(result.frame).toBeNull();
    expect(result.consumed).toBe(0);
  });

  it("returns `{ frame: null, consumed: 0 }` for a partial buffer (header complete, body short)", () => {
    const env = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: {} };
    const full = encodeFrame(env);
    // Truncate to 5 bytes BEFORE end — header is complete, body partial.
    const partial = full.subarray(0, full.byteLength - 5);
    const result = parseFrame(partial);
    expect(result.frame).toBeNull();
    expect(result.consumed).toBe(0);
  });

  it("throws FramingError(`malformed_header`) when internal header lines use LF instead of CRLF", () => {
    // The parser searches for `\r\n\r\n` as the header/body separator
    // first. To exercise the LF-rejection branch in
    // `extractContentLength` we need the OUTER terminator to be CRLFCRLF
    // (so the parser slices a header section) but an INTERNAL line
    // terminator to be LF only. The header section contains
    // `X-Other: 1\nContent-Length: 5\r\n` followed by the CRLFCRLF
    // separator + body; after slicing, the header text contains `\n`
    // but no `\r\n` interior split — the LF-rejection fires.
    const buf = Buffer.from("X-Other: 1\nContent-Length: 5\r\n\r\n12345", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_header");
    }
  });

  it("throws FramingError(`malformed_content_length`) for non-numeric Content-Length", () => {
    const buf = Buffer.from("Content-Length: abc\r\n\r\n", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_content_length");
    }
  });

  it("throws FramingError(`missing_content_length`) when header lacks Content-Length", () => {
    const buf = Buffer.from("Other-Header: 5\r\n\r\n12345", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("missing_content_length");
    }
  });

  it("throws FramingError(`malformed_content_length`) for duplicated Content-Length headers (request-smuggling shape)", () => {
    const buf = Buffer.from("Content-Length: 5\r\nContent-Length: 6\r\n\r\n123456", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_content_length");
    }
  });

  it("encodeFrame round-trips multi-byte UTF-8 bodies (byte-count, not char-count)", () => {
    // The string "héllo" is 6 bytes UTF-8 (h=1 + é=2 + l=1 + l=1 + o=1).
    const env = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { msg: "héllo" } };
    const frame = encodeFrame(env);
    const result = parseFrame(frame);
    expect(result.frame).not.toBeNull();
    if (result.frame === null) throw new Error("unreachable");
    // Confirm the decoded body is byte-faithful — the multi-byte é survives.
    const decoded = JSON.parse(result.frame.toString("utf8")) as Record<string, unknown>;
    const params = decoded["params"];
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("unexpected non-object params");
    }
    expect((params as Record<string, unknown>)["msg"]).toBe("héllo");
  });
});

// ----------------------------------------------------------------------------
// W-007p-2-T2 — Unix domain socket round-trip
// ----------------------------------------------------------------------------

describe("W-007p-2-T2 — Unix domain socket round-trip", () => {
  it("binds, accepts a connection, dispatches a request, and returns the typed result", async () => {
    const socketPath = ephemeralSocketPath("t2");
    bootstrap({
      bindAddress: "127.0.0.1",
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
    // Register a deterministic echo handler to verify round-trip.
    const handler: Handler<{ a: number; b: number }, { sum: number }> = async (params) => {
      return { sum: params.a + params.b };
    };
    registry.register(
      "math.sum",
      passthroughSchema<{ a: number; b: number }>(),
      passthroughSchema<{ sum: number }>(),
      handler,
    );

    const gateway = new LocalIpcGateway({ registry });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        const request = {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: "math.sum",
          params: { a: 3, b: 4 },
        };
        client.socket.write(encodeFrame(request));
        const acc = await client.waitForBytes((b) => {
          // Wait until at least one full frame has arrived.
          const r = (() => {
            try {
              return parseFrame(b);
            } catch {
              return { frame: null, consumed: 0 };
            }
          })();
          return r.frame !== null;
        });
        const response = decodeOneFrame(acc) as JsonRpcResponse;
        expect(response.jsonrpc).toBe(JSONRPC_VERSION);
        expect(response.id).toBe(1);
        expect(response.result).toStrictEqual({ sum: 7 });
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// W-007p-2-T3 — Windows named pipe round-trip
// ----------------------------------------------------------------------------
//
// Tier 1's CI matrix is Linux-only per ADR-022 + ADR-023; the Windows
// pipe transport surface is verified at Tier 4 once the Windows runner
// lands. The conservative posture here is `it.skipIf` so the test ID
// is preserved for audit + the case re-activates automatically when
// the Windows runner arrives.

describe("W-007p-2-T3 — Windows named pipe round-trip", () => {
  it.skipIf(process.platform !== "win32")(
    "binds a named pipe, accepts a connection, dispatches a request, and returns the typed result",
    async () => {
      const pipeName = `\\\\?\\pipe\\aisk-test-t3-${Math.random().toString(36).slice(2, 10)}`;
      bootstrap({
        bindAddress: "127.0.0.1",
        localIpcPath: pipeName,
        bannerFormat: "text",
      });
      const registry = new MethodRegistryImpl();
      const handler: Handler<{ ping: boolean }, { pong: boolean }> = async () => {
        return { pong: true };
      };
      registry.register(
        "ping.echo",
        passthroughSchema<{ ping: boolean }>(),
        passthroughSchema<{ pong: boolean }>(),
        handler,
      );
      const gateway = new LocalIpcGateway({ registry });
      try {
        await gateway.start();
        const client = await makeClient(pipeName);
        try {
          const request = {
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "ping.echo",
            params: { ping: true },
          };
          client.socket.write(encodeFrame(request));
          const acc = await client.waitForBytes((b) => {
            const r = (() => {
              try {
                return parseFrame(b);
              } catch {
                return { frame: null, consumed: 0 };
              }
            })();
            return r.frame !== null;
          });
          const response = decodeOneFrame(acc) as JsonRpcResponse;
          expect(response.id).toBe(1);
          expect(response.result).toStrictEqual({ pong: true });
        } finally {
          await client.close();
        }
      } finally {
        await gateway.stop();
      }
    },
  );
});

// ----------------------------------------------------------------------------
// W-007p-2-T4 — Gated loopback fallback (Tier 1 conservative gate)
// ----------------------------------------------------------------------------
//
// Per F-007p-2-09, attempting a non-loopback bind path at Tier 1 must
// fail with `transport.unavailable` (BLOCKED-ON-C7 envelope). Today's
// surface refuses non-loopback at SecureDefaults.load with
// `invalid_bind_address` (config-time, not gateway-time); the
// `transport.unavailable` shape on the wire does not yet exist. Marked
// `it.todo` per task contract authorization for absent surfaces; the
// test ID is preserved so Tier 4's widening pass picks up the
// inflation.

describe("W-007p-2-T4 — gated loopback fallback (Tier 1)", () => {
  it.todo(
    "non-loopback bind attempt fails at the gateway with `transport.unavailable` (BLOCKED-ON-C7 envelope; surface deferred to Tier 4 where the gate fires at gateway-time rather than config-time)",
  );
});

// ----------------------------------------------------------------------------
// W-007p-2-T5 — 1MB max-message-size enforcement
// ----------------------------------------------------------------------------
//
// Per Plan-007 line 377: "Body > 1MB → connection close + `-32600` error
// frame; subsequent reconnect succeeds." The mapping (oversized_body →
// -32600 InvalidRequest) lives at jsonrpc-error-mapping.ts:175-199; the
// disconnect-then-reconnect contract is enforced by the gateway's
// framing-error tear-down path at local-ipc-gateway.ts:858-882.

describe("W-007p-2-T5 — 1MB max-message-size enforcement", () => {
  it("oversized body → connection close + `-32600` InvalidRequest error frame; reconnect succeeds", async () => {
    const socketPath = ephemeralSocketPath("t5");
    bootstrap({
      bindAddress: "127.0.0.1",
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
    const handler: Handler<unknown, { ok: boolean }> = async () => ({ ok: true });
    registry.register(
      "x.y",
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: boolean }>(),
      handler,
    );
    const gateway = new LocalIpcGateway({ registry });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        // Construct a forged frame whose Content-Length declares a body
        // size > MAX_MESSAGE_BYTES. The gateway parses the header,
        // throws FramingError(`oversized_body`), emits the error frame,
        // and tears down. We never need to send the body bytes — the
        // length-declaration alone trips the gate.
        const oversizedHeader = `Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`;
        client.socket.write(Buffer.from(oversizedHeader, "ascii"));
        // Wait either for an error frame or for the connection to close.
        const closed = new Promise<"closed">((resolve) => {
          client.socket.once("close", () => {
            resolve("closed");
          });
        });
        const errored = client.waitForBytes((b) => {
          try {
            return parseFrame(b).frame !== null;
          } catch {
            return false;
          }
        });
        const racer = await Promise.race([
          closed,
          errored.then((acc) => ({ kind: "errored" as const, acc })),
        ]);
        // The gateway emits the error frame BEFORE destroying the
        // socket, so we expect either:
        //   * a parse-able error frame in `received` AND a subsequent
        //     close (best-effort emit + tear-down per plan §377), OR
        //   * close-only when the kernel already shut the socket
        //     before the error frame's flush completed (race).
        // Plan-007:377 mandates the error-frame surface; we assert it
        // here and let the test fail loudly if the implementation
        // tears down without writing.
        expect(racer).not.toBe("closed");
        if (typeof racer === "object") {
          const response = decodeOneFrame(racer.acc) as JsonRpcErrorResponse;
          expect(response.jsonrpc).toBe(JSONRPC_VERSION);
          expect(response.id).toBeNull();
          // Plan-specified error code per Plan-007:268 + 377: -32600
          // InvalidRequest (oversized_body framing path). Mapping wired
          // at jsonrpc-error-mapping.ts:175-199.
          expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
          // Wait for the eventual close so the next assertion runs
          // against a torn-down socket.
          await closed;
        }
      } finally {
        // The previous client may have been destroyed already; .close()
        // is idempotent.
        await client.close().catch(() => undefined);
      }
      // Reconnect succeeds — the listener is still bound, only the
      // single offending connection was torn down.
      const client2 = await makeClient(socketPath);
      try {
        const request = {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: "x.y",
          params: {},
        };
        client2.socket.write(encodeFrame(request));
        const acc = await client2.waitForBytes((b) => {
          try {
            return parseFrame(b).frame !== null;
          } catch {
            return false;
          }
        });
        const response = decodeOneFrame(acc) as JsonRpcResponse;
        expect(response.id).toBe(1);
        expect(response.result).toStrictEqual({ ok: true });
      } finally {
        await client2.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// W-007p-2-T10 — Handler-thrown error mapping (I-007-8)
// ----------------------------------------------------------------------------
//
// The handler throws an Error whose message contains a Unix absolute
// path (path-leak shape). The substrate's `mapJsonRpcError` →
// `sanitizeErrorMessage` pipeline is expected to:
//   1. Map the unhandled throw to `-32603 InternalError` (per
//      jsonrpc-error-mapping.ts lines 358-360).
//   2. Replace the absolute path with `<redacted-path>` per the
//      I-007-8 contract.
//   3. NEVER emit `.stack` content on the wire.

describe("W-007p-2-T10 — handler-thrown error mapping (I-007-8)", () => {
  it("unhandled handler exception → `-32603` with sanitized message; no path/stack leak", async () => {
    const socketPath = ephemeralSocketPath("t10");
    bootstrap({
      bindAddress: "127.0.0.1",
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
    const handler: Handler<unknown, unknown> = async () => {
      // This message contains a Unix path that I-007-8 must redact and
      // a stable token ("BOOM") the test asserts survives.
      throw new Error("BOOM at /home/secret/path/to/file.ts:42:7");
    };
    registry.register(
      "math.sum",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      handler,
    );

    const gateway = new LocalIpcGateway({ registry });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        const request = {
          jsonrpc: JSONRPC_VERSION,
          id: 9,
          method: "math.sum",
          params: {},
        };
        client.socket.write(encodeFrame(request));
        const acc = await client.waitForBytes((b) => {
          try {
            return parseFrame(b).frame !== null;
          } catch {
            return false;
          }
        });
        const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
        expect(response.jsonrpc).toBe(JSONRPC_VERSION);
        expect(response.id).toBe(9);
        expect(response.error.code).toBe(JsonRpcErrorCode.InternalError);
        // Sanitization: `/home/secret/path/...` → `<redacted-path>`.
        expect(response.error.message).not.toMatch(/\/home\/secret\/path/);
        expect(response.error.message).toContain("<redacted-path>");
        // The stable BOOM token survives — sanitization is over-redaction-safe
        // but should not destroy the human-readable hint entirely.
        expect(response.error.message).toContain("BOOM");
        // Stack-trace shape MUST NOT appear (no "at " followed by file
        // references — `sanitizeErrorMessage` reads .message only,
        // never .stack).
        expect(response.error.message).not.toMatch(/\bat\s+\S+\s+\(/);
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  it("sanitizeErrorMessage caps output at SANITIZED_MESSAGE_MAX_LEN with `…[truncated]` suffix", () => {
    // Pathological 1 MB message; sanitizer must cap at 8 KB.
    const huge = "x".repeat(SANITIZED_MESSAGE_MAX_LEN * 2);
    const out = sanitizeErrorMessage(new Error(huge));
    expect(out.length).toBeLessThanOrEqual(SANITIZED_MESSAGE_MAX_LEN);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("sanitizeErrorMessage does NOT throw for poisoned thrown values whose toString itself throws", () => {
    const poison = {
      toString(): string {
        throw new Error("toString-poison");
      },
    };
    // The non-throwing contract per local-ipc-gateway.ts:466-477.
    expect(() => sanitizeErrorMessage(poison)).not.toThrow();
    expect(sanitizeErrorMessage(poison)).toBe("<unprintable thrown value>");
  });

  it("supervision hooks fire on connect / disconnect with a stable transport id", async () => {
    const socketPath = ephemeralSocketPath("t10-hooks");
    bootstrap({
      bindAddress: "127.0.0.1",
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    const hooks: SupervisionHooks = {
      onConnect,
      onDisconnect,
      onError,
    };
    const gateway = new LocalIpcGateway({ registry, hooks });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      // Wait until the gateway's connect handler ran.
      await new Promise<void>((res) => setTimeout(res, 25));
      expect(onConnect).toHaveBeenCalledTimes(1);
      const transportArg = onConnect.mock.calls[0]?.[0];
      expect(transportArg).toBeDefined();
      // Family is "unix" on Linux Tier 1.
      if (
        transportArg !== null &&
        typeof transportArg === "object" &&
        "remoteFamily" in transportArg
      ) {
        const family = (transportArg as { remoteFamily: unknown }).remoteFamily;
        expect(family).toBe("unix");
      }
      await client.close();
      await new Promise<void>((res) => setTimeout(res, 25));
      expect(onDisconnect).toHaveBeenCalled();
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// I-007-1 enforcement — assertLoadedForBind throws at gateway start without prior bootstrap
// ----------------------------------------------------------------------------
//
// Bonus coverage that ties the gateway to the Phase 1 bootstrap seam.
// SecureDefaults is reset in beforeEach but bootstrap is NOT called; the
// gateway's first action is `assertLoadedForBind()` which must throw.

describe("I-007-1 enforcement (gateway side)", () => {
  it("LocalIpcGateway.start() throws synchronously when SecureDefaults has not been loaded", async () => {
    const registry = new MethodRegistryImpl();
    const gateway = new LocalIpcGateway({ registry });
    await expect(gateway.start()).rejects.toThrow(/SecureDefaults\.load|I-007-1/);
  });
});

// Helper-type guard to avoid `any` lint when introspecting unknown context.
function _typeGuards(_ctx: HandlerContext, _id: JsonRpcId): void {
  // Type-only file fixture: ensures the imports aren't unused even when
  // the test bodies above narrow inline.
  void _ctx;
  void _id;
}
