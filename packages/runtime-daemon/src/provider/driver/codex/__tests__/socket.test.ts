// The service names the largest message it takes on its socket's upgrade; a limit read wrong
// switches off the size checks on everything the daemon sends, and Codex closes the socket instead.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../../../operating-system/darwin.js";
import { createCodexServiceSocketConnector } from "../transport/socket.js";

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

/** A websocket service on a Unix socket whose upgrade answer carries `headers`. */
async function listeningService(headers: readonly string[]): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "codex-socket-"));
  folders.push(folder);
  const socketPath = path.join(folder, "s");
  const server = createServer();
  servers.push(server);
  const webSockets = new WebSocketServer({ server });
  webSockets.on("headers", (upgradeHeaders) => {
    upgradeHeaders.push(...headers);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe("the Codex service socket", () => {
  it.each([
    { header: "x-codex-websocket-max-unfragmented-message-bytes: 16777216", limit: 16777216 },
    { header: "x-other: 1", limit: undefined },
  ])("reads the size the upgrade names ($header)", async ({ header, limit }) => {
    const socketPath = await listeningService([header]);

    const connect = createCodexServiceSocketConnector(DARWIN_PROVIDER_OPERATING_SYSTEM);
    const socket = await connect(
      socketPath,
      { onMessage: () => undefined, onClose: () => undefined },
      {
        awaitSocket: false,
        codexHome: path.dirname(socketPath),
        codexBuild: {
          requestedCommand: "codex",
          resolvedExecutablePath: "/opt/codex/bin/codex",
          start: { program: "/opt/codex/bin/codex", leadingArguments: [] },
          environment: [],
        },
        signal: new AbortController().signal,
      },
    );
    socket.close();

    expect(socket.sentMessageByteLimit).toBe(limit);
  });
});
