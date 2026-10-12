// Real processes on a real socket, with this test's process as the daemon: a command a provider
// ran that read the session token is refused at its hello, its connection staying refused, while
// a client outside the daemon's tree, as the desktop and the command line are, and a program in a
// terminal the daemon opened for the person, are both accepted.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CURRENT_PROTOCOL_VERSION,
  NEGOTIATION_CALLER_REFUSED_CODE,
} from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { HOST_OPERATING_SYSTEM } from "../../../../tests/helpers/host-operating-system.js";
import { bootstrap } from "../../../bootstrap/index.js";
import { LocalIpcGateway } from "../../local-gateway.js";
import { ProtocolNegotiator } from "../../protocol-negotiation.js";
import { MethodRegistryImpl } from "../../registry.js";
import { createStartedByDaemonCheck } from "../descent.js";

const PACKAGE_FOLDER = new URL("../../../../", import.meta.url);
const SOURCE_LOADER = new URL("tests/helpers/typescript-source-loader.mjs", PACKAGE_FOLDER).href;
const SOCKET_CLIENT_URL = new URL("../../__fixtures__/local-socket-client.ts", import.meta.url)
  .href;
const SESSION_TOKEN = "c".repeat(64);
const RESULT_FILE_NAME = "replies.json";

// The client: given the process that started it, it waits until that process has gone, then says
// hello twice with the token it read, and writes both replies to the result file.
const CLIENT_SCRIPT = `
import { renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from ${JSON.stringify(SOCKET_CLIENT_URL)};

const startingParent = process.env.STARTING_PARENT;
while (startingParent !== undefined && process.ppid === Number(startingParent)) {
  await delay(10);
}
const client = await connect(process.env.SOCKET_PATH);
const hello = (id) => ({
  jsonrpc: "2.0",
  id,
  method: "daemon.hello",
  params: { sessionToken: process.env.SESSION_TOKEN, protocolVersion: process.env.PROTOCOL_VERSION },
});
client.send(hello(1));
await client.replies(1);
client.send(hello(2));
// Written aside and renamed, so the test never reads half of it.
writeFileSync(process.env.RESULT_PATH + ".partial", JSON.stringify(await client.replies(2)));
renameSync(process.env.RESULT_PATH + ".partial", process.env.RESULT_PATH);
await client.close();
`;

// How the client's shell starts it: `apart` backgrounds it from the shell, which exits at once
// and names itself as the parent to outlive, so the client is handed to a process outside the
// daemon's tree.
function shellCommand(placement: "inside" | "apart"): string {
  const client = `"${process.execPath}" --conditions=@ai-sidekicks/source --import "${SOURCE_LOADER}" --input-type=module --eval "$CLIENT_SCRIPT"`;
  return placement === "apart" ? `STARTING_PARENT=$$ ${client} &` : `${client}; exit $?`;
}

interface HelloReply {
  readonly result?: { readonly compatible: boolean };
  readonly error?: { readonly data?: { readonly type?: string } };
}

let scratch: string;
let socketPath: string;
let gateway: LocalIpcGateway;
// The processes the stand-in terminal host started for the person's terminals.
const terminalProcessIds = new Set<number>();

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "caller-descent-"));
  socketPath = path.join(scratch, "d.sock");
  bootstrap({ localIpcPath: socketPath });
  const reader = await HOST_OPERATING_SYSTEM.openCallerProcessReader();
  const negotiator = new ProtocolNegotiator(
    SESSION_TOKEN,
    createStartedByDaemonCheck(reader, { readTerminalProcessIds: () => terminalProcessIds }),
  );
  const registry = negotiator.wrap(new MethodRegistryImpl());
  negotiator.registerHandshakeMethod(registry);
  gateway = new LocalIpcGateway({
    registry,
    deviceId: DeviceIdSchema.parse("service-device"),
    readCallerProcessId: (socket) => reader.readConnectedProcessId(socket),
    hooks: {
      onDisconnect: (transport) => {
        negotiator.cleanupTransport(transport.id);
      },
      onError: (_transport, error) => {
        throw error;
      },
      onListenerError: (error) => {
        throw error;
      },
    },
  });
  await gateway.start();
});

afterAll(async () => {
  await gateway.stop();
  await rm(scratch, { recursive: true, force: true });
});

// Runs the client from a shell this process starts, the shell's id counted as a terminal's when
// `isTerminal`, and reads the replies it wrote.
async function runClient(
  placement: "inside" | "apart",
  isTerminal: boolean,
): Promise<readonly HelloReply[]> {
  const resultPath = path.join(scratch, `${placement}-${String(isTerminal)}-${RESULT_FILE_NAME}`);
  const shell = spawn("/bin/sh", ["-c", shellCommand(placement)], {
    cwd: PACKAGE_FOLDER,
    env: {
      ...process.env,
      CLIENT_SCRIPT,
      SOCKET_PATH: socketPath,
      SESSION_TOKEN,
      PROTOCOL_VERSION: CURRENT_PROTOCOL_VERSION,
      RESULT_PATH: resultPath,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (isTerminal && shell.pid !== undefined) {
    terminalProcessIds.add(shell.pid);
  }
  try {
    // The client outside the tree outlives its shell, so the file, not an exit, says it is done.
    for (;;) {
      try {
        return JSON.parse(await readFile(resultPath, "utf8")) as HelloReply[];
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
        await delay(20);
      }
    }
  } finally {
    terminalProcessIds.clear();
  }
}

describe.skipIf(process.platform === "win32")("a connection's caller", () => {
  it("refuses a command a provider ran, though it holds the token, and keeps refusing it", async () => {
    const replies = await runClient("inside", false);

    expect(replies.map((reply) => reply.error?.data?.type)).toStrictEqual([
      NEGOTIATION_CALLER_REFUSED_CODE,
      NEGOTIATION_CALLER_REFUSED_CODE,
    ]);
  });

  it("accepts a client outside the daemon's tree, as the desktop's and the command line's are", async () => {
    const [first] = await runClient("apart", false);

    expect(first?.result?.compatible).toBe(true);
  });

  it("accepts a program in a terminal the daemon opened for the person", async () => {
    const [first] = await runClient("inside", true);

    expect(first?.result?.compatible).toBe(true);
  });
});
