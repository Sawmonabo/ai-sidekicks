// The service names the largest message it takes on its socket's upgrade; a limit read wrong
// switches off the size checks on everything the daemon sends, and Codex closes the socket instead.
// The process serving the socket is held while it is open, or a command an agent ran on the
// person's own service would pass the daemon's caller check. A dial its signal already ended opens
// no connection to leak.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { HOST_OPERATING_SYSTEM } from "../../../../../tests/helpers/host-operating-system.js";
import { captureRejection } from "../../../../__fixtures__/capture-failure.js";
import { ProviderServiceProcesses } from "../../../../ipc/caller-process/provider-services.js";
import { MAC_PROVIDER_OPERATING_SYSTEM } from "../../../operating-system/mac.js";
import {
  createCodexServiceSocketConnector,
  type CodexServiceSocket,
  type CodexServiceSocketHandlers,
} from "../transport/socket.js";

const servers: Server[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * A websocket service on a Unix socket whose upgrade answer carries `headers`, and the connections
 * it has taken so far.
 */
async function listeningService(
  headers: readonly string[],
): Promise<{ readonly socketPath: string; readonly connections: readonly unknown[] }> {
  const folder = await mkdtemp(path.join(tmpdir(), "codex-socket-"));
  folders.push(folder);
  const socketPath = path.join(folder, "s");
  const server = createServer();
  servers.push(server);
  const webSockets = new WebSocketServer({ server });
  webSockets.on("headers", (upgradeHeaders) => {
    upgradeHeaders.push(...headers);
  });
  const connections: unknown[] = [];
  server.on("connection", (connection) => {
    connections.push(connection);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, connections };
}

let providerServices: ProviderServiceProcesses;

beforeAll(async () => {
  providerServices = new ProviderServiceProcesses(
    await HOST_OPERATING_SYSTEM.openCallerProcessReader(),
  );
});

/** Dials the service at `socketPath` as the daemon does, directly on the Unix socket. */
async function dial(
  socketPath: string,
  handlers: CodexServiceSocketHandlers,
  signal: AbortSignal = new AbortController().signal,
): Promise<CodexServiceSocket> {
  const connect = createCodexServiceSocketConnector(
    MAC_PROVIDER_OPERATING_SYSTEM,
    providerServices,
  );
  return await connect(socketPath, handlers, {
    awaitSocket: false,
    codexHome: path.dirname(socketPath),
    codexBuild: {
      requestedCommand: "codex",
      resolvedExecutablePath: "/opt/codex/bin/codex",
      start: { program: "/opt/codex/bin/codex", leadingArguments: [] },
      environment: [],
    },
    signal,
  });
}

describe("the Codex service socket", () => {
  it.each([
    { header: "x-codex-websocket-max-unfragmented-message-bytes: 16777216", limit: 16777216 },
    { header: "x-other: 1", limit: undefined },
  ])("reads the size the upgrade names ($header)", async ({ header, limit }) => {
    const { socketPath } = await listeningService([header]);

    const socket = await dial(socketPath, {
      onMessage: () => undefined,
      onClose: () => undefined,
    });
    socket.close();

    expect(socket.sentMessageByteLimit).toBe(limit);
  });

  it("holds the process serving the socket until the socket closes", async () => {
    // The service listens in this process, so this process serves it.
    const { socketPath } = await listeningService([]);
    let reportClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      reportClosed = resolve;
    });

    const socket = await dial(socketPath, { onMessage: () => undefined, onClose: reportClosed });
    const isHeldWhileOpen = providerServices.has(process.pid);
    socket.close();
    await closed;

    expect(isHeldWhileOpen).toBe(true);
    expect(providerServices.has(process.pid)).toBe(false);
  });

  it("opens no connection for a dial whose signal has already ended", async () => {
    const { socketPath, connections } = await listeningService([]);
    const ended = new AbortController();
    ended.abort(new Error("the dial was ended"));
    const handlers = { onMessage: () => undefined, onClose: () => undefined };

    const failure = await captureRejection(dial(socketPath, handlers, ended.signal));
    // The service takes connections in the order they were made, so one leaked by the ended dial
    // would be counted before this one.
    const socket = await dial(socketPath, handlers);
    socket.close();

    expect(failure).toBe(ended.signal.reason);
    expect(connections).toHaveLength(1);
  });
});
