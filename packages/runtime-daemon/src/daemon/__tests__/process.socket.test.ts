// The running daemon over its socket, in this process: the status read reports the running
// service and its process, and reads degraded once the listener fails or the search thread cannot
// open, which fails each search; `daemon.start` is a method it does not have; a flush leaves it
// running and answers only once the writes queued before it have committed, a stop or restart
// ends it with another client still connected, and a connection whose handshake was incompatible
// cannot stop it. The machine's settings file is read and written over the socket: one client's
// change reaches the file and another client's subscription, and a closed connection's
// subscription lets go of the file. A stop waits for a write under way and leaves it on disk, and
// ends within its drain bound while a write hangs.

import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import * as path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import { DAEMON_STOP_DRAIN_BOUND_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { DaemonStatusReadResponse } from "@ai-sidekicks/contracts/daemon/status";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import {
  MACHINE_SETTINGS_DEFAULTS,
  MACHINE_SETTINGS_FILE_PATH_SEGMENTS,
} from "@ai-sidekicks/contracts/machine-settings";

import { DatabaseWriter } from "../../database/writer.js";
import type { Client } from "../../ipc/__fixtures__/local-socket-client.js";
import { MachineSettingsFile } from "../machine/settings/file.js";
import { DaemonProcess } from "../process.js";
import {
  DRAIN_NOTHING,
  EMPTY_DRAIN,
  homeDirectory,
  isSocketAnswering,
  openSession,
  PROCESS_IDENTITY,
  runFolder,
  scratch,
  SERVICE_VERSION,
  STARTED_AT,
  startDaemon,
  startSearchThread,
  useDaemonFolders,
  useSearchThreads,
  whenClosed,
  writeAheadLogPath,
} from "./process.test-support.js";

// Every server this file's daemons create, so a test can fail the daemon's own listener the way
// the operating system would, with an `error` event on the listening server.
const createdServers = vi.hoisted((): import("node:net").Server[] => []);
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

useDaemonFolders();

describe("the lifecycle verbs over the socket", () => {
  it("the status read reports the running service, its socket, data folder and processes", async () => {
    await startDaemon(DRAIN_NOTHING);
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

  it("the status read reports degraded once the listener fails, and the log says why", async () => {
    const serviceLog: string[] = [];
    await startDaemon(DRAIN_NOTHING, {}, (options) =>
      DaemonProcess.start({
        ...options,
        writeServiceLog: (line) => {
          serviceLog.push(line);
        },
      }),
    );
    const { client, call } = await openSession();
    const listener = createdServers.find((server) => server.address() === runFolder.socketPath);

    listener?.emit("error", new Error("accept failed"));

    expect(await call("daemon.status.read")).toMatchObject({
      result: { processState: "degraded" },
    });
    expect(serviceLog).toContain("The socket's listener failed: accept failed");
    await client.close();
  });

  it("reads degraded when the search thread cannot open, says why, and fails each search", async () => {
    useSearchThreads(() => startSearchThread(path.join(scratch, "missing.db")));
    const serviceLog: string[] = [];
    await startDaemon(DRAIN_NOTHING, {}, (options) =>
      DaemonProcess.start({
        ...options,
        writeServiceLog: (line) => {
          serviceLog.push(line);
        },
      }),
    );
    const { client, call } = await openSession();

    expect(await call("session.search", { query: "retry" })).toMatchObject({
      error: { message: "unable to open database file" },
    });
    expect(await call("daemon.status.read")).toMatchObject({
      result: { processState: "degraded" },
    });
    expect(serviceLog).toContain("The search thread failed: unable to open database file");
    await client.close();
  });

  it("refuses daemon.start as unknown, since a cold start is a spawn", async () => {
    await startDaemon(DRAIN_NOTHING);
    const { client, call } = await openSession();

    expect(await call("daemon.start")).toMatchObject({
      error: { code: -32601, data: { type: "method_not_found" } },
    });
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

  it("answers a flush only once the write queued before it has committed", async () => {
    const writers: DatabaseWriter[] = [];
    const openWriter = DatabaseWriter.open.bind(DatabaseWriter);
    const spy = vi.spyOn(DatabaseWriter, "open").mockImplementation(async (options) => {
      const writer = await openWriter(options);
      writers.push(writer);
      return writer;
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    await startDaemon(DRAIN_NOTHING);
    const writer = writers[0]!;
    const { client, call } = await openSession();

    // Another connection holds the write lock, so the write the flush sends waits at the worker.
    const lockHolder = new Database(path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "daemon.db"));
    onTestFinished(() => {
      lockHolder.close();
    });
    lockHolder.exec("BEGIN IMMEDIATE");
    let isQueuedCommitted = false;
    const queued = writer
      .write([
        {
          sql: `INSERT INTO node_trust_state (node_id, owner_user_id, established_at, updated_at)
                VALUES ('node-1', 'user-1', @now, @now)`,
          bindings: { now: STARTED_AT },
        },
      ])
      .then(() => {
        isQueuedCommitted = true;
      });
    const flushed = call("daemon.flush").then((answer) => ({
      answer,
      isQueuedCommittedAtAnswer: isQueuedCommitted,
    }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    lockHolder.exec("ROLLBACK");

    expect(await flushed).toMatchObject({
      answer: { result: { flushed: true } },
      isQueuedCommittedAtAnswer: true,
    });
    await queued;
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
      await startDaemon(DRAIN_NOTHING);
    },
  );

  it("refuses every mutating verb on a connection whose handshake was incompatible", async () => {
    await startDaemon(DRAIN_NOTHING);
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
  const settingsPath = (): string =>
    path.join(homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);

  it("reads the defaults, and one client's change reaches the file and another's subscription", async () => {
    await startDaemon(DRAIN_NOTHING);
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

  it("a stop waits for a write under way and leaves it on disk", async () => {
    // The settings file is a named pipe, so a settings write waits on its read until the test
    // writes the file's contents into the pipe.
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    execFileSync("mkfifo", [settingsPath()]);
    const daemon = await startDaemon(DRAIN_NOTHING);
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
    const pipe = await vi.waitFor(() =>
      open(settingsPath(), fsConstants.O_WRONLY | fsConstants.O_NONBLOCK),
    );

    expect(await stopper.call("daemon.stop")).toMatchObject({ result: { accepted: true } });
    // The stop closes the socket before it drains, so the write finishes during the drain.
    await whenClosed(writer.client);
    await pipe.writeFile(JSON.stringify(MACHINE_SETTINGS_DEFAULTS));
    await pipe.close();

    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true });
    // The write's rename replaced the pipe with the file.
    expect((await lstat(settingsPath())).isFile()).toBe(true);
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
    const daemon = await startDaemon(DRAIN_NOTHING, {}, (options) =>
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
    const pipe = await vi.waitFor(() =>
      open(settingsPath(), fsConstants.O_WRONLY | fsConstants.O_NONBLOCK),
    );

    const askedAt = Date.now();
    expect(await stopper.call("daemon.stop")).toMatchObject({ result: { accepted: true } });
    expect(await daemon.whenStopped()).toStrictEqual({ isClean: true });

    expect(Date.now() - askedAt).toBeLessThan(DAEMON_STOP_DRAIN_BOUND_MS + 1_000);
    expect(logged).toContain("The stop's drain bound passed; writes still running: 1.");
    // The write still running finishes here, before the test's folders go, so it writes nowhere
    // after them: its read gets the file's contents and its rename replaces the pipe.
    await pipe.writeFile(JSON.stringify(MACHINE_SETTINGS_DEFAULTS));
    await pipe.close();
    await vi.waitFor(async () => {
      expect((await lstat(settingsPath())).isFile()).toBe(true);
    });
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
    await startDaemon(DRAIN_NOTHING);
    const { client, call } = await openSession();
    await call("daemon.machineSettingsSubscribe");
    await notifications(client, 1);

    await client.close();

    await vi.waitFor(() => {
      expect(detached).toHaveBeenCalledOnce();
    });
  });
});
