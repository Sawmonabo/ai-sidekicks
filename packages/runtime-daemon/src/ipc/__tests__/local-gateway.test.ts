// `LocalIpcGateway` over a real local socket: a malformed envelope never reaches a handler, a
// handler reads the connection's device and never one the request names, and error replies carry
// no paths or stack frames. Sockets live under `os.tmpdir()` with a random suffix so parallel
// workers never collide.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Handler } from "@ai-sidekicks/contracts/jsonrpc/registry";
import type { JsonRpcErrorResponse } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  JSON_RPC_ID_MAX_BYTES,
  JSONRPC_VERSION,
  MAX_MESSAGE_BYTES,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import { encodeFrame } from "@ai-sidekicks/contracts/content-length-framing";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { bootstrap } from "../../bootstrap/index.js";
import { LocalIpcGateway } from "../local-gateway.js";
import { MethodRegistryImpl } from "../registry.js";

import { passthroughSchema } from "../__fixtures__/schema-doubles.js";
import { connect } from "../__fixtures__/local-socket-client.js";

const PROTOCOL_VERSION = "2026-05-01";

// The service's own device id, which every connection on its socket comes from.
const SERVICE_DEVICE_ID = DeviceIdSchema.parse("service-device");

// Linux caps a socket path (`sun_path`) at 107 bytes, so the path stays short.
function ephemeralSocketPath(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), `aisk-test-${label}-${suffix}.sock`);
}

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
    gateway = new LocalIpcGateway({ registry, deviceId: SERVICE_DEVICE_ID });
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

  it("hands the handler the connection's device, not one the request names", async () => {
    const client = await connect(socketPath);
    try {
      client.send({ ...validRequest, params: { deviceId: "spoofed-device" } });
      expect(await client.replies(1)).toEqual([validReply]);
      expect(handlerSpy).toHaveBeenCalledWith(
        { deviceId: "spoofed-device" },
        { transportId: expect.any(Number), deviceId: SERVICE_DEVICE_ID },
      );
    } finally {
      await client.close();
    }
  });

  it("answers an oversized frame, closes only that connection, and keeps listening", async () => {
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
  });

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
});

describe("LocalIpcGateway stop", () => {
  it("sends a reply already written before it closes the connection", async () => {
    // The daemon's stop answers and then stops the gateway on the next turn; a reply large enough
    // to outlast one socket write must still reach the client whole. 256 KiB is many times a local
    // socket's 8 KiB buffer, yet small enough to cross well inside the close wait when the test
    // client shares a loaded event loop.
    const socketPath = ephemeralSocketPath("stop");
    bootstrap({ localIpcPath: socketPath });
    const registry = new MethodRegistryImpl();
    const largeText = "r".repeat(256 * 1024);
    const gateway = new LocalIpcGateway({ registry, deviceId: SERVICE_DEVICE_ID });
    const stopping: Array<Promise<void>> = [];
    const replyThenStop: Handler<unknown, { text: string }> = async () => {
      setImmediate(() => {
        stopping.push(gateway.stop());
      });
      return { text: largeText };
    };
    registry.register(
      "x.stop",
      passthroughSchema<unknown>(),
      passthroughSchema<{ text: string }>(),
      replyThenStop,
    );
    await gateway.start();
    const client = await connect(socketPath);
    try {
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "x.stop",
        protocolVersion: PROTOCOL_VERSION,
        params: {},
      });
      expect(await client.replies(1)).toEqual([
        { jsonrpc: JSONRPC_VERSION, id: 1, result: { text: largeText } },
      ]);
      await Promise.all(stopping);
    } finally {
      await client.close();
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });

  describe("while a connection is slow to close", () => {
    const writeSpy = vi.fn(async () => ({ ok: true }));
    let socketPath: string;
    let gateway: LocalIpcGateway;
    let slowClient: net.Socket;

    beforeEach(async () => {
      writeSpy.mockClear();
      socketPath = ephemeralSocketPath("slow");
      bootstrap({ localIpcPath: socketPath });
      const registry = new MethodRegistryImpl();
      const writeHandler: Handler<unknown, { ok: boolean }> = writeSpy;
      registry.register(
        "x.write",
        passthroughSchema<unknown>(),
        passthroughSchema<{ ok: boolean }>(),
        writeHandler,
        { mutating: true },
      );
      gateway = new LocalIpcGateway({ registry, deviceId: SERVICE_DEVICE_ID });
      await gateway.start();
      // A client that keeps its own side open after the gateway ends the connection, so the stop
      // waits on it.
      slowClient = net.createConnection({ path: socketPath, allowHalfOpen: true });
      await new Promise<void>((resolve, reject) => {
        slowClient.once("connect", resolve);
        slowClient.once("error", reject);
      });
    });

    afterEach(async () => {
      slowClient.destroy();
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    });

    /** Whether `stop` settles before `withinMs`. */
    async function settlesWithin(stop: Promise<void>, withinMs: number): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, withinMs);
      });
      try {
        return await Promise.race([stop.then(() => true as const), deadline]);
      } finally {
        clearTimeout(timer);
      }
    }

    it("finishes even when a client tries to connect during the wait", async () => {
      // A connection accepted during the wait would hold the listener's close open for as long as
      // that client stayed, and the daemon would never finish its stop.
      const stopping = gateway.stop();
      const lateClient = net.createConnection({ path: socketPath, allowHalfOpen: true });
      const lateClientClosed = new Promise<void>((resolve) => {
        lateClient.once("close", () => {
          resolve();
        });
      });
      lateClient.on("error", () => {
        // A refused connect is one of the two outcomes this case accepts.
      });
      try {
        expect(await settlesWithin(stopping, 2_000)).toBe(true);
        await lateClientClosed;
      } finally {
        lateClient.destroy();
      }
    });

    it("runs no request that arrives on a connection the stop has already ended", async () => {
      // Its reply would be dropped, so the client could not tell whether its write landed.
      const stopping = gateway.stop();
      slowClient.write(
        encodeFrame({
          jsonrpc: JSONRPC_VERSION,
          id: 1,
          method: "x.write",
          protocolVersion: PROTOCOL_VERSION,
          params: {},
        }),
      );
      await stopping;
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });
});

describe("LocalIpcGateway outbound queue", () => {
  it("reads full while the client stops reading and signals once it has drained", async () => {
    const socketPath = ephemeralSocketPath("queue");
    bootstrap({ localIpcPath: socketPath });
    const transportIds: number[] = [];
    let disconnected: () => void = () => undefined;
    const disconnect = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const gateway = new LocalIpcGateway({
      registry: new MethodRegistryImpl(),
      deviceId: SERVICE_DEVICE_ID,
      hooks: {
        onConnect: (transport) => {
          transportIds.push(transport.id);
        },
        onDisconnect: () => {
          disconnected();
        },
        onError: () => undefined,
        onListenerError: () => undefined,
      },
    });
    await gateway.start();
    const client = await connect(socketPath);
    try {
      // The gateway sees the connection a turn after the client does.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const [transportId] = transportIds;
      if (transportId === undefined) throw new Error("the gateway saw no connection");
      // Several times what the local socket's kernel buffers hold, so the bytes stay queued in
      // the daemon while the client reads nothing.
      const notificationCount = 4;
      const sendAll = (): void => {
        for (let index = 0; index < notificationCount; index += 1) {
          gateway.notify(transportId, {
            jsonrpc: JSONRPC_VERSION,
            method: "x.value",
            params: { text: "q".repeat(256 * 1024) },
          });
        }
      };
      client.socket.pause();
      sendAll();
      expect(gateway.isFull(transportId)).toBe(true);
      // Waiters past a socket's listener limit share the connection's one drain listener, and a
      // detached one is not called.
      const warnings: string[] = [];
      const recordWarning = (warning: Error): void => {
        warnings.push(warning.name);
      };
      process.on("warning", recordWarning);
      const drained = Array.from({ length: 20 }, () => vi.fn());
      for (const waiter of drained) {
        gateway.onceDrained(transportId, waiter);
      }
      const detached = vi.fn();
      gateway.onceDrained(transportId, detached)();

      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(gateway.isFull(transportId)).toBe(true);
      expect(drained[0]).not.toHaveBeenCalled();

      client.socket.resume();
      await client.replies(notificationCount);
      await vi.waitFor(() => {
        for (const waiter of drained) {
          expect(waiter).toHaveBeenCalledTimes(1);
        }
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.off("warning", recordWarning);
      expect(detached).not.toHaveBeenCalled();
      expect(warnings).not.toContain("MaxListenersExceededWarning");
      expect(gateway.isFull(transportId)).toBe(false);

      // A connection that closes while full reads as not full, so no stream waits on it.
      client.socket.pause();
      sendAll();
      expect(gateway.isFull(transportId)).toBe(true);
      client.socket.destroy();
      await disconnect;
      expect(gateway.isFull(transportId)).toBe(false);
    } finally {
      // A paused client never takes the queued bytes, so an orderly close would never finish.
      client.socket.destroy();
      await gateway.stop();
      await fs.rm(socketPath, { force: true });
    }
  });
});

describe("LocalIpcGateway before SecureDefaults load", () => {
  it("refuses to bind", async () => {
    // A fresh module graph, so the load above is not in force.
    vi.resetModules();
    const { LocalIpcGateway: UnloadedGateway } = await import("../local-gateway.js");
    const { MethodRegistryImpl: UnloadedRegistry } = await import("../registry.js");
    const gateway = new UnloadedGateway({
      registry: new UnloadedRegistry(),
      deviceId: SERVICE_DEVICE_ID,
    });
    await expect(gateway.start()).rejects.toThrow(/must complete before any listener bind/);
  });
});
