// Tests `LocalIpcGateway` over a real local socket: Content-Length framing and its size caps, the
// request-id and `protocolVersion` envelope gates, error sanitization, and start/stop behavior.
//
// Each gateway test bootstraps `SecureDefaults` with its own socket path before binding; the
// latest load wins. Every test that binds a socket uses a fresh path under `os.tmpdir()` so parallel
// workers never collide.

import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type {
  Handler,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@ai-sidekicks/contracts";
import {
  JSON_RPC_ID_MAX_BYTES,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  MAX_MESSAGE_BYTES,
} from "@ai-sidekicks/contracts";

import { bootstrap } from "../../bootstrap/index.js";
import { FramingError, parseFrame } from "../content-length-framing.js";
import {
  encodeFrame,
  LocalIpcGateway,
  sanitizeErrorMessage,
  SANITIZED_MESSAGE_MAX_LEN,
  type SupervisionHooks,
} from "../local-ipc-gateway.js";
import { MethodRegistryImpl } from "../registry.js";

import { passthroughSchema } from "../__fixtures__/zod-schemas.js";

/**
 * The envelope-level `protocolVersion` every non-handshake request must carry (an ISO 8601
 * `YYYY-MM-DD` date); the gateway refuses a request without it before dispatch.
 */
const TEST_PROTOCOL_VERSION = "2026-05-01";

// A short unique path under `os.tmpdir()`; Linux limits a socket path (`sun_path`) to 107 bytes.
function ephemeralSocketPath(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `aisk-test-${label}-${suffix}.sock`);
}

// A connected client socket that accumulates the bytes it receives. `waitForFrames(n)` resolves
// with the accumulated bytes once they hold `n` complete frames; a malformed reply rejects with the
// parser's `FramingError` instead of waiting for the test timeout.
interface ClientHelper {
  readonly socket: net.Socket;
  readonly received: Buffer[];
  readonly waitForFrames: (count: number) => Promise<Buffer>;
  readonly close: () => Promise<void>;
}

function countCompleteFrames(acc: Buffer): number {
  let count = 0;
  let rest = acc;
  for (;;) {
    const result = parseFrame(rest, MAX_MESSAGE_BYTES);
    if (result.frame === null) {
      return count;
    }
    count += 1;
    rest = rest.subarray(result.consumed);
  }
}

function makeClient(socketPath: string): Promise<ClientHelper> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const received: Buffer[] = [];
    const waiters: Array<{
      readonly count: number;
      readonly resolve: (value: Buffer) => void;
      readonly reject: (reason: unknown) => void;
    }> = [];
    // Settles every waiter the accumulated bytes answer; a framing error rejects them all.
    const settleWaiters = (): void => {
      const acc = Buffer.concat(received);
      let frameCount: number;
      try {
        frameCount = countCompleteFrames(acc);
      } catch (framingError) {
        for (const waiter of waiters.splice(0)) {
          waiter.reject(framingError);
        }
        return;
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter !== undefined && frameCount >= waiter.count) {
          waiters.splice(i, 1);
          waiter.resolve(acc);
        }
      }
    };
    sock.on("data", (chunk: Buffer) => {
      received.push(chunk);
      settleWaiters();
    });
    sock.once("connect", () => {
      const helper: ClientHelper = {
        socket: sock,
        received,
        waitForFrames(count) {
          return new Promise((res, rej) => {
            waiters.push({ count, resolve: res, reject: rej });
            settleWaiters();
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

// Decodes the first complete frame in `acc`; throws if there is none.
function decodeOneFrame(acc: Buffer): unknown {
  const result = parseFrame(acc, MAX_MESSAGE_BYTES);
  if (result.frame === null) {
    throw new Error(
      `decodeOneFrame: buffer did not contain a complete frame (length=${acc.byteLength})`,
    );
  }
  const text = result.frame.toString("utf8");
  return JSON.parse(text);
}

describe("Content-Length framing parser correctness", () => {
  it("decodes a single complete frame and reports byte-correct `consumed`", () => {
    const envelope = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: {} };
    const frame = encodeFrame(envelope);
    const result = parseFrame(frame, MAX_MESSAGE_BYTES);
    expect(result.frame).not.toBeNull();
    expect(result.consumed).toBe(frame.byteLength);
    if (result.frame === null) {
      throw new Error("unreachable");
    }
    expect(JSON.parse(result.frame.toString("utf8"))).toStrictEqual(envelope);
  });

  it("decodes the first frame from a multi-message buffer and consumes only its bytes", () => {
    const env1 = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { a: 1 } };
    const env2 = { jsonrpc: JSONRPC_VERSION, id: 2, method: "x.y", params: { b: 2 } };
    const buf = Buffer.concat([encodeFrame(env1), encodeFrame(env2)]);
    const r1 = parseFrame(buf, MAX_MESSAGE_BYTES);
    expect(r1.frame).not.toBeNull();
    if (r1.frame === null) throw new Error("unreachable");
    expect(JSON.parse(r1.frame.toString("utf8"))).toStrictEqual(env1);
    const remainder = buf.subarray(r1.consumed);
    const r2 = parseFrame(remainder, MAX_MESSAGE_BYTES);
    expect(r2.frame).not.toBeNull();
    if (r2.frame === null) throw new Error("unreachable");
    expect(JSON.parse(r2.frame.toString("utf8"))).toStrictEqual(env2);
  });

  it("returns `{ frame: null, consumed: 0 }` for a partial buffer, header only or body short", () => {
    const headerOnly = parseFrame(
      Buffer.from("Content-Length: 100\r\n", "ascii"),
      MAX_MESSAGE_BYTES,
    );
    expect(headerOnly.frame).toBeNull();
    expect(headerOnly.consumed).toBe(0);

    const env = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: {} };
    const full = encodeFrame(env);
    // The header is complete but the last 5 body bytes are missing.
    const partial = full.subarray(0, full.byteLength - 5);
    const result = parseFrame(partial, MAX_MESSAGE_BYTES);
    expect(result.frame).toBeNull();
    expect(result.consumed).toBe(0);
  });

  it("throws FramingError for an LF header line, a non-numeric length and a missing length", () => {
    // The header/body separator is CRLFCRLF, but a line inside the header ends in a bare LF.
    const buf = Buffer.from("X-Other: 1\nContent-Length: 5\r\n\r\n12345", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf, MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_header");
    }

    caught = null;
    try {
      parseFrame(Buffer.from("Content-Length: abc\r\n\r\n", "ascii"), MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_content_length");
    }

    caught = null;
    try {
      parseFrame(Buffer.from("Other-Header: 5\r\n\r\n12345", "ascii"), MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("missing_content_length");
    }
  });

  // Digits only, as HTTP/1.1 `Content-Length = 1*DIGIT`: `parseInt` would read `12junk` and
  // `12.5` as 12, and `Number` would read `""`, `12e1` and `0x12` as 0, 120 and 18, so the two
  // sides would slice different lengths.
  it.each([
    ["empty string", ""],
    ["embedded letters", "12junk"],
    ["fractional", "12.5"],
    ["scientific notation", "12e1"],
    ["negative sign", "-12"],
    ["positive sign", "+12"],
    ["hex literal", "0x12"],
  ])("refuses a non-decimal Content-Length (%s) and echoes it JSON-encoded", (_label, raw) => {
    let caught: unknown = null;
    try {
      parseFrame(Buffer.from(`Content-Length: ${raw}\r\n\r\n`, "ascii"), MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_content_length");
      // JSON-encoded so a peer cannot inject CRLF or control bytes into logs.
      expect(caught.message).toContain(JSON.stringify(raw.trim()));
    }
  });

  it("throws FramingError(`malformed_content_length`) for duplicated Content-Length headers (request-smuggling shape)", () => {
    const buf = Buffer.from("Content-Length: 5\r\nContent-Length: 6\r\n\r\n123456", "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf, MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("malformed_content_length");
    }
  });

  it("encodeFrame round-trips multi-byte UTF-8 bodies (byte-count, not char-count)", () => {
    // "héllo" is 6 bytes in UTF-8 but 5 characters.
    const env = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { msg: "héllo" } };
    const frame = encodeFrame(env);
    const result = parseFrame(frame, MAX_MESSAGE_BYTES);
    expect(result.frame).not.toBeNull();
    if (result.frame === null) throw new Error("unreachable");
    const decoded = JSON.parse(result.frame.toString("utf8")) as Record<string, unknown>;
    const params = decoded["params"];
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("unexpected non-object params");
    }
    expect((params as Record<string, unknown>)["msg"]).toBe("héllo");
  });
});

describe("Unix domain socket round-trip", () => {
  it("binds, accepts a connection, dispatches a request, and returns the typed result", async () => {
    const socketPath = ephemeralSocketPath("round-trip");
    bootstrap({
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
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
          protocolVersion: TEST_PROTOCOL_VERSION,
          params: { a: 3, b: 4 },
        };
        client.socket.write(encodeFrame(request));
        const acc = await client.waitForFrames(1);
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

// CI runs on Linux only, so this case is skipped everywhere but Windows.
describe("Windows named pipe round-trip", () => {
  it.skipIf(process.platform !== "win32")(
    "binds a named pipe, accepts a connection, dispatches a request, and returns the typed result",
    async () => {
      const pipeName = `\\\\?\\pipe\\aisk-test-pipe-round-trip-${Math.random().toString(36).slice(2, 10)}`;
      bootstrap({
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
            protocolVersion: TEST_PROTOCOL_VERSION,
            params: { ping: true },
          };
          client.socket.write(encodeFrame(request));
          const acc = await client.waitForFrames(1);
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

describe("max-message-size enforcement", () => {
  it("oversized body → connection close + `-32600` InvalidRequest error frame; reconnect succeeds", async () => {
    const socketPath = ephemeralSocketPath("oversized");
    bootstrap({
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
        // The declared length alone trips the cap, so the body is never sent.
        const oversizedHeader = `Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`;
        client.socket.write(Buffer.from(oversizedHeader, "ascii"));
        const closed = new Promise<"closed">((resolve) => {
          client.socket.once("close", () => {
            resolve("closed");
          });
        });
        const errored = client.waitForFrames(1);
        const racer = await Promise.race([
          closed,
          errored.then((acc) => ({ kind: "errored" as const, acc })),
        ]);
        // The gateway writes the error frame before it destroys the socket, so a close with no
        // frame is a failure.
        expect(racer).not.toBe("closed");
        if (typeof racer === "object") {
          const response = decodeOneFrame(racer.acc) as JsonRpcErrorResponse;
          expect(response.jsonrpc).toBe(JSONRPC_VERSION);
          expect(response.id).toBeNull();
          expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
          // `data.type` is `transport.message_too_large`; `data.fields` carries the framing
          // error's `{ limit, observed }`.
          expect(response.error.data).toMatchObject({
            type: "transport.message_too_large",
            fields: {
              limit: MAX_MESSAGE_BYTES,
              observed: MAX_MESSAGE_BYTES + 1,
            },
          });
          await closed;
        }
      } finally {
        // The gateway may already have destroyed this socket.
        await client.close().catch(() => undefined);
      }
      // Only the offending connection was torn down; the listener still accepts.
      const client2 = await makeClient(socketPath);
      try {
        const request = {
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: "x.y",
          protocolVersion: TEST_PROTOCOL_VERSION,
          params: {},
        };
        client2.socket.write(encodeFrame(request));
        const acc = await client2.waitForFrames(1);
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

describe("handler-thrown error mapping", () => {
  it("unhandled handler exception → `-32603` with sanitized message; no path/stack leak", async () => {
    const socketPath = ephemeralSocketPath("error-mapping");
    bootstrap({
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry = new MethodRegistryImpl();
    const handler: Handler<unknown, unknown> = async () => {
      // The path must be redacted; "BOOM" must survive.
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
          protocolVersion: TEST_PROTOCOL_VERSION,
          params: {},
        };
        client.socket.write(encodeFrame(request));
        const acc = await client.waitForFrames(1);
        const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
        expect(response.jsonrpc).toBe(JSONRPC_VERSION);
        expect(response.id).toBe(9);
        expect(response.error.code).toBe(JsonRpcErrorCode.InternalError);
        expect(response.error.message).not.toMatch(/\/home\/secret\/path/);
        expect(response.error.message).toContain("<redacted-path>");
        expect(response.error.message).toContain("BOOM");
        // No stack-trace frame: only `.message` is read, never `.stack`.
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
    // A message twice the cap must be truncated to the cap.
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
    // Sanitizing an error must never throw itself.
    expect(() => sanitizeErrorMessage(poison)).not.toThrow();
    expect(sanitizeErrorMessage(poison)).toBe("<unprintable thrown value>");
  });

  it("supervision hooks fire on connect / disconnect with a stable transport id", async () => {
    const socketPath = ephemeralSocketPath("hooks");
    bootstrap({
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
      await vi.waitFor(() => {
        expect(onConnect).toHaveBeenCalledTimes(1);
      });
      const connectedTransport = onConnect.mock.calls[0]?.[0] as { readonly id: number };
      await client.close();
      await vi.waitFor(() => {
        expect(onDisconnect).toHaveBeenCalledTimes(1);
      });
      expect(onDisconnect).toHaveBeenCalledWith(connectedTransport, "client_close");
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

describe("enforcement (gateway side)", () => {
  it("LocalIpcGateway.start() throws when SecureDefaults has not been loaded", async () => {
    // A fresh module graph, so no earlier case's load is in force.
    vi.resetModules();
    const { LocalIpcGateway: UnloadedGateway } = await import("../local-ipc-gateway.js");
    const { MethodRegistryImpl: UnloadedRegistry } = await import("../registry.js");
    const gateway = new UnloadedGateway({ registry: new UnloadedRegistry() });
    await expect(gateway.start()).rejects.toThrow(/must complete before any listener bind/);
  });
});

// A `start()` that fails to bind must leave the gateway unstarted, so a retry is allowed instead
// of failing with "gateway already started".
describe("start() rollback on listen failure", () => {
  it("rejects a failed bind and lets start() be retried", async () => {
    const socketPath = ephemeralSocketPath("rollback");
    bootstrap({
      localIpcPath: socketPath,
      bannerFormat: "text",
    });
    const registry1 = new MethodRegistryImpl();
    const registry2 = new MethodRegistryImpl();
    const occupier = new LocalIpcGateway({ registry: registry1 });
    const contender = new LocalIpcGateway({ registry: registry2 });
    try {
      await occupier.start();
      // The path already has a live listener, so this bind fails with EADDRINUSE.
      let firstError: unknown = null;
      try {
        await contender.start();
      } catch (err) {
        firstError = err;
      }
      expect(firstError).not.toBeNull();
      // Free the path, including the stale socket file Node leaves behind, then retry.
      await occupier.stop();
      await fs.rm(socketPath, { force: true });
      // The retry must get past the "already started" guard; a bind failure for another reason
      // is an environment problem, not this contract.
      let retryError: unknown = null;
      try {
        await contender.start();
      } catch (err) {
        retryError = err;
      }
      if (retryError !== null) {
        const msg = retryError instanceof Error ? retryError.message : String(retryError);
        expect(msg).not.toMatch(/already started/);
      } else {
        await contender.stop();
      }
    } finally {
      // Either gateway may already be stopped.
      await occupier.stop().catch(() => undefined);
      await contender.stop().catch(() => undefined);
      await fs.rm(socketPath, { force: true });
    }
  });
});

// A request id that is not a string, number or null is an Invalid Request; it is refused before
// the handler runs and the reply carries a null id.
describe("malformed request id rejected before dispatch", () => {
  const malformedIds: ReadonlyArray<{ readonly label: string; readonly idJson: string }> = [
    { label: "object", idJson: "{}" },
    { label: "array", idJson: "[]" },
    { label: "boolean", idJson: "true" },
  ];
  for (const { label, idJson } of malformedIds) {
    it(`rejects {"id": ${idJson}} as -32600 InvalidRequest without invoking the handler`, async () => {
      const socketPath = ephemeralSocketPath(`bad-id-${label}`);
      bootstrap({
        localIpcPath: socketPath,
        bannerFormat: "text",
      });
      const registry = new MethodRegistryImpl();
      const handlerSpy = vi.fn(async () => ({ ok: true }));
      const handler: Handler<unknown, { ok: boolean }> = handlerSpy;
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
          // Built by hand because `encodeFrame` takes only a valid `JsonRpcId`.
          const bodyText = `{"jsonrpc":"${JSONRPC_VERSION}","id":${idJson},"method":"x.y","params":{}}`;
          const bodyBytes = Buffer.from(bodyText, "utf8");
          const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
          client.socket.write(Buffer.concat([Buffer.from(header, "ascii"), bodyBytes]));
          const acc = await client.waitForFrames(1);
          const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
          expect(response.jsonrpc).toBe(JSONRPC_VERSION);
          // JSON-RPC 2.0 requires a null id when the request id is invalid.
          expect(response.id).toBeNull();
          expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
          // Reported as the id failure, ahead of the missing protocolVersion.
          expect(response.error.data).toMatchObject({ type: "invalid_envelope" });
          expect(handlerSpy).not.toHaveBeenCalled();
        } finally {
          await client.close();
        }
      } finally {
        await gateway.stop();
        await fs.rm(socketPath, { force: true });
      }
    });
  }
});

// The reply echoes the request `id`, so the caller controls that part of the reply's size. An
// id that fits the request frame can make every reply too large to encode, and the gateway
// destroys the socket when a reply cannot be encoded. `JSON_RPC_ID_MAX_BYTES` is therefore
// enforced when the request arrives: by the id-bound refusal in `#dispatchFrame`, and by
// `extractIdSafely` dropping an over-bound id to null for the earlier gates that reply first.

describe("JSON_RPC_ID_MAX_BYTES — an oversized request id is refused, never echoed", () => {
  const oversizedId = "z".repeat(100_000);

  it("refuses a 100 KB id as -32600 without invoking the handler, and echoes null", async () => {
    const socketPath = ephemeralSocketPath("oversized-id");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
    const registry = new MethodRegistryImpl();
    const handlerSpy = vi.fn(async () => ({ ok: true }));
    const handler: Handler<unknown, { ok: boolean }> = handlerSpy;
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
        const bodyText = JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: oversizedId,
          method: "x.y",
          protocolVersion: "2026-05-01",
          params: {},
        });
        const bodyBytes = Buffer.from(bodyText, "utf8");
        // The request is under the frame cap; only its reply would be too large.
        expect(bodyBytes.byteLength).toBeLessThan(MAX_MESSAGE_BYTES);
        const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
        client.socket.write(Buffer.concat([Buffer.from(header, "ascii"), bodyBytes]));
        const acc = await client.waitForFrames(1);
        const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
        expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
        expect(response.error.data).toMatchObject({ type: "invalid_envelope" });
        // The oversized id is not echoed; echoing it would make the reply unencodable.
        expect(response.id).toBeNull();
        expect(JSON.stringify(response)).not.toContain(oversizedId);
        expect(handlerSpy).not.toHaveBeenCalled();
        // The refusal answers one request; it does not disconnect.
        expect(client.socket.destroyed).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  it("drops an oversized id to null on an EARLIER envelope gate rather than echoing it", async () => {
    // `method` is validated before the id-bound refusal, and that error reply takes its id from
    // `extractIdSafely`. Without the bound inside that helper the reply would echo 100 KB and
    // the connection would close instead of the client being told the request was malformed.
    const socketPath = ephemeralSocketPath("oversized-id-early-gate");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
    const gateway = new LocalIpcGateway({ registry: new MethodRegistryImpl() });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        const bodyText = JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id: oversizedId,
          method: 42,
          params: {},
        });
        const bodyBytes = Buffer.from(bodyText, "utf8");
        const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
        client.socket.write(Buffer.concat([Buffer.from(header, "ascii"), bodyBytes]));
        const acc = await client.waitForFrames(1);
        const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
        expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
        expect(response.id).toBeNull();
        expect(JSON.stringify(response)).not.toContain(oversizedId);
        expect(client.socket.destroyed).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  it("accepts an id exactly at the bound and echoes it verbatim", async () => {
    // A bound that refused every string id would pass the two tests above. The bound is on the
    // JSON-encoded id, so 254 ASCII characters plus two quotes is exactly 256.
    const atBoundId = "a".repeat(JSON_RPC_ID_MAX_BYTES - 2);
    const socketPath = ephemeralSocketPath("at-bound-id");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
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
        const frame = encodeFrame({
          jsonrpc: JSONRPC_VERSION,
          id: atBoundId,
          method: "x.y",
          protocolVersion: "2026-05-01",
          params: {},
        } as JsonRpcRequest);
        client.socket.write(frame);
        const acc = await client.waitForFrames(1);
        const response = decodeOneFrame(acc) as JsonRpcResponse;
        expect(response.id).toBe(atBoundId);
        expect(response.result).toEqual({ ok: true });
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

// The 1024-byte header cap applies whether or not the CRLFCRLF separator has arrived yet; the
// body cap (`MAX_MESSAGE_BYTES`) does not cover the header.
describe("parseFrame caps the header section", () => {
  it("throws FramingError(`header_too_long`) for a header over 1024 bytes, with or without its terminator", () => {
    // The parser ignores unknown header names, so this padding trips only the byte cap.
    const padding = "a".repeat(2000);
    const buf = Buffer.from(`Content-Length: 5\r\nX-Pad: ${padding}\r\n\r\n12345`, "ascii");
    let caught: unknown = null;
    try {
      parseFrame(buf, MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("header_too_long");
    }

    // 2 KB with no separator yet: the stream looks desynchronized.
    caught = null;
    try {
      parseFrame(Buffer.from("Z".repeat(2000), "ascii"), MAX_MESSAGE_BYTES);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FramingError);
    if (caught instanceof FramingError) {
      expect(caught.code).toBe("header_too_long");
    }
  });
});

// The envelope's `protocolVersion` is only a compile-time type, so the gateway checks it on the
// wire and replies -32600 with `data.type` `transport.invalid_protocol_version` and a
// `data.fields.reason` of `missing`, `wrong_type` (with `observedType`; a JSON null counts here)
// or `invalid_format` (not `YYYY-MM-DD`). `daemon.hello` is exempt. The refusal leaves the
// connection open. A notification gets no reply; the violation goes to the `onError` hook.
describe("envelope-level protocolVersion substrate gate", () => {
  // Built by hand because `encodeFrame` refuses a missing or wrong-typed `protocolVersion`.
  function frameWithProtocolVersion(
    method: string,
    id: number,
    pvJsonLiteral: string | null,
  ): Buffer {
    const pvSegment = pvJsonLiteral === null ? "" : `,"protocolVersion":${pvJsonLiteral}`;
    const bodyText = `{"jsonrpc":"${JSONRPC_VERSION}","id":${id},"method":"${method}"${pvSegment},"params":{}}`;
    const bodyBytes = Buffer.from(bodyText, "utf8");
    const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header, "ascii"), bodyBytes]);
  }

  function frameNotificationWithProtocolVersion(
    method: string,
    pvJsonLiteral: string | null,
  ): Buffer {
    const pvSegment = pvJsonLiteral === null ? "" : `,"protocolVersion":${pvJsonLiteral}`;
    const bodyText = `{"jsonrpc":"${JSONRPC_VERSION}","method":"${method}"${pvSegment},"params":{}}`;
    const bodyBytes = Buffer.from(bodyText, "utf8");
    const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
    return Buffer.concat([Buffer.from(header, "ascii"), bodyBytes]);
  }

  // Registers a spy handler so each case can assert whether it ran.
  function makeRegistry(method = "session.create"): {
    readonly registry: MethodRegistryImpl;
    readonly handlerSpy: ReturnType<typeof vi.fn>;
  } {
    const registry = new MethodRegistryImpl();
    const handlerSpy = vi.fn(async () => ({ ok: true }));
    const handler: Handler<unknown, { ok: boolean }> = handlerSpy;
    registry.register(
      method,
      passthroughSchema<unknown>(),
      passthroughSchema<{ ok: boolean }>(),
      handler,
    );
    return { registry, handlerSpy };
  }

  // Each row is malformed in one way and must produce its own `data.fields.reason`.
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly pvLiteral: string | null;
    readonly expectedReason: "missing" | "wrong_type" | "invalid_format";
    readonly expectedObservedType?: string;
  }> = [
    { label: "missing field", pvLiteral: null, expectedReason: "missing" },
    {
      label: "null value (typeof === 'object')",
      pvLiteral: "null",
      expectedReason: "wrong_type",
      expectedObservedType: "null",
    },
    {
      label: "number value",
      pvLiteral: "42",
      expectedReason: "wrong_type",
      expectedObservedType: "number",
    },
    {
      label: "string but not ISO 8601 date",
      pvLiteral: '"not-a-date"',
      expectedReason: "invalid_format",
    },
    {
      label: "string ISO 8601 date with extra time component",
      pvLiteral: '"2026-05-01T00:00:00Z"',
      expectedReason: "invalid_format",
    },
  ];

  for (const { label, pvLiteral, expectedReason, expectedObservedType } of cases) {
    it(`rejects ${label} with -32600 + transport.invalid_protocol_version (reason=${expectedReason}); handler not invoked`, async () => {
      const socketPath = ephemeralSocketPath(`pv-${expectedReason}`);
      bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
      const { registry, handlerSpy } = makeRegistry("session.create");
      const gateway = new LocalIpcGateway({ registry });
      try {
        await gateway.start();
        const client = await makeClient(socketPath);
        try {
          client.socket.write(frameWithProtocolVersion("session.create", 11, pvLiteral));
          const acc = await client.waitForFrames(1);
          const response = decodeOneFrame(acc) as JsonRpcErrorResponse;
          expect(response.jsonrpc).toBe(JSONRPC_VERSION);
          // The reply keeps the request id so the client can correlate it.
          expect(response.id).toBe(11);
          expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
          const expectedFields: Record<string, unknown> = { reason: expectedReason };
          if (expectedObservedType !== undefined) {
            expectedFields["observedType"] = expectedObservedType;
          }
          expect(response.error.data).toMatchObject({
            type: "transport.invalid_protocol_version",
            fields: expectedFields,
          });
          expect(handlerSpy).not.toHaveBeenCalled();
        } finally {
          await client.close();
        }
      } finally {
        await gateway.stop();
        await fs.rm(socketPath, { force: true });
      }
    });
  }

  it("`daemon.hello` is exempt: missing envelope-level protocolVersion still dispatches", async () => {
    const socketPath = ephemeralSocketPath("pv-exempt");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
    const { registry, handlerSpy } = makeRegistry("daemon.hello");
    const gateway = new LocalIpcGateway({ registry });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        client.socket.write(frameWithProtocolVersion("daemon.hello", 3, null));
        const acc = await client.waitForFrames(1);
        const response = decodeOneFrame(acc) as JsonRpcResponse;
        expect(response.id).toBe(3);
        expect(response.result).toStrictEqual({ ok: true });
        expect(handlerSpy).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  it("connection stays open after gate rejection; subsequent valid request on same socket dispatches", async () => {
    const socketPath = ephemeralSocketPath("pv-stay-open");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
    const { registry, handlerSpy } = makeRegistry("session.create");
    const gateway = new LocalIpcGateway({ registry });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        client.socket.write(frameWithProtocolVersion("session.create", 21, null));
        const firstAcc = await client.waitForFrames(1);
        const firstResponse = decodeOneFrame(firstAcc) as JsonRpcErrorResponse;
        expect(firstResponse.id).toBe(21);
        expect(firstResponse.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
        // A well-formed request on the same socket must still dispatch.
        client.socket.write(frameWithProtocolVersion("session.create", 22, '"2026-05-01"'));
        const secondAcc = await client.waitForFrames(2);
        const r1 = parseFrame(secondAcc, MAX_MESSAGE_BYTES);
        if (r1.frame === null) throw new Error("expected first frame to decode");
        const remaining = secondAcc.subarray(r1.consumed);
        const r2 = parseFrame(remaining, MAX_MESSAGE_BYTES);
        if (r2.frame === null) throw new Error("expected second frame to decode");
        const secondResponse = JSON.parse(r2.frame.toString("utf8")) as JsonRpcResponse;
        expect(secondResponse.id).toBe(22);
        expect(secondResponse.result).toStrictEqual({ ok: true });
        // Only the valid second request reached the handler.
        expect(handlerSpy).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  it("notification with bad protocolVersion is dropped silently; supervision onError fires", async () => {
    const socketPath = ephemeralSocketPath("pv-notif");
    bootstrap({ localIpcPath: socketPath, bannerFormat: "text" });
    const { registry, handlerSpy } = makeRegistry("session.create");
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    const hooks: SupervisionHooks = { onConnect, onDisconnect, onError };
    const gateway = new LocalIpcGateway({ registry, hooks });
    try {
      await gateway.start();
      const client = await makeClient(socketPath);
      try {
        // JSON-RPC 2.0 forbids replying to a notification, so the gateway drops it and reports
        // it through `onError`.
        client.socket.write(frameNotificationWithProtocolVersion("session.create", null));
        // Wait for `onError` first, so the "no reply" check below runs after the gateway has
        // handled the frame.
        for (let i = 0; i < 50 && onError.mock.calls.length === 0; i++) {
          await new Promise((res) => setTimeout(res, 5));
        }
        expect(onError).toHaveBeenCalledTimes(1);
        const errArg = onError.mock.calls[0]?.[1] as unknown;
        expect(errArg).toBeInstanceOf(FramingError);
        if (errArg instanceof FramingError) {
          expect(errArg.code).toBe("invalid_protocol_version");
          expect(errArg.fields).toMatchObject({ reason: "missing" });
        }
        expect(client.received.length).toBe(0);
        expect(handlerSpy).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    } finally {
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});
