// The daemon's start and stop in this process: a stop closes the socket before it drains the
// terminals, and still closes the database when a step before it fails; a start refuses a data
// folder another daemon holds, a socket another daemon answers on, a run folder other accounts can
// reach, and, before the bind, a socket path longer than the platform binds, while a path at that
// limit binds and answers a hello; of two starts racing, the token file holds the winner's token.
// Over the socket, the status read reports the running service and its process, a flush leaves
// it running, a stop or restart ends it with another client still connected, and a connection
// whose handshake was incompatible cannot stop it. The machine's settings file is read and written
// over the socket: one client's change reaches the file and another client's subscription, a
// refused change writes nothing, and a closed connection's subscription lets go of the file. A stop
// leaves every write it answered on disk, and ends within its drain bound while a write hangs.

import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon-data";
import {
  DAEMON_STOP_DRAIN_BOUND_MS,
  DAEMON_STOP_TERMINAL_DRAIN_MS,
  DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
} from "@ai-sidekicks/contracts/daemon-lifecycle";
import {
  resolveDaemonRunFolder,
  type DaemonRunFolder,
} from "@ai-sidekicks/contracts/daemon-run-folder";

import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc-negotiation";

import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon-status";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";
import {
  MACHINE_SETTINGS_DEFAULTS,
  MACHINE_SETTINGS_FILE_PATH_SEGMENTS,
} from "@ai-sidekicks/contracts/machine-settings";

import { SecureDefaultsValidationError } from "../../bootstrap/secure-defaults.js";
import { connect, type Client } from "../../ipc/__tests__/local-socket-client.test-support.js";
import { readSocketPathLimit } from "../../ipc/socket-path-limit.js";
import type { DrainResult, PtyHost } from "../../pty/pty-host.js";
import { DaemonAlreadyRunningError } from "../daemon-already-running-error.js";
import { DaemonProcess, type DaemonProcessOptions } from "../daemon-process.js";
import { MachineSettingsFile } from "../machine-settings/machine-settings-file.js";
import { readProcessTreeUsage } from "../process-tree-usage.js";

const EMPTY_DRAIN: DrainResult = {
  sessionsDrained: 0,
  sessionsForcedKilled: 0,
  sidecarExitedCleanly: true,
  taskkillEscalated: false,
};

let scratch: string;
let homeDirectory: string;
let runFolder: DaemonRunFolder;
const started: DaemonProcess[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "aisk-"));
  homeDirectory = path.join(scratch, "home");
  const runtimeDirectory = path.join(scratch, "run");
  await mkdir(homeDirectory);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  runFolder = resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory,
    temporaryDirectory: os.tmpdir(),
    userId: os.userInfo().uid,
  });
});

afterEach(async () => {
  for (const daemon of started.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  await rm(scratch, { recursive: true, force: true });
});

const STARTED_AT = "2026-10-04T12:00:00.000Z";
const SERVICE_VERSION = "1.4.0";
const PROCESS_IDENTITY: ProcessIdentity = {
  processId: process.pid,
  bootId: "boot-1",
  processStartTime: "Sun Oct  4 12:00:00 2026",
};

async function startDaemon(
  ptyHost: Pick<PtyHost, "shutdown">,
  place: Partial<Pick<DaemonProcessOptions, "homeDirectory" | "runFolder">> = {},
  start: (options: DaemonProcessOptions) => Promise<DaemonProcess> = (options) =>
    DaemonProcess.start(options),
): Promise<DaemonProcess> {
  const options: DaemonProcessOptions = {
    homeDirectory: place.homeDirectory ?? homeDirectory,
    runFolder: place.runFolder ?? runFolder,
    ptyHost,
    readMachineName: () => Promise.resolve("Test machine"),
    captureProviderBaseEnvironment: () => Promise.resolve([]),
    serviceVersion: SERVICE_VERSION,
    processIdentity: PROCESS_IDENTITY,
    readProcessTreeUsage: () => readProcessTreeUsage(process.pid),
    now: () => new Date(STARTED_AT),
    writeServiceLog: () => {},
  };
  const daemon = await start(options);
  started.push(daemon);
  return daemon;
}

function isSocketAnswering(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => {
      probe.destroy();
      resolve(false);
    });
  });
}

const writeAheadLogPath = (): string =>
  path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "daemon.db-wal");

describe("DaemonProcess.stop", () => {
  it("closes the socket, then drains every terminal, then closes the database", async () => {
    const drains: { options: unknown; wasSocketAnswering: boolean }[] = [];
    const daemon = await startDaemon({
      shutdown: async (options) => {
        drains.push({
          options,
          wasSocketAnswering: await isSocketAnswering(runFolder.socketPath),
        });
        return EMPTY_DRAIN;
      },
    });
    await access(writeAheadLogPath());

    await daemon.stop();

    expect(drains).toStrictEqual([
      {
        options: {
          perSessionTimeoutMs: DAEMON_STOP_TERMINAL_DRAIN_MS,
          hostTimeoutMs: DAEMON_STOP_TERMINAL_HOST_DRAIN_MS,
        },
        wasSocketAnswering: false,
      },
    ]);
    // The last connection's close checkpoints the log into the database and removes it.
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still closes the database when the terminal drain fails, and throws that failure", async () => {
    const drainFailure = new Error("the terminal host did not end");
    const daemon = await startDaemon({ shutdown: () => Promise.reject(drainFailure) });

    await expect(daemon.stop()).rejects.toBe(drainFailure);
    await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("DaemonProcess.start", () => {
  it("refuses a data folder another daemon holds, before it binds a socket of its own", async () => {
    await startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) });
    const otherRuntimeDirectory = path.join(scratch, "other-run");
    await mkdir(otherRuntimeDirectory, { mode: 0o700 });
    const otherRunFolder = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory: otherRuntimeDirectory,
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });

    const failure = await startDaemon(
      { shutdown: () => Promise.resolve(EMPTY_DRAIN) },
      { runFolder: otherRunFolder },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(failure).toMatchObject({
      message: `Another daemon already holds the data folder ${path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME)}`,
    });
    await expect(lstat(otherRunFolder.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
  });

  it("refuses a socket another daemon answers on, and leaves that daemon serving", async () => {
    await startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) });
    const otherHomeDirectory = path.join(scratch, "other-home");
    await mkdir(otherHomeDirectory);

    await expect(
      startDaemon(
        { shutdown: () => Promise.resolve(EMPTY_DRAIN) },
        { homeDirectory: otherHomeDirectory },
      ),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
  });

  it("refuses a run folder other accounts can reach", async () => {
    await mkdir(runFolder.folderPath, { mode: 0o700 });
    await chmod(runFolder.folderPath, 0o755);

    await expect(startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) })).rejects.toThrow(
      "it must be 700",
    );
  });
});

describe("the socket path's length", () => {
  // A run folder whose socket path is exactly `socketPathBytes` long.
  async function useRunFolderWithSocketPathOf(socketPathBytes: number): Promise<void> {
    const shortest = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory: path.join(scratch, "r"),
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });
    const padding = socketPathBytes - Buffer.byteLength(shortest.socketPath, "utf8");
    const runtimeDirectory = path.join(scratch, "r".repeat(1 + padding));
    await mkdir(runtimeDirectory, { mode: 0o700 });
    runFolder = resolveDaemonRunFolder({
      platform: process.platform,
      runtimeDirectory,
      temporaryDirectory: os.tmpdir(),
      userId: os.userInfo().uid,
    });
    expect(Buffer.byteLength(runFolder.socketPath, "utf8")).toBe(socketPathBytes);
  }

  it.skipIf(process.platform === "win32")(
    "binds a path at the platform's own limit and answers a hello there",
    async () => {
      await useRunFolderWithSocketPathOf(await readSocketPathLimit());
      await startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) });

      const client = await connect(runFolder.socketPath);
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken: await readFile(runFolder.tokenPath, "utf8"),
        },
      });
      expect(await client.replies(1)).toMatchObject([{ id: 1, result: { compatible: true } }]);
      await client.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a path one byte over the limit before the bind, naming the limit and the length",
    async () => {
      const limit = await readSocketPathLimit();
      await useRunFolderWithSocketPathOf(limit + 1);

      const failure = await startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(SecureDefaultsValidationError);
      expect(failure).toMatchObject({
        code: "invalid_local_ipc_path",
        message: expect.stringContaining(
          `is ${String(limit + 1)} bytes and the limit is ${String(limit)}`,
        ),
      });
      await expect(lstat(runFolder.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      // The platform's own bind refuses that path too, so the limit is the platform's.
      await expect(
        new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once("error", reject);
          server.listen(runFolder.socketPath, () => {
            server.close(resolve);
          });
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    },
  );
});

describe("the socket path's limit under a long TMPDIR", () => {
  it.skipIf(process.platform === "win32")(
    "measures the same limit, and a daemon starts, when TMPDIR alone is longer than the limit",
    async () => {
      const limit = await readSocketPathLimit();
      const temporaryDirectory = process.env["TMPDIR"];
      process.env["TMPDIR"] = path.join(scratch, "t".repeat(limit));
      try {
        // A fresh module graph, so neither the measurement nor the daemon reuses one taken earlier.
        vi.resetModules();
        const freshLimit = await import("../../ipc/socket-path-limit.js");
        expect(await freshLimit.readSocketPathLimit()).toBe(limit);
        const fresh = await import("../daemon-process.js");
        await startDaemon({ shutdown: () => Promise.resolve(EMPTY_DRAIN) }, {}, (options) =>
          fresh.DaemonProcess.start(options),
        );
        expect(await isSocketAnswering(runFolder.socketPath)).toBe(true);
      } finally {
        if (temporaryDirectory === undefined) {
          delete process.env["TMPDIR"];
        } else {
          process.env["TMPDIR"] = temporaryDirectory;
        }
      }
    },
  );
});

describe("two starts racing for the socket", () => {
  it("leave the token file holding the token of the daemon that owns the socket", async () => {
    const drain = { shutdown: () => Promise.resolve(EMPTY_DRAIN) };
    // Each round starts over the previous round's token file, as a restart does.
    for (let round = 0; round < 5; round += 1) {
      const outcomes = await Promise.allSettled([startDaemon(drain), startDaemon(drain)]);
      const winners = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      expect(winners).toHaveLength(1);

      const client = await connect(runFolder.socketPath);
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken: await readFile(runFolder.tokenPath, "utf8"),
        },
      });
      expect(await client.replies(1)).toMatchObject([{ id: 1, result: { compatible: true } }]);
      await client.close();

      await winners[0]!.stop();
      started.splice(started.indexOf(winners[0]!), 1);
    }
  });
});

// A connection whose handshake has completed, offering `helloProtocolVersion`; `call` sends one
// request and resolves with its reply.
async function openSession(helloProtocolVersion: string = CURRENT_PROTOCOL_VERSION): Promise<{
  client: Client;
  call: (method: string, params?: unknown) => Promise<unknown>;
}> {
  const client = await connect(runFolder.socketPath);
  let nextId = 1;
  const call = async (method: string, params: unknown = {}): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    client.send({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
      ...(method === "daemon.hello" ? {} : { protocolVersion: CURRENT_PROTOCOL_VERSION }),
    });
    const replies = await client.replies(id);
    return replies.find((reply) => (reply as { id: unknown }).id === id);
  };
  await call("daemon.hello", {
    protocolVersion: helloProtocolVersion,
    sessionToken: await readFile(runFolder.tokenPath, "utf8"),
  });
  return { client, call };
}

function whenClosed(client: Client): Promise<void> {
  return new Promise((resolve) => {
    if (client.socket.closed) {
      resolve();
    } else {
      client.socket.once("close", () => {
        resolve();
      });
    }
  });
}

describe("the lifecycle verbs over the socket", () => {
  const drainNothing = { shutdown: () => Promise.resolve(EMPTY_DRAIN) };

  it("the status read reports the running service, its socket, data folder and processes", async () => {
    await startDaemon(drainNothing);
    const { client, call } = await openSession();

    const reply = await call("daemon.status.read");

    expect(reply).toMatchObject({
      result: {
        processState: "running",
        processIdentity: PROCESS_IDENTITY,
        version: SERVICE_VERSION,
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        transportEndpoint: runFolder.socketPath,
        dataDirectory: path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME),
        startedAt: STARTED_AT,
        uptimeMs: 0,
        processor: { readAt: STARTED_AT },
        memory: { readAt: STARTED_AT },
      },
    });
    const { result } = reply as { result: DaemonStatusReadResponse };
    expect(result.memory?.residentBytes).toBeGreaterThan(0);
    await client.close();
  });

  it("a flush answers flushed and leaves the service, its terminals and its database running", async () => {
    const drains: unknown[] = [];
    await startDaemon({
      shutdown: (options) => {
        drains.push(options);
        return Promise.resolve(EMPTY_DRAIN);
      },
    });
    const { client, call } = await openSession();

    expect(await call("daemon.flush")).toMatchObject({ result: { flushed: true } });

    expect(await call("daemon.status.read")).toMatchObject({ result: { processState: "running" } });
    expect(drains).toStrictEqual([]);
    await access(writeAheadLogPath());
    await client.close();
  });

  it.each(["daemon.stop", "daemon.restart"])(
    "%s answers accepted with another client connected, ends the daemon and frees its data folder",
    async (method) => {
      const drains: unknown[] = [];
      const daemon = await startDaemon({
        shutdown: (options) => {
          drains.push(options);
          return Promise.resolve(EMPTY_DRAIN);
        },
      });
      const caller = await openSession();
      const bystander = await openSession();

      expect(await caller.call(method)).toMatchObject({ result: { accepted: true } });

      expect(await daemon.whenStopped()).toStrictEqual({ isClean: true });
      await whenClosed(bystander.client);
      expect(drains).toHaveLength(1);
      expect(await isSocketAnswering(runFolder.socketPath)).toBe(false);
      await expect(access(writeAheadLogPath())).rejects.toMatchObject({ code: "ENOENT" });
      // The data folder is free again, so the next start takes it.
      await startDaemon(drainNothing);
    },
  );

  it("refuses every mutating verb on a connection whose handshake was incompatible", async () => {
    await startDaemon(drainNothing);
    const { client, call } = await openSession("2999-12-31");

    for (const method of ["daemon.stop", "daemon.restart", "daemon.flush"]) {
      expect(await call(method)).toMatchObject({
        error: { data: { type: "protocol.version_mismatch" } },
      });
    }
    expect(await call("daemon.status.read")).toMatchObject({ result: { processState: "running" } });
    await client.close();
  });
});

/** Resolves with the `$/subscription/notify` frames `client` has received, once it has `count`. */
async function notifications(client: Client, count: number): Promise<unknown[]> {
  for (let received = count; ; received += 1) {
    const frames = (await client.replies(received)).filter(
      (frame) => (frame as { method?: unknown }).method === "$/subscription/notify",
    );
    if (frames.length >= count) {
      return frames;
    }
  }
}

describe("the machine's settings over the socket", () => {
  const drainNothing = { shutdown: () => Promise.resolve(EMPTY_DRAIN) };
  const settingsPath = (): string =>
    path.join(homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);

  it("reads the defaults, and one client's change reaches the file and another's subscription", async () => {
    await startDaemon(drainNothing);
    const listener = await openSession();
    const writer = await openSession();

    expect(await writer.call("daemon.machineSettingsRead")).toMatchObject({
      result: { settings: MACHINE_SETTINGS_DEFAULTS },
    });
    const acknowledged = (await listener.call("daemon.machineSettingsSubscribe")) as {
      result: { subscriptionId: string };
    };
    expect(
      await writer.call("daemon.machineSettingsUpdate", { change: { screenReaderMode: true } }),
    ).toMatchObject({ result: { settings: { screenReaderMode: true } } });

    const changed = { ...MACHINE_SETTINGS_DEFAULTS, screenReaderMode: true };
    expect(await notifications(listener.client, 2)).toStrictEqual([
      {
        jsonrpc: JSONRPC_VERSION,
        method: "$/subscription/notify",
        params: {
          subscriptionId: acknowledged.result.subscriptionId,
          value: { settings: MACHINE_SETTINGS_DEFAULTS },
        },
      },
      {
        jsonrpc: JSONRPC_VERSION,
        method: "$/subscription/notify",
        params: {
          subscriptionId: acknowledged.result.subscriptionId,
          value: { settings: changed },
        },
      },
    ]);
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toStrictEqual(changed);
    await listener.client.close();
    await writer.client.close();
  });

  it("refuses a credential-shaped row and a pattern git refuses, writing nothing", async () => {
    await startDaemon(drainNothing);
    const { client, call } = await openSession();

    expect(
      await call("daemon.machineSettingsUpdate", {
        change: { environmentRows: [{ name: "OPENAI_API_KEY", value: "sk-x" }] },
      }),
    ).toMatchObject({
      error: {
        message:
          "Credentials are not set here. Sign in to a provider on Providers, or add a workflow " +
          "step's token in its Credential field.",
        data: {
          type: "daemon.environment_name_refused",
          fields: { name: "OPENAI_API_KEY", reason: "credential_shaped" },
        },
      },
    });
    expect(
      await call("daemon.machineSettingsUpdate", { change: { branchNamePattern: "a b/{title}" } }),
    ).toMatchObject({
      error: {
        message: "Git does not accept this as a branch name.",
        data: { type: "daemon.branch_pattern_refused", fields: { reason: "not_a_branch_name" } },
      },
    });
    await expect(access(settingsPath())).rejects.toMatchObject({ code: "ENOENT" });
    await client.close();
  });

  it("a stop with another client connected leaves every write the daemon answered on disk", async () => {
    const daemon = await startDaemon(drainNothing);
    const writer = await openSession();
    const stopper = await openSession();

    expect(
      await writer.call("daemon.machineSettingsUpdate", { change: { screenReaderMode: true } }),
    ).toMatchObject({ result: { settings: { screenReaderMode: true } } });
    expect(await stopper.call("daemon.stop")).toMatchObject({ result: { accepted: true } });

    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toStrictEqual({
      ...MACHINE_SETTINGS_DEFAULTS,
      screenReaderMode: true,
    });
  });

  it("a stop ends within its drain bound while a write never finishes", async () => {
    // The settings file is a named pipe with no writer, so a settings write that reads it waits.
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    execFileSync("mkfifo", [settingsPath()]);
    const logged: string[] = [];
    const daemon = await startDaemon(drainNothing, {}, (options) =>
      DaemonProcess.start({ ...options, writeServiceLog: (line) => logged.push(line) }),
    );
    const writer = await openSession();
    const stopper = await openSession();
    writer.client.send({
      jsonrpc: JSONRPC_VERSION,
      id: 50,
      method: "daemon.machineSettingsUpdate",
      params: { change: { screenReaderMode: true } },
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
    // The write is under way once its read has opened the pipe.
    await vi.waitFor(async () => {
      const pipe = await open(settingsPath(), fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      onTestFinished(() => pipe.close());
    });

    const askedAt = Date.now();
    expect(await stopper.call("daemon.stop")).toMatchObject({ result: { accepted: true } });
    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true });

    expect(Date.now() - askedAt).toBeLessThan(DAEMON_STOP_DRAIN_BOUND_MS + 1_000);
    expect(logged).toContain("The stop's drain bound passed; writes still running: 1.");
  }, 10_000);

  it("lets go of the file when a subscribed connection closes", async () => {
    const detached = vi.fn<() => void>();
    const subscribeToFile = MachineSettingsFile.prototype.subscribe;
    const spy = vi
      .spyOn(MachineSettingsFile.prototype, "subscribe")
      .mockImplementation(async function (this: MachineSettingsFile, listener) {
        const unsubscribe = await subscribeToFile.call(this, listener);
        return () => {
          detached();
          unsubscribe();
        };
      });
    onTestFinished(() => {
      spy.mockRestore();
    });
    await startDaemon(drainNothing);
    const { client, call } = await openSession();
    await call("daemon.machineSettingsSubscribe");
    await notifications(client, 1);

    await client.close();

    await vi.waitFor(() => {
      expect(detached).toHaveBeenCalledOnce();
    });
  });
});
