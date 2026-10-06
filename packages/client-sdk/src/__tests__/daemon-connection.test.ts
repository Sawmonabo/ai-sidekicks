// A daemon connection over a real Unix domain socket, against a small framed server standing in
// for the daemon: an unreachable socket fails with the canonical `transport.unavailable` envelope,
// the handshake survives a reply split across reads and presents the session token read at each
// connect, retrying once when a refused token was replaced, a frame that is no JSON-RPC envelope
// ends the connection, a failed handshake closes the socket it opened, and an observer hears every
// frame and the daemon's own close.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { encodeFrame, parseFrame } from "@ai-sidekicks/contracts/content-length-framing";
import {
  resolveDaemonRunFolder,
  type DaemonRunFolder,
} from "@ai-sidekicks/contracts/daemon/run-folder";
import {
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  MAX_MESSAGE_BYTES,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
} from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";

import { connectToDaemon } from "../daemon-connection.js";
import { JsonRpcRemoteError, JsonRpcTransportClosedError } from "../transport/json-rpc.js";
import {
  JsonRpcTransportPeerClosedError,
  JsonRpcTransportUnavailableError,
} from "../transport/local-socket.js";

const COMPATIBLE_HELLO = { compatible: true, protocolVersion: CURRENT_PROTOCOL_VERSION };

let scratch: string;
let runFolder: DaemonRunFolder;
let server: net.Server | undefined;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "aisk-sdk-"));
  runFolder = resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory: scratch,
    temporaryDirectory: os.tmpdir(),
    userId: os.userInfo().uid,
  });
  await mkdir(runFolder.folderPath, { mode: 0o700 });
  await writeFile(runFolder.tokenPath, "first-token", { mode: 0o600 });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.close(() => {
      resolve();
    });
  });
  server = undefined;
  await rm(scratch, { recursive: true, force: true });
});

interface StandInDaemon {
  /** Requests received, in order. */
  readonly requests: JsonRpcRequest[];
  /** Resolves when the client's connection closes. */
  readonly connectionClosed: Promise<void>;
}

/** Serves one connection, answering each request with the bytes `answer` returns for it. */
async function serveStandInDaemon(
  answer: (request: JsonRpcRequest, socket: net.Socket) => void,
): Promise<StandInDaemon> {
  const requests: JsonRpcRequest[] = [];
  let markClosed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  server = net.createServer((socket) => {
    let buffer = new Uint8Array(0);
    socket.on("close", markClosed);
    socket.on("data", (chunk: Buffer) => {
      buffer = new Uint8Array([...buffer, ...chunk]);
      for (;;) {
        const result = parseFrame(buffer, MAX_MESSAGE_BYTES);
        if (result.frame === null) {
          return;
        }
        buffer = buffer.subarray(result.consumed);
        const request = JSON.parse(new TextDecoder().decode(result.frame)) as JsonRpcRequest;
        requests.push(request);
        answer(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(runFolder.socketPath, resolve);
  });
  return { requests, connectionClosed };
}

describe("connectToDaemon", () => {
  it("fails with the transport.unavailable envelope when no daemon listens", async () => {
    // A machine where no daemon has started yet has no token file either.
    await rm(runFolder.tokenPath);
    const failure = await connectToDaemon({
      runFolder,
      maxQueuedValuesPerSubscription: 8,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JsonRpcTransportUnavailableError);
    expect(failure).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { type: "transport.unavailable", fields: { reason: "ENOENT" } },
    });
  });

  it("rejects with the read's ENOENT and closes, observed, before the daemon writes its token", async () => {
    // The daemon has bound its socket and not yet written this start's token.
    await rm(runFolder.tokenPath);
    const daemon = await serveStandInDaemon(() => undefined);
    const closeReasons: Array<Error | undefined> = [];

    const failure = await connectToDaemon({
      runFolder,
      maxQueuedValuesPerSubscription: 8,
      observer: {
        frameReceived: () => undefined,
        closed: (reason) => {
          closeReasons.push(reason);
        },
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "ENOENT" });
    expect(closeReasons).toStrictEqual([undefined]);
    await daemon.connectionClosed;
    expect(daemon.requests).toHaveLength(0);
  });

  it("completes daemon.hello when the reply arrives split across reads", async () => {
    const daemon = await serveStandInDaemon((request, socket) => {
      const frame = encodeFrame({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: COMPATIBLE_HELLO,
      });
      // The header and body arrive in separate reads.
      socket.write(frame.subarray(0, 10));
      setTimeout(() => {
        socket.write(frame.subarray(10));
      }, 20);
    });

    const connection = await connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 });

    expect(connection.hello).toStrictEqual(COMPATIBLE_HELLO);
    expect(daemon.requests).toMatchObject([
      {
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          supportedProtocols: SUPPORTED_PROTOCOL_VERSIONS,
          sessionToken: "first-token",
        },
      },
    ]);
    await connection.close();
  });

  it("reads the session token at every connect, so a restarted daemon's token is presented", async () => {
    const daemon = await serveStandInDaemon((request, socket) => {
      socket.write(
        encodeFrame({ jsonrpc: JSONRPC_VERSION, id: request.id, result: COMPATIBLE_HELLO }),
      );
    });

    await (await connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 })).close();
    // The daemon restarted and wrote a new token.
    await writeFile(runFolder.tokenPath, "second-token");
    await (await connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 })).close();

    expect(daemon.requests.map((request) => request.params)).toMatchObject([
      { sessionToken: "first-token" },
      { sessionToken: "second-token" },
    ]);
  });

  it("ends the connection on a frame that is no JSON-RPC envelope", async () => {
    // A reply carrying neither `result` nor `error`.
    await serveStandInDaemon((request, socket) => {
      socket.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, id: request.id } as never));
    });

    const failure = await connectToDaemon({
      runFolder,
      maxQueuedValuesPerSubscription: 8,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JsonRpcTransportClosedError);
    expect((failure as Error).cause).toMatchObject({ name: "ZodError" });
  });

  it("closes the socket when the handshake fails", async () => {
    const daemon = await serveStandInDaemon((request, socket) => {
      socket.write(
        encodeFrame({
          jsonrpc: JSONRPC_VERSION,
          id: request.id,
          error: { code: JsonRpcErrorCode.InternalError, message: "the daemon failed" },
        }),
      );
    });

    await expect(
      connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 }),
    ).rejects.toBeInstanceOf(JsonRpcRemoteError);
    await daemon.connectionClosed;
  });

  it("connects once more with the new token when the refused one was replaced", async () => {
    // The daemon writes its token just after it binds: the first hello presents the previous
    // start's token, which the file has replaced by the time the refusal arrives.
    const daemon = await serveStandInDaemon((request, socket) => {
      const params = request.params as { sessionToken: string };
      if (params.sessionToken === "second-token") {
        socket.write(
          encodeFrame({ jsonrpc: JSONRPC_VERSION, id: request.id, result: COMPATIBLE_HELLO }),
        );
        return;
      }
      void writeFile(runFolder.tokenPath, "second-token").then(() => {
        socket.write(encodeFrame(tokenRefusal(request)));
      });
    });

    const connection = await connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 });

    expect(connection.hello).toStrictEqual(COMPATIBLE_HELLO);
    expect(daemon.requests.map((request) => request.params)).toMatchObject([
      { sessionToken: "first-token" },
      { sessionToken: "second-token" },
    ]);
    await connection.close();
  });

  it("tells its observer of every frame and of the daemon closing the connection", async () => {
    let connectionSocket: net.Socket | undefined;
    await serveStandInDaemon((request, socket) => {
      connectionSocket = socket;
      socket.write(
        encodeFrame({ jsonrpc: JSONRPC_VERSION, id: request.id, result: COMPATIBLE_HELLO }),
      );
      if (request.method === "daemon.ping") {
        // A notification the client routes nowhere still counts as traffic.
        socket.write(encodeFrame({ jsonrpc: JSONRPC_VERSION, method: "$/unrouted", params: {} }));
      }
    });
    const seen: string[] = [];
    let closedWith: (reason: Error | undefined) => void = () => undefined;
    const closed = new Promise<Error | undefined>((resolve) => {
      closedWith = resolve;
    });

    const connection = await connectToDaemon({
      runFolder,
      maxQueuedValuesPerSubscription: 8,
      observer: {
        frameReceived: () => {
          seen.push("frame");
        },
        closed: (reason) => {
          closedWith(reason);
        },
      },
    });
    await connection.client.call("daemon.ping", {}, z.object({}), z.unknown());
    await vi.waitFor(() => {
      expect(seen).toStrictEqual(["frame", "frame", "frame"]);
    });
    connectionSocket?.destroy();

    expect(await closed).toBeInstanceOf(JsonRpcTransportPeerClosedError);
  });

  it("throws the refusal when the token file still holds the refused token", async () => {
    const daemon = await serveStandInDaemon((request, socket) => {
      socket.write(encodeFrame(tokenRefusal(request)));
    });

    await expect(
      connectToDaemon({ runFolder, maxQueuedValuesPerSubscription: 8 }),
    ).rejects.toMatchObject({ data: { type: "auth.token_invalid" } });
    expect(daemon.requests).toHaveLength(1);
  });
});

// The daemon's answer to a hello without its current session token.
function tokenRefusal(request: JsonRpcRequest): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: request.id,
    error: {
      code: JsonRpcErrorCode.InvalidRequest,
      message: "the session token was refused",
      data: { type: "auth.token_invalid" },
    },
  };
}
