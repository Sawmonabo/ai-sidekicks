// `LocalIpcGateway` and its Content-Length framing over a real local socket: frames are sliced by
// byte count and refused when their length is ambiguous or unbounded, a malformed envelope never
// reaches a handler, and error replies carry no paths or stack frames. Sockets live under
// `os.tmpdir()` with a random suffix so parallel workers never collide.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Handler } from "@ai-sidekicks/contracts/jsonrpc-registry";
import type { JsonRpcErrorResponse, JsonRpcMessage } from "@ai-sidekicks/contracts/jsonrpc";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc";

import { bootstrap } from "../../bootstrap/index.js";
import { FramingError, parseFrame } from "../content-length-framing.js";
import {
  encodeFrame,
  JSON_RPC_ID_MAX_BYTES,
  LocalIpcGateway,
  MAX_MESSAGE_BYTES,
  sanitizeErrorMessage,
  SANITIZED_MESSAGE_MAX_LEN,
} from "../local-ipc-gateway.js";
import { MethodRegistryImpl } from "../registry.js";

import { passthroughSchema } from "../__fixtures__/zod-schemas.js";

const PROTOCOL_VERSION = "2026-05-01";

// Linux caps a socket path (`sun_path`) at 107 bytes, so the path stays short.
function ephemeralSocketPath(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `aisk-test-${label}-${suffix}.sock`);
}

/** Decodes every complete frame at the head of `bytes`. */
function decodeFrames(bytes: Buffer): unknown[] {
  const envelopes: unknown[] = [];
  let rest = bytes;
  for (;;) {
    const result = parseFrame(rest, MAX_MESSAGE_BYTES);
    if (result.frame === null) {
      return envelopes;
    }
    envelopes.push(JSON.parse(result.frame.toString("utf8")));
    rest = rest.subarray(result.consumed);
  }
}

/** The `FramingError` code `parseFrame` throws for `bytes`, or null when it accepts them. */
function framingErrorCode(bytes: string): string | null {
  try {
    parseFrame(Buffer.from(bytes, "ascii"), MAX_MESSAGE_BYTES);
  } catch (error) {
    if (!(error instanceof FramingError)) {
      throw error;
    }
    return error.code;
  }
  return null;
}

interface Client {
  readonly socket: net.Socket;
  /** Sends `value` as one frame, including envelopes the gateway must refuse. */
  readonly send: (value: unknown) => void;
  /** Resolves with every reply so far once `count` have arrived; rejects if the socket closes. */
  readonly replies: (count: number) => Promise<unknown[]>;
  readonly close: () => Promise<void>;
}

async function connect(socketPath: string): Promise<Client> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  const received: Buffer[] = [];
  let isClosed = false;
  let waiter: {
    readonly count: number;
    readonly resolve: (envelopes: unknown[]) => void;
    readonly reject: (reason: unknown) => void;
  } | null = null;
  const settle = (): void => {
    const current = waiter;
    if (current === null) {
      return;
    }
    let envelopes: unknown[];
    try {
      envelopes = decodeFrames(Buffer.concat(received));
    } catch (framingError) {
      waiter = null;
      current.reject(framingError);
      return;
    }
    if (envelopes.length >= current.count) {
      waiter = null;
      current.resolve(envelopes);
    } else if (isClosed) {
      waiter = null;
      current.reject(
        new Error(`socket closed after ${envelopes.length} of ${current.count} replies`),
      );
    }
  };
  socket.on("data", (chunk: Buffer) => {
    received.push(chunk);
    settle();
  });
  socket.on("close", () => {
    isClosed = true;
    settle();
  });
  return {
    socket,
    // `encodeFrame` only serializes, so the cast lets a test send envelopes the gateway refuses.
    send: (value) => {
      socket.write(encodeFrame(value as JsonRpcMessage));
    },
    replies: (count) =>
      new Promise((resolve, reject) => {
        waiter = { count, resolve, reject };
        settle();
      }),
    close: () => {
      if (socket.destroyed) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        socket.once("close", () => {
          resolve();
        });
        socket.end();
      });
    },
  };
}

describe("Content-Length framing", () => {
  it("slices frames by byte count and waits for one that has not fully arrived", () => {
    // "héllo" is 6 bytes in UTF-8 but 5 characters; counting characters would cut the next frame.
    const first = { jsonrpc: JSONRPC_VERSION, id: 1, method: "x.y", params: { message: "héllo" } };
    const second = { jsonrpc: JSONRPC_VERSION, id: 2, method: "x.y", params: {} };
    const firstFrame = encodeFrame(first);
    const secondFrame = encodeFrame(second);
    const stream = Buffer.concat([firstFrame, secondFrame]);

    const head = parseFrame(stream, MAX_MESSAGE_BYTES);
    expect(head.consumed).toBe(firstFrame.byteLength);
    expect(JSON.parse(head.frame!.toString("utf8"))).toStrictEqual(first);

    const waiting = { frame: null, consumed: 0 };
    expect(parseFrame(secondFrame.subarray(0, 10), MAX_MESSAGE_BYTES)).toEqual(waiting);
    expect(parseFrame(secondFrame.subarray(0, -5), MAX_MESSAGE_BYTES)).toEqual(waiting);
    expect(decodeFrames(stream.subarray(head.consumed))).toStrictEqual([second]);
  });

  // A length two parsers could read differently desyncs the stream (request smuggling), and an
  // unterminated header would grow the connection's buffer without bound.
  it.each([
    {
      label: "no Content-Length",
      bytes: "Other-Header: 5\r\n\r\n12345",
      code: "missing_content_length",
    },
    {
      label: "two Content-Length headers",
      bytes: "Content-Length: 5\r\nContent-Length: 6\r\n\r\n123456",
      code: "malformed_content_length",
    },
    {
      label: "an empty length",
      bytes: "Content-Length: \r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a length with trailing letters",
      bytes: "Content-Length: 12junk\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a length in scientific notation",
      bytes: "Content-Length: 12e1\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a hexadecimal length",
      bytes: "Content-Length: 0x12\r\n\r\n",
      code: "malformed_content_length",
    },
    {
      label: "a header section over 1024 bytes",
      bytes: `Content-Length: 5\r\nX-Pad: ${"a".repeat(2000)}\r\n\r\n12345`,
      code: "header_too_long",
    },
    {
      label: "over 1024 header bytes with no terminator yet",
      bytes: "Z".repeat(2000),
      code: "header_too_long",
    },
  ])("refuses a frame with $label", ({ bytes, code }) => {
    expect(framingErrorCode(bytes)).toBe(code);
  });
});

describe("LocalIpcGateway", () => {
  const socketPath = ephemeralSocketPath("gateway");
  const handlerSpy = vi.fn(async () => ({ ok: true }));
  const validRequest = {
    jsonrpc: JSONRPC_VERSION,
    id: 99,
    method: "x.y",
    protocolVersion: PROTOCOL_VERSION,
    params: {},
  };
  const validReply = { jsonrpc: JSONRPC_VERSION, id: 99, result: { ok: true } };
  let gateway: LocalIpcGateway;

  beforeAll(async () => {
    bootstrap({ localIpcPath: socketPath });
    const registry = new MethodRegistryImpl();
    const handler: Handler<unknown, { ok: boolean }> = handlerSpy;
    for (const method of ["x.y", "daemon.hello"]) {
      registry.register(
        method,
        passthroughSchema<unknown>(),
        passthroughSchema<{ ok: boolean }>(),
        handler,
      );
    }
    const failingHandler: Handler<unknown, unknown> = async () => {
      throw new Error("BOOM at /home/secret/path/to/file.ts:42:7");
    };
    registry.register(
      "x.fail",
      passthroughSchema<unknown>(),
      passthroughSchema<unknown>(),
      failingHandler,
    );
    gateway = new LocalIpcGateway({ registry });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.stop();
    await fs.rm(socketPath, { force: true });
  });

  beforeEach(() => {
    handlerSpy.mockClear();
  });

  const oversizedId = "z".repeat(100_000);
  const envelopeRefusal = { id: null, type: "invalid_envelope" };
  const protocolVersionRefusal = { id: 11, type: "transport.invalid_protocol_version" };
  const refusals: Array<{
    readonly label: string;
    readonly envelope: unknown;
    /** The error reply expected, or null for a notification, which gets no reply. */
    readonly reply: { readonly id: number | null; readonly type: string } | null;
  }> = [
    { label: "an object id", envelope: { ...validRequest, id: {} }, reply: envelopeRefusal },
    { label: "an array id", envelope: { ...validRequest, id: [] }, reply: envelopeRefusal },
    { label: "a boolean id", envelope: { ...validRequest, id: true }, reply: envelopeRefusal },
    // Echoing it would make the reply too large to send, and the gateway drops the connection
    // when a reply cannot be encoded.
    {
      label: "an id over the size bound",
      envelope: { ...validRequest, id: oversizedId },
      reply: envelopeRefusal,
    },
    {
      label: "an id over the size bound on a request an earlier check refuses",
      envelope: { ...validRequest, id: oversizedId, method: 42 },
      reply: envelopeRefusal,
    },
    {
      label: "a missing protocolVersion",
      envelope: { jsonrpc: JSONRPC_VERSION, id: 11, method: "x.y", params: {} },
      reply: protocolVersionRefusal,
    },
    {
      label: "a null protocolVersion",
      envelope: { ...validRequest, id: 11, protocolVersion: null },
      reply: protocolVersionRefusal,
    },
    // Coerced to a string, this array reads as a valid date.
    {
      label: "a protocolVersion that is not a string",
      envelope: { ...validRequest, id: 11, protocolVersion: [PROTOCOL_VERSION] },
      reply: protocolVersionRefusal,
    },
    {
      label: "a protocolVersion that is not a date",
      envelope: { ...validRequest, id: 11, protocolVersion: "not-a-date" },
      reply: protocolVersionRefusal,
    },
    {
      label: "a protocolVersion with a time",
      envelope: { ...validRequest, id: 11, protocolVersion: "2026-05-01T00:00:00Z" },
      reply: protocolVersionRefusal,
    },
    {
      label: "a notification without protocolVersion",
      envelope: { jsonrpc: JSONRPC_VERSION, method: "x.y", params: {} },
      reply: null,
    },
  ];

  it.each(refusals)(
    "refuses $label before the handler runs and keeps serving the connection",
    async ({ envelope, reply }) => {
      const client = await connect(socketPath);
      try {
        client.send(envelope);
        client.send(validRequest);
        const errorReplies =
          reply === null
            ? []
            : [
                expect.objectContaining({
                  id: reply.id,
                  error: expect.objectContaining({
                    code: JsonRpcErrorCode.InvalidRequest,
                    data: expect.objectContaining({ type: reply.type }),
                  }),
                }),
              ];
        expect(await client.replies(errorReplies.length + 1)).toEqual([
          ...errorReplies,
          validReply,
        ]);
        expect(handlerSpy).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    {
      label: "an id exactly at the size bound",
      envelope: { ...validRequest, id: "a".repeat(JSON_RPC_ID_MAX_BYTES - 2) },
    },
    {
      label: "daemon.hello, which needs no protocolVersion",
      envelope: { jsonrpc: JSONRPC_VERSION, id: 3, method: "daemon.hello", params: {} },
    },
  ])("dispatches $label", async ({ envelope }) => {
    const client = await connect(socketPath);
    try {
      client.send(envelope);
      expect(await client.replies(1)).toEqual([
        { jsonrpc: JSONRPC_VERSION, id: envelope.id, result: { ok: true } },
      ]);
    } finally {
      await client.close();
    }
  });

  it(
    "answers a frame over the size cap, closes " + "only that connection, and keeps listening",
    async () => {
      const client = await connect(socketPath);
      const closed = new Promise<void>((resolve) => {
        client.socket.once("close", () => {
          resolve();
        });
      });
      // The declared length alone trips the cap, so the body is never sent.
      client.socket.write(`Content-Length: ${MAX_MESSAGE_BYTES + 1}\r\n\r\n`);
      expect(await client.replies(1)).toEqual([
        expect.objectContaining({
          id: null,
          error: expect.objectContaining({
            code: JsonRpcErrorCode.InvalidRequest,
            data: expect.objectContaining({ type: "transport.message_too_large" }),
          }),
        }),
      ]);
      await closed;

      const next = await connect(socketPath);
      try {
        next.send(validRequest);
        expect(await next.replies(1)).toEqual([validReply]);
      } finally {
        await next.close();
      }
    },
  );

  it("replies to a handler failure without its paths or stack frames", async () => {
    const client = await connect(socketPath);
    try {
      client.send({ ...validRequest, id: 9, method: "x.fail" });
      const [reply] = (await client.replies(1)) as JsonRpcErrorResponse[];
      expect(reply?.id).toBe(9);
      expect(reply?.error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(reply?.error.message).toContain("<redacted-path>");
      expect(reply?.error.message).not.toContain("/home/secret");
      expect(reply?.error.message).not.toMatch(/\bat\s+\S+\s+\(/);
    } finally {
      await client.close();
    }
  });

  it("sanitizeErrorMessage never throws and never exceeds its cap", () => {
    // It runs inside the reply path: a throw there would be an unhandled rejection, and an
    // uncapped message could make the reply too large to send.
    const poison = {
      toString(): string {
        throw new Error("toString-poison");
      },
    };
    expect(sanitizeErrorMessage(poison)).toBe("<unprintable thrown value>");
    const huge = sanitizeErrorMessage(new Error("x".repeat(SANITIZED_MESSAGE_MAX_LEN * 2)));
    expect(huge.length).toBeLessThanOrEqual(SANITIZED_MESSAGE_MAX_LEN);
  });
});

describe("LocalIpcGateway before SecureDefaults load", () => {
  it("refuses to bind", async () => {
    // A fresh module graph, so the load above is not in force.
    vi.resetModules();
    const { LocalIpcGateway: UnloadedGateway } = await import("../local-ipc-gateway.js");
    const { MethodRegistryImpl: UnloadedRegistry } = await import("../registry.js");
    const gateway = new UnloadedGateway({ registry: new UnloadedRegistry() });
    await expect(gateway.start()).rejects.toThrow(/must complete before any listener bind/);
  });
});
