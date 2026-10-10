// What the daemon process's tests build on: a fresh home and run folder for each test, a start
// with the machine stood in, every daemon a test started stopped after it, a connection whose
// handshake has completed, and the search threads a test's daemons start.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, onTestFinished, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon/data";
import {
  resolveDaemonRunFolder,
  type DaemonRunFolder,
} from "@ai-sidekicks/contracts/daemon/run-folder";
import { JSONRPC_VERSION } from "@ai-sidekicks/contracts/jsonrpc/message";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import type { ProcessIdentity } from "@ai-sidekicks/contracts/process-identity";

import { connect, type Client } from "../../ipc/__fixtures__/local-socket-client.js";
import type { DrainResult, PtyHost } from "../../pty/host/contract.js";
import { openOrphanGuard } from "../../pty/orphan/guard.js";
import { DARWIN_PROVIDER_OPERATING_SYSTEM } from "../../provider/operating-system/darwin.js";
import { chooseDatabaseFileOperatingSystem } from "../../recovery/database-file/operating-system.js";
import { SearchThread, type SearchThreadOptions } from "../../session/search/thread/handle.js";
import { DaemonProcess, type DaemonProcessOptions } from "../process.js";
import { readProcessTreeUsage } from "../process-tree-usage.js";
import { selectTerminalOperatingSystem } from "../../pty/operating-system/selector.js";

/** A terminal drain that had nothing to end. */
export const EMPTY_DRAIN: DrainResult = {
  sessionsDrained: 0,
  sessionsForcedKilled: 0,
  sidecarExitedCleanly: true,
  taskkillEscalated: false,
};

/** The terminal host of a daemon whose stop has no terminals to drain. */
export const DRAIN_NOTHING: Pick<PtyHost, "shutdown"> = {
  shutdown: () => Promise.resolve(EMPTY_DRAIN),
};

// A terminal host that starts no shell, with `drain` as its stop's drain; its listeners are kept
// by no one, since no session runs in it.
function makeHostDrainingWith(drain: Pick<PtyHost, "shutdown">): PtyHost {
  const startsNoShell = (): Promise<never> =>
    Promise.reject(new Error("a test daemon's terminal host starts no shell"));
  return {
    spawn: startsNoShell,
    resize: startsNoShell,
    write: startsNoShell,
    pause: startsNoShell,
    resume: startsNoShell,
    kill: startsNoShell,
    close: startsNoShell,
    shutdown: (options) => drain.shutdown(options),
    setOnData: () => {},
    setOnExit: () => {},
  };
}

/** The clock every test daemon reads, so its start and its status reads all fall at this time. */
export const STARTED_AT = "2026-10-04T12:00:00.000Z";

/** The release version every test daemon reports. */
export const SERVICE_VERSION = "1.4.0";

/** The process every test daemon reports as its own. */
export const PROCESS_IDENTITY: ProcessIdentity = {
  processId: process.pid,
  bootId: "boot-1",
  processStartTime: "Sun Oct  4 12:00:00 2026",
};

/** The current test's own folder, made fresh before each test by {@link useDaemonFolders}. */
export let scratch: string;
/** The current test's home folder, inside {@link scratch}. */
export let homeDirectory: string;
/** The current test's run folder, inside {@link scratch}. */
export let runFolder: DaemonRunFolder;

/** The daemons the current test started and has not stopped itself; each is stopped after it. */
export const started: DaemonProcess[] = [];

/**
 * Makes a fresh home and run folder before each test of the calling file, and after it stops every
 * daemon the test started and removes its folders.
 */
export function useDaemonFolders(): void {
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
}

/**
 * Starts a daemon over the current test's folders, or the `place` given, with every machine
 * dependency stood in; `start` may change the options first. A started daemon is stopped after
 * the test.
 */
export async function startDaemon(
  ptyHost: Pick<PtyHost, "shutdown">,
  place: Partial<Pick<DaemonProcessOptions, "homeDirectory" | "runFolder">> = {},
  start: (options: DaemonProcessOptions) => Promise<DaemonProcess> = (options) =>
    DaemonProcess.start(options),
): Promise<DaemonProcess> {
  const options: DaemonProcessOptions = {
    homeDirectory: place.homeDirectory ?? homeDirectory,
    runFolder: place.runFolder ?? runFolder,
    openOrphanGuard: (dataFolder) =>
      openOrphanGuard({
        dataFolder,
        bootId: PROCESS_IDENTITY.bootId,
        readProcessIdentity: () => Promise.resolve(undefined),
        operatingSystem: {},
        writeServiceLog: () => {},
      }),
    createPtyHost: () => makeHostDrainingWith(ptyHost),
    databaseFileOperatingSystem: chooseDatabaseFileOperatingSystem(process.platform),
    readMachineName: () => Promise.resolve("Test machine"),
    captureProviderBaseEnvironment: () => Promise.resolve([]),
    commandShell: null,
    providerOperatingSystem: DARWIN_PROVIDER_OPERATING_SYSTEM,
    terminalOperatingSystem: selectTerminalOperatingSystem(process.platform, process.env),
    serviceVersion: SERVICE_VERSION,
    processIdentity: PROCESS_IDENTITY,
    readProcessTreeUsage: () => readProcessTreeUsage(process.pid),
    now: () => new Date(STARTED_AT),
    writeServiceLog: () => {},
    stopSignal: new AbortController().signal,
  };
  const daemon = await start(options);
  started.push(daemon);
  return daemon;
}

/** Whether a daemon answers a connection on `socketPath`. */
export function isSocketAnswering(socketPath: string): Promise<boolean> {
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

/** The current test's database log, which exists from the start until the database closes. */
export function writeAheadLogPath(): string {
  return path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "daemon.db-wal");
}

/**
 * A connection to the current test's daemon whose handshake has completed, offering
 * `helloProtocolVersion`; `call` sends one request and resolves with its reply.
 */
export async function openSession(
  helloProtocolVersion: string = CURRENT_PROTOCOL_VERSION,
): Promise<{
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
    // A subscription's notifications arrive between replies, so read on until this call's own.
    for (let replies = await client.replies(id); ; ) {
      const reply = replies.find((envelope) => (envelope as { id: unknown }).id === id);
      if (reply !== undefined) {
        return reply;
      }
      replies = await client.replies(replies.length + 1);
    }
  };
  await call("daemon.hello", {
    protocolVersion: helloProtocolVersion,
    sessionToken: await readFile(runFolder.tokenPath, "utf8"),
  });
  return { client, call };
}

/** Resolves once `client`'s socket has closed. */
export function whenClosed(client: Client): Promise<void> {
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

/**
 * Starts every search thread the current test's daemons start through `startThread`, and returns
 * them in the order they started.
 */
export function useSearchThreads(
  startThread: (options: SearchThreadOptions) => SearchThread,
): SearchThread[] {
  const threads: SearchThread[] = [];
  const spy = vi.spyOn(SearchThread, "start").mockImplementation((options) => {
    const thread = startThread(options);
    threads.push(thread);
    return thread;
  });
  onTestFinished(() => {
    spy.mockRestore();
  });
  return threads;
}

/** Starts a search thread as a daemon does, past any {@link useSearchThreads} in force. */
export const startSearchThread: (options: SearchThreadOptions) => SearchThread =
  SearchThread.start.bind(SearchThread);
